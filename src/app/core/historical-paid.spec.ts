import {
  historicalPaidDecision,
  HISTORICAL_PAID_CUTOFF,
  type HistoricalPaidOrder,
} from './historical-paid';

describe('Historical paid regularization', () => {
  const order: HistoricalPaidOrder = {
    created_at: '2026-09-30T23:59:59-06:00',
    status: 'entregado',
    items: [{ quantity: 2, price_clienta: 100, price_cost: 40 }],
    totals: { total_amount: 200, paid_amount: 50, balance_due: 150 },
  };
  it('uses the exclusive October 1 midnight cutoff in Mexico', () => {
    expect(HISTORICAL_PAID_CUTOFF).toBe('2026-10-01T06:00:00.000Z');
    expect(historicalPaidDecision(order).patch?.status).toBe('pagado');
    expect(historicalPaidDecision({ ...order, created_at: '2026-10-01T00:00:00-06:00' }).skip).toBe(
      'on_or_after_cutoff',
    );
  });
  it('preserves invoices, items and higher existing payments', () => {
    const result = historicalPaidDecision({
      ...order,
      totals: { total_amount: 300, paid_amount: 350 },
    });
    expect(result.patch?.['totals.paid_amount']).toBe(350);
    expect(result.patch?.['totals.balance_due']).toBe(0);
    expect(result.patch && 'items' in result.patch).toBeFalse();
    expect(result.patch && 'totals.total_amount' in result.patch).toBeFalse();
  });
  it('keeps unknown dates explicitly estimated and is idempotent', () => {
    const patch = historicalPaidDecision(order).patch!;
    expect(patch.paid_at).toBe(order.created_at);
    expect(patch.paid_at_quality).toBe('estimated');
    const after = {
      ...order,
      ...patch,
      totals: { ...order.totals, paid_amount: 200, balance_due: 0 },
    };
    expect(historicalPaidDecision(after).skip).toBe('already_paid');
  });
  it('does not change cancellations, full returns, empty orders or missing dates', () => {
    expect(historicalPaidDecision({ ...order, status: 'cancelado' }).skip).toBe(
      'cancelled_or_returned',
    );
    expect(historicalPaidDecision({ ...order, status: 'devuelto' }).skip).toBe(
      'cancelled_or_returned',
    );
    expect(historicalPaidDecision({ ...order, items: [] }).skip).toBe('empty_order');
    expect(historicalPaidDecision({ ...order, created_at: null }).skip).toBe(
      'missing_creation_date',
    );
  });
});
