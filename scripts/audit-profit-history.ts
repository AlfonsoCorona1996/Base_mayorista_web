/** Read-only audit. No writes to Firestore. Output stays under ignored tmp/. */
import { cert, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditExpense, AuditOrder, AuditWithdrawal, auditPartners, buildProfitAudit } from '../src/app/core/profit-audit';

async function main() {
  const arg = process.argv.indexOf('--credentials');
  const credentialPath = arg >= 0 ? process.argv[arg + 1] : process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (!credentialPath || !existsSync(credentialPath)) throw new Error('Usa --credentials <ruta> o GOOGLE_APPLICATION_CREDENTIALS.');
  const credentials = JSON.parse(readFileSync(credentialPath, 'utf8')) as ServiceAccount;
  initializeApp({ credential: cert(credentials) });
  const db = getFirestore();
  const [orders, expenses, withdrawals] = await Promise.all([
    db.collection('orders').get(), db.collection('finance_expenses').get(), db.collection('finance_withdrawals').get(),
  ]);
  const out = resolve('tmp/profit-audit');
  mkdirSync(out, { recursive: true });
  const businessIds = new Set([...orders.docs, ...expenses.docs, ...withdrawals.docs].map(d => String(d.data()['business_id'] || 'sin-negocio')));
  const currency = (value: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(value);
  const summary: string[] = ['# Auditoría de utilidad', '', `Leída: ${new Date().toISOString()}`, '', `Cobertura: ${orders.size} pedidos, ${expenses.size} gastos y ${withdrawals.size} retiros. Sin límite ni filtros de fecha/estado.`, ''];
  for (const business of businessIds) {
    const filter = (value: unknown) => String(value || 'sin-negocio') === business;
    const report = buildProfitAudit(
      orders.docs.filter(d => filter(d.data()['business_id'])).map(d => ({ ...d.data(), order_id: d.id }) as AuditOrder),
      expenses.docs.filter(d => filter(d.data()['business_id'])).map(d => ({ ...d.data(), expense_id: d.id }) as AuditExpense),
      withdrawals.docs.filter(d => filter(d.data()['business_id'])).map(d => ({ ...d.data(), withdrawal_id: d.id }) as AuditWithdrawal),
    );
    const safeBusiness = business.replace(/[^a-z0-9_-]/gi, '_');
    writeFileSync(resolve(out, `${safeBusiness}.json`), JSON.stringify(report, null, 2));
    summary.push(`## ${business}`, '', `Pedidos: ${report.orders.length}. Incompletos: ${report.incompleteOrders}. Productos con costo estimado: ${report.estimatedItems}.`, '',
      '| Mes | Pedidos | Venta | Cobrada | Pendiente | Utilidad | Utilidad cobrada | Utilidad pendiente | Gastos | Utilidad neta |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const m of report.months) summary.push(`| ${m.label} | ${m.orders.length} | ${currency(m.sale)} | ${currency(m.collected)} | ${currency(m.pending)} | ${currency(m.profit)} | ${currency(m.collectedProfit)} | ${currency(m.pendingProfit)} | ${currency(m.expenses)} | ${currency(m.netProfit)} |`);
    const t = report.totals;
    summary.push(`| **Total** | **${report.orders.length}** | **${currency(t.sale)}** | **${currency(t.collected)}** | **${currency(t.pending)}** | **${currency(t.profit)}** | **${currency(t.collectedProfit)}** | **${currency(t.pendingProfit)}** | **${currency(t.expenses)}** | **${currency(t.netProfit)}** |`);
    summary.push('', '### Socios', '', '| Socio | Ganado | Retirado | Falta por retirar | Ganancia por cobrar |', '| --- | ---: | ---: | ---: | ---: |');
    for (const p of auditPartners(report.totals)) summary.push(`| ${p.name} | ${currency(p.share)} | ${currency(p.withdrawn)} | ${currency(p.remaining)} | ${currency(p.pendingCollection)} |`);
    summary.push('', 'Importes provisionales según lo registrado. Retiros cero significa que no hay retiros registrados para ese socio. La ganancia pendiente de cobro se informa aparte y no se resta otra vez del saldo por retirar.');
    summary.push('', '### Datos por revisar', '');
    for (const r of [...report.orders, ...report.movements].filter(r => r.issues.length)) summary.push(`- ${r.id}: ${r.issues.join('; ')}.`);
    summary.push('');
    console.log(JSON.stringify({ business, orders: report.orders.length, totals: report.totals, incomplete: report.incompleteOrders }));
  }
  writeFileSync(resolve(out, 'report.md'), summary.join('\n'));
  console.log('Reporte guardado en tmp/profit-audit/report.md. No se modificó Firestore.');
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Audit failed'); process.exitCode = 1; });
