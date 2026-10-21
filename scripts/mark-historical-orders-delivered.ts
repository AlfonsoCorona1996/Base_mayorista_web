/**
 * Marca como entregados los pedidos creados antes del corte (1-oct-2026, hora CDMX).
 * Por defecto es dry-run: solo escribe plan, respaldo y reporte en tmp/<runId>/.
 * --apply aplica la regularizacion solicitada por el usuario.
 *
 * Uso:
 *   npx tsx scripts/mark-historical-orders-delivered.ts --credentials <serviceAccount.json>
 *   npx tsx scripts/mark-historical-orders-delivered.ts --credentials <serviceAccount.json> --apply
 *
 * Pedidos con piezas de inventario o lineas de proveedor se omiten: entregarlos consume
 * inventario y libera reservas (OrdersService.markOrderDelivered), y eso debe pasar por la
 * app. El reporte los lista en `needs_app.json` para hacerlos desde ahi.
 */
import { cert, initializeApp, deleteApp, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, FieldValue, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { historicalDate } from '../src/app/core/historical-paid';

const DELIVERED_CUTOFF = '2026-10-01T06:00:00.000Z';
const EVENT_ID = 'historical-delivered-before-2026-10-01';
const ALREADY_DELIVERED_STATUSES = new Set(['delivered', 'entregado', 'delivered_partial', 'entregado_parcial', 'closed']);
const CANCELLED_STATUSES = new Set(['cancelado', 'cancelled', 'devuelto', 'returned']);
// Estados posteriores a la entrega en el ciclo: se conserva el estado y solo se marca la entrega.
const KEEP_STATUS = new Set(['pagado', 'pagado_parcial', 'pago_pendiente']);

type OrderData = Record<string, any>;
type Decision =
  | { skip: 'missing_creation_date' | 'on_or_after_cutoff' | 'cancelled_or_returned' | 'already_delivered' | 'empty_order' }
  | { needsApp: 'has_inventory_items' | 'has_supplier_operations' }
  | { patch: Record<string, unknown>; previousStatus: string; nextStatus: string };

function itemQty(item: Record<string, any>): number {
  return Math.max(0, Number(item['confirmed_qty'] ?? item['quantity'] ?? 0) - Number(item['returned_qty'] || 0));
}

function decide(order: OrderData, supplierOrderIds: Set<string>, orderId: string): Decision {
  const created = historicalDate(order['created_at']);
  if (!created) return { skip: 'missing_creation_date' };
  if (+created >= Date.parse(DELIVERED_CUTOFF)) return { skip: 'on_or_after_cutoff' };
  const status = String(order['status'] || '');
  if (CANCELLED_STATUSES.has(status)) return { skip: 'cancelled_or_returned' };
  if (ALREADY_DELIVERED_STATUSES.has(status) || order['delivery_status'] === 'delivered')
    return { skip: 'already_delivered' };
  const items: Record<string, any>[] = Array.isArray(order['items']) ? order['items'] : [];
  if (!items.length) return { skip: 'empty_order' };
  if (items.some((item) => String(item['inventory_id'] || '').trim() && itemQty(item) > 0))
    return { needsApp: 'has_inventory_items' };
  if (supplierOrderIds.has(orderId)) return { needsApp: 'has_supplier_operations' };

  const nextStatus = KEEP_STATUS.has(status) ? status : 'delivered';
  return {
    previousStatus: status,
    nextStatus,
    patch: {
      status: nextStatus,
      delivery_status: 'delivered',
      current_holder_location: 'customer',
      delivered_at: order['delivered_at'] || order['created_at'],
      delivered_at_quality: order['delivered_at'] ? (order['delivered_at_quality'] ?? null) : 'estimated',
    },
  };
}

async function main() {
  const credentialsIndex = process.argv.indexOf('--credentials');
  const credentialsPath =
    credentialsIndex >= 0 ? process.argv[credentialsIndex + 1] : process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (!credentialsPath) throw new Error('Indica --credentials <ruta> o GOOGLE_APPLICATION_CREDENTIALS.');
  const apply = process.argv.includes('--apply');
  const app = initializeApp({
    credential: cert(JSON.parse(readFileSync(credentialsPath, 'utf8')) as ServiceAccount),
  });
  try {
    const db = getFirestore(app);
    const [snapshot, supplierSnap] = await Promise.all([
      db.collection('orders').get(),
      db.collection('supplier_operations').select('order_id').get(),
    ]);
    const supplierOrderIds = new Set(
      supplierSnap.docs.map((doc) => String(doc.get('order_id') || '')).filter(Boolean),
    );
    const runId = `historical-delivered-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const directory = resolve('tmp', runId);
    mkdirSync(directory, { recursive: true });

    const records = snapshot.docs.map((doc) => ({ doc, decision: decide(doc.data(), supplierOrderIds, doc.id) }));
    const changes = records.filter(
      (row): row is { doc: QueryDocumentSnapshot; decision: Extract<Decision, { patch: unknown }> } => 'patch' in row.decision,
    );
    const needsApp = records.filter((row) => 'needsApp' in row.decision);
    const skipped: Record<string, number> = {};
    for (const row of records)
      if ('skip' in row.decision) skipped[row.decision.skip] = (skipped[row.decision.skip] || 0) + 1;
    const byPreviousStatus: Record<string, number> = {};
    for (const { decision } of changes)
      byPreviousStatus[decision.previousStatus || '(vacio)'] = (byPreviousStatus[decision.previousStatus || '(vacio)'] || 0) + 1;

    writeFileSync(
      resolve(directory, 'backup.json'),
      JSON.stringify(changes.map(({ doc }) => ({ id: doc.id, updateTime: doc.updateTime, data: doc.data() })), null, 2),
    );
    writeFileSync(
      resolve(directory, 'plan.json'),
      JSON.stringify(changes.map(({ doc, decision }) => ({ id: doc.id, customer: doc.get('customer_name') || null, decision })), null, 2),
    );
    writeFileSync(
      resolve(directory, 'needs_app.json'),
      JSON.stringify(
        needsApp.map(({ doc, decision }) => ({
          id: doc.id,
          customer: doc.get('customer_name') || null,
          status: doc.get('status') || null,
          reason: 'needsApp' in decision ? decision.needsApp : null,
        })),
        null,
        2,
      ),
    );
    const report = {
      runId,
      cutoff: DELIVERED_CUTOFF,
      timezone: 'America/Mexico_City',
      dateField: 'created_at',
      mode: apply ? 'apply' : 'dry-run',
      read: snapshot.size,
      candidates: changes.length,
      byPreviousStatus,
      needsApp: needsApp.length,
      skipped,
      applied: 0,
      verified: 0,
    };
    writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));

    if (apply) {
      for (let start = 0; start < changes.length; start += 40) {
        const batch = db.batch();
        const group = changes.slice(start, start + 40);
        for (const { doc, decision } of group) {
          const before = doc.data() || {};
          const nowIso = new Date().toISOString();
          const audit = {
            run_id: runId,
            cutoff: DELIVERED_CUTOFF,
            basis: 'created_at',
            requested_action: 'mark_delivered',
            historical: true,
            recorded_at: nowIso,
          };
          batch.update(
            doc.ref,
            {
              ...decision.patch,
              updated_at: FieldValue.serverTimestamp(),
              timeline: FieldValue.arrayUnion({ id: `t-${EVENT_ID}`, label: 'Pedido entregado', created_at: nowIso }),
              historical_delivery_regularization: audit,
            },
            { lastUpdateTime: doc.updateTime },
          );
          batch.create(doc.ref.collection('events').doc(EVENT_ID), {
            id: EVENT_ID,
            orderId: doc.id,
            actor: { uid: 'system', name: 'Regularización histórica solicitada' },
            createdAt: FieldValue.serverTimestamp(),
            type: 'HISTORICAL_DELIVERY_REGULARIZED',
            order_id: doc.id,
            business_id: before['business_id'] || 'bm',
            message: 'Pedido marcado entregado por regularización histórica solicitada por el usuario.',
            created_at: FieldValue.serverTimestamp(),
            source: 'user_requested_historical_regularization',
            meta: {
              ...audit,
              previous_status: before['status'] || null,
              previous_delivery_status: before['delivery_status'] || null,
              previous_holder_location: before['current_holder_location'] || null,
              previous_delivered_at: before['delivered_at'] || null,
            },
          });
        }
        await batch.commit();
        report.applied += group.length;
        writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
        console.log(`Entregados ${report.applied}/${changes.length}`);
      }
      for (let start = 0; start < changes.length; start += 100) {
        const docs = await db.getAll(...changes.slice(start, start + 100).map((row) => row.doc.ref));
        for (const doc of docs) {
          const result = decide(doc.data() || {}, supplierOrderIds, doc.id);
          if (!('skip' in result) || result.skip !== 'already_delivered')
            throw new Error(`Verificación fallida para ${doc.id}. Consulta el respaldo ${directory}.`);
          report.verified++;
        }
      }
      writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify({ ...report, backupDirectory: directory }, null, 2));
  } finally {
    await deleteApp(app);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falló la regularización');
  process.exitCode = 1;
});
