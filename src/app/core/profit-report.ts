import { AuditMovement, AuditOrderRow, ProfitAudit, auditDate, auditTotals } from './profit-audit';

export interface ProfitReportPeriod { month: string; from: string; to: string }

/** Inclusive calendar dates. Payment timestamps never decide the sale's period. */
export function selectProfitReport(report: ProfitAudit, period: ProfitReportPeriod) {
  const error = period.month === 'custom'
    ? !/^\d{4}-\d{2}-\d{2}$/.test(period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(period.to) || !auditDate(period.from) || !auditDate(period.to)
      ? 'Selecciona una fecha inicial y una fecha final válidas.'
      : period.from > period.to ? 'La fecha inicial debe ser anterior o igual a la fecha final.' : null
    : null;
  const includes = (row: AuditOrderRow | AuditMovement) => !error && (period.month === 'all' ||
    (period.month === 'custom' ? !!row.date && row.date >= period.from && row.date <= period.to : row.month === period.month));
  const orders = report.orders.filter(includes);
  const movements = report.movements.filter(includes);
  const undatedOrders = report.orders.filter(r => !r.date && !includes(r));
  const undatedMovements = report.movements.filter(r => !r.date && !includes(r));
  const label = period.month === 'all' ? 'Todo el historial' : period.month === 'custom'
    ? `${period.from} al ${period.to}` : report.months.find(m => m.id === period.month)?.label || period.month;
  return { orders, movements, undatedOrders, undatedMovements, totals: auditTotals(orders, movements), label, error };
}

export type ProfitReportSelection = ReturnType<typeof selectProfitReport>;
