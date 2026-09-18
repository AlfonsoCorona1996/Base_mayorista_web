import { auditDate } from '../../src/app/core/profit-audit';

export const PAYMENT_DATE_MIGRATION = 'payment-dates-created-at-2026-may-aug-v1';
export interface HistoricalDocument { id: string; data: Record<string, unknown>; }
export interface HistoricalPaymentPlan {
  orders: { id: string; date: string; day: string; paid: number; original: unknown }[];
  events: { id: string; orderId: string; date: string; day: string; original: unknown }[];
  skippedWithoutPayment: number;
}

export function paymentDatePlan(orders: HistoricalDocument[], events: HistoricalDocument[]): HistoricalPaymentPlan {
  const planned: HistoricalPaymentPlan = { orders: [], events: [], skippedWithoutPayment: 0 };
  const eligible = new Map<string, { date: string; day: string }>();
  for (const row of orders) {
    // Explicit business scope: no legacy cross-business inference in a write migration.
    if (row.data['business_id'] !== 'bm') continue;
    const day = auditDate(row.data['created_at']);
    if (!day || day < '2026-05-01' || day > '2026-08-31') continue;
    const totals = row.data['totals'] as Record<string, unknown> | undefined;
    const paid = Number(totals?.['paid_amount']);
    if (!Number.isFinite(paid) || paid <= 0) { planned.skippedWithoutPayment++; continue; }
    const rawDate = row.data['created_at'];
    const date = typeof rawDate === 'object' && rawDate && 'toDate' in rawDate && typeof rawDate.toDate === 'function'
      ? (rawDate.toDate() as Date).toISOString()
      : new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(rawDate)) ? `${rawDate}T12:00:00Z` : String(rawDate)).toISOString();
    eligible.set(row.id, { date, day });
    const prior = row.data['payment_date_normalization'] as Record<string, unknown> | undefined;
    if (prior?.['version'] === PAYMENT_DATE_MIGRATION) continue;
    planned.orders.push({ id: row.id, date, day, paid, original: row.data['paid_at'] ?? null });
  }
  for (const row of events) {
    if (row.data['business_id'] !== 'bm') continue;
    const orderId = String(row.data['order_id'] || '');
    const target = eligible.get(orderId);
    if (!target) continue;
    const status = row.data['verification_status'];
    if (status && status !== 'confirmed') continue;
    if (!Number.isFinite(Number(row.data['amount'])) || Number(row.data['amount']) <= 0) continue;
    const prior = row.data['payment_date_normalization'] as Record<string, unknown> | undefined;
    if (prior?.['version'] === PAYMENT_DATE_MIGRATION) continue;
    planned.events.push({ id: row.id, orderId, date: target.date, day: target.day, original: row.data['cash_occurred_at'] ?? null });
  }
  return planned;
}
