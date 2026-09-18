/** Explicitly authorized historical estimate. Dry-run by default, atomic and backed up on --apply. */
import { cert, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PAYMENT_DATE_MIGRATION, paymentDatePlan } from './lib/historical-payment-dates';

function encode(value: unknown): unknown {
  if (value instanceof Timestamp) return { __timestamp: { seconds: value.seconds, nanoseconds: value.nanoseconds } };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}

async function main() {
  const credentialIndex = process.argv.indexOf('--credentials');
  const credentialPath = credentialIndex >= 0 ? process.argv[credentialIndex + 1] : process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (!credentialPath) throw new Error('Usa --credentials <ruta> o GOOGLE_APPLICATION_CREDENTIALS.');
  initializeApp({ credential: cert(JSON.parse(readFileSync(credentialPath, 'utf8')) as ServiceAccount) });
  const db = getFirestore();
  const [orders, events, ledger, periods] = await Promise.all([
    db.collection('orders').where('business_id', '==', 'bm').get(),
    db.collection('order_collection_events').where('business_id', '==', 'bm').get(),
    db.collection('finance_ledger_entries').where('business_id', '==', 'bm').get(),
    db.collection('finance_periods').where('business_id', '==', 'bm').get(),
  ]);
  const plan = paymentDatePlan(orders.docs.map(d => ({ id: d.id, data: d.data() })), events.docs.map(d => ({ id: d.id, data: d.data() })));
  const affectedOrders = new Set([...plan.orders.map(r => r.id), ...plan.events.map(r => r.orderId)]);
  const eventIds = new Set(plan.events.map(r => r.id));
  const linkedLedger = ledger.docs.filter(d => affectedOrders.has(String(d.data()['order_id'])) || eventIds.has(String(d.data()['source_id'])));
  const closed = periods.docs.filter(d => d.data()['status'] === 'closed' && String(d.data()['month_id']) >= '2026-05' && String(d.data()['month_id']) <= '2026-08');
  if (linkedLedger.length || closed.length) throw new Error('Hay asientos contables o periodos cerrados vinculados. Se requiere conciliación explícita antes de modificar fechas. No se escribió nada.');
  const summary = {
    mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', version: PAYMENT_DATE_MIGRATION,
    business: 'bm', range: ['2026-05-01', '2026-08-31'], timezone: 'America/Mexico_City',
    orderUpdates: plan.orders.length, collectionDateUpdates: plan.events.length,
    unpaidOrdersPreserved: plan.skippedWithoutPayment,
    byCreationMonth: plan.orders.reduce<Record<string, number>>((sum, r) => { const m = r.day.slice(0, 7); sum[m] = (sum[m] || 0) + 1; return sum; }, {}),
    alreadyCollectedAmount: Number(plan.orders.reduce((sum, r) => sum + r.paid, 0).toFixed(2)),
  };
  console.log(JSON.stringify(summary, null, 2));
  const directory = resolve('backups', PAYMENT_DATE_MIGRATION);
  mkdirSync(directory, { recursive: true });
  if (!process.argv.includes('--apply')) {
    writeFileSync(resolve(directory, 'dry-run.json'), JSON.stringify(encode({ summary, plan }), null, 2));
    console.log('DRY-RUN: no se modificó Firebase.'); return;
  }
  if (!plan.orders.length && !plan.events.length) { console.log('Sin cambios pendientes: normalización ya aplicada.'); return; }
  if (plan.orders.length + plan.events.length > 450) throw new Error('El plan excede un lote atómico. No se escribió nada.');
  const orderDocs = new Map(orders.docs.map(d => [d.id, d]));
  const eventDocs = new Map(events.docs.map(d => [d.id, d]));
  const updates: { path: string; before: Record<string, unknown>; patch: Record<string, unknown>; updated: Timestamp }[] = [];
  for (const r of plan.orders) {
    const doc = orderDocs.get(r.id)!;
    updates.push({ path: doc.ref.path, before: doc.data(), updated: doc.updateTime, patch: {
      paid_at: r.date, paid_at_quality: 'estimated',
      payment_date_normalization: { version: PAYMENT_DATE_MIGRATION, basis: 'order_created_at',
        original_paid_at: r.original, original_field_present: 'paid_at' in doc.data(), normalized_at: FieldValue.serverTimestamp() },
    } });
  }
  for (const r of plan.events) {
    const doc = eventDocs.get(r.id)!;
    updates.push({ path: doc.ref.path, before: doc.data(), updated: doc.updateTime, patch: {
      cash_occurred_at: r.date, data_quality: 'estimated',
      payment_date_normalization: { version: PAYMENT_DATE_MIGRATION, basis: 'order_created_at',
        original_cash_occurred_at: r.original, original_field_present: 'cash_occurred_at' in doc.data(),
        original_created_at: doc.data()['created_at'] ?? null, normalized_at: FieldValue.serverTimestamp() },
    } });
  }
  const backup = resolve(directory, `before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backup, JSON.stringify(encode({ summary, documents: updates.map(r => ({ path: r.path, data: r.before, updateTime: r.updated })) }), null, 2), { flag: 'wx' });
  const batch = db.batch();
  for (const r of updates) batch.update(db.doc(r.path), r.patch, { lastUpdateTime: r.updated });
  await batch.commit();
  const after = await db.getAll(...updates.map(r => db.doc(r.path)));
  for (let i = 0; i < updates.length; i++) {
    const actual = after[i].data()!;
    const expected = updates[i];
    const protectedBefore = Object.fromEntries(Object.entries(expected.before).filter(([key]) => !(key in expected.patch)));
    const protectedAfter = Object.fromEntries(Object.entries(actual).filter(([key]) => !(key in expected.patch)));
    const stable = (value: unknown): string => JSON.stringify(encode(value), (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
    if (stable(protectedBefore) !== stable(protectedAfter)) throw new Error(`Cambió un campo protegido en ${expected.path}; revisar respaldo.`);
    const dateKey = expected.path.startsWith('orders/') ? 'paid_at' : 'cash_occurred_at';
    if (actual[dateKey] !== expected.patch[dateKey]) throw new Error(`Fecha no verificada en ${expected.path}`);
  }
  writeFileSync(resolve(directory, 'verification.json'), JSON.stringify({ ...summary, verifiedDocuments: after.length, backup, verifiedAt: new Date().toISOString(), protectedFieldsUnchanged: true }, null, 2));
  console.log(`Aplicados y verificados ${after.length} documentos. Importes, saldos, estados y demás campos intactos. Respaldo: ${backup}`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
