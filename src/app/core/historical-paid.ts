import { calculateOrderFinancials, money, type FinancialOrderLike } from './order-financials';

export const HISTORICAL_PAID_CUTOFF = '2026-10-01T06:00:00.000Z';
export interface HistoricalPaidOrder extends FinancialOrderLike {
  status?: string;
  customer_payment_status?: string;
  collection_status?: string;
  paid_at?: unknown;
  paid_at_quality?: string | null;
  created_at?: unknown;
  totals?: FinancialOrderLike['totals'] & { total_amount?: number; balance_due?: number };
}

export function historicalDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(+value) ? value : null;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function')
    return historicalDate(value.toDate());
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = new Date(value);
  return Number.isFinite(+result) ? result : null;
}

/** Historical bookkeeping declaration; does not create a current cash receipt. */
export function historicalPaidDecision(order: HistoricalPaidOrder) {
  const created = historicalDate(order.created_at);
  if (!created) return { skip: 'missing_creation_date' as const };
  if (+created >= Date.parse(HISTORICAL_PAID_CUTOFF))
    return { skip: 'on_or_after_cutoff' as const };
  if (order.status === 'cancelado' || order.status === 'devuelto')
    return { skip: 'cancelled_or_returned' as const };
  if (!order.items?.length) return { skip: 'empty_order' as const };
  const financials = calculateOrderFinancials(order);
  const settledTotal = Math.max(financials.netAmount, money(order.totals?.total_amount));
  const paid = Math.max(financials.paidAmount, settledTotal);
  if (
    order.status === 'pagado' &&
    order.customer_payment_status === 'collected' &&
    order.collection_status === 'paid' &&
    money(order.totals?.balance_due) === 0 &&
    financials.paidAmount >= settledTotal
  )
    return { skip: 'already_paid' as const };
  return {
    patch: {
      status: 'pagado',
      customer_payment_status: 'collected',
      collection_status: 'paid',
      collection_reminder_at: null,
      'totals.paid_amount': paid,
      'totals.balance_due': 0,
      'totals.overpayment_amount': Math.max(0, money(paid - settledTotal)),
      paid_at: order.paid_at || order.created_at,
      paid_at_quality: order.paid_at ? (order.paid_at_quality ?? null) : 'estimated',
    },
    settledTotal,
    additionalPaid: money(paid - financials.paidAmount),
  };
}
