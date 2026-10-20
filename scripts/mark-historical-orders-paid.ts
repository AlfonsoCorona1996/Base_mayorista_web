/** Default is a dry-run. --apply performs the explicitly requested historical regularization. */
import { cert, initializeApp, deleteApp, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  historicalPaidDecision,
  HISTORICAL_PAID_CUTOFF,
  type HistoricalPaidOrder,
} from '../src/app/core/historical-paid';

async function main() {
  const credentialsIndex = process.argv.indexOf('--credentials');
  const credentialsPath =
    credentialsIndex >= 0
      ? process.argv[credentialsIndex + 1]
      : process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (!credentialsPath)
    throw new Error('Indica --credentials <ruta> o GOOGLE_APPLICATION_CREDENTIALS.');
  const apply = process.argv.includes('--apply');
  const app = initializeApp({
    credential: cert(JSON.parse(readFileSync(credentialsPath, 'utf8')) as ServiceAccount),
  });
  try {
    const db = getFirestore(app);
    const snapshot = await db.collection('orders').get();
    const runId = `historical-paid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const directory = resolve('tmp', runId);
    mkdirSync(directory, { recursive: true });
    const records = snapshot.docs.map((doc) => ({
      doc,
      decision: historicalPaidDecision(doc.data() as HistoricalPaidOrder),
    }));
    const changes = records.filter((row) => 'patch' in row.decision);
    const skipped: Record<string, number> = {};
    for (const row of records)
      if ('skip' in row.decision && row.decision.skip)
        skipped[row.decision.skip] = (skipped[row.decision.skip] || 0) + 1;
    // Keep full before images and update preconditions before issuing any write.
    writeFileSync(
      resolve(directory, 'backup.json'),
      JSON.stringify(
        changes.map(({ doc }) => ({ id: doc.id, updateTime: doc.updateTime, data: doc.data() })),
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(directory, 'plan.json'),
      JSON.stringify(
        changes.map(({ doc, decision }) => ({ id: doc.id, decision })),
        null,
        2,
      ),
    );
    const report = {
      runId,
      cutoff: HISTORICAL_PAID_CUTOFF,
      timezone: 'America/Mexico_City',
      dateField: 'created_at',
      mode: apply ? 'apply' : 'dry-run',
      read: snapshot.size,
      candidates: changes.length,
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
          if (!('patch' in decision) || !decision.patch) continue;
          const before = doc.data();
          const audit = {
            run_id: runId,
            cutoff: HISTORICAL_PAID_CUTOFF,
            basis: 'created_at',
            requested_action: 'mark_paid',
            historical: true,
            additional_paid: decision.additionalPaid,
            recorded_at: new Date().toISOString(),
          };
          batch.update(
            doc.ref,
            {
              ...decision.patch,
              updated_at: FieldValue.serverTimestamp(),
              historical_payment_regularization: audit,
            },
            { lastUpdateTime: doc.updateTime },
          );
          batch.create(doc.ref.collection('events').doc(`historical-paid-before-2026-10-01`), {
            id: 'historical-paid-before-2026-10-01',
            orderId: doc.id,
            actor: { uid: 'system', name: 'Regularización histórica solicitada' },
            createdAt: FieldValue.serverTimestamp(),
            type: 'HISTORICAL_PAYMENT_REGULARIZED',
            order_id: doc.id,
            business_id: before['business_id'] || 'bm',
            message:
              'Pedido marcado pagado por regularización histórica solicitada por el usuario.',
            created_at: FieldValue.serverTimestamp(),
            source: 'user_requested_historical_regularization',
            meta: {
              ...audit,
              previous_status: before['status'] || null,
              previous_customer_payment_status: before['customer_payment_status'] || null,
              previous_collection_status: before['collection_status'] || null,
              previous_totals: before['totals'] || null,
              previous_paid_at: before['paid_at'] || null,
            },
          });
        }
        await batch.commit();
        report.applied += group.length;
        writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
        console.log(`Regularizados ${report.applied}/${changes.length}`);
      }
      for (let start = 0; start < changes.length; start += 100) {
        const docs = await db.getAll(
          ...changes.slice(start, start + 100).map((row) => row.doc.ref),
        );
        for (const doc of docs) {
          const result = historicalPaidDecision(doc.data() as HistoricalPaidOrder);
          if (!('skip' in result) || result.skip !== 'already_paid')
            throw new Error(
              `Verificación fallida para ${doc.id}. Consulta el respaldo ${directory}.`,
            );
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
