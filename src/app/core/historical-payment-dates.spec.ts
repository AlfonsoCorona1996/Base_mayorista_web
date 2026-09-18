import { PAYMENT_DATE_MIGRATION, paymentDatePlan } from '../../../scripts/lib/historical-payment-dates';

describe('Normalización histórica de fechas de pago', () => {
  const row = (id: string, created_at: string, paid_amount: number, extra: Record<string, unknown> = {}) => ({ id, data: { business_id: 'bm', created_at, totals: { paid_amount }, ...extra } });
  it('solo selecciona mayo-agosto de México con importes cobrados y negocio explícito', () => {
    const p = paymentDatePlan([
      row('april', '2026-05-01T05:59:00Z', 100), row('may', '2026-05-01T06:00:00Z', 100),
      row('aug', '2026-09-01T05:59:00Z', 100), row('sep', '2026-09-01T06:00:00Z', 100),
      row('unpaid', '2026-06-02', 0), row('other', '2026-06-02', 100, { business_id: 'catalogo' }),
    ], []);
    expect(p.orders.map(r => r.id)).toEqual(['may', 'aug']); expect(p.skippedWithoutPayment).toBe(1);
  });
  it('es idempotente y conserva fecha previa para el respaldo', () => {
    const p = paymentDatePlan([
      row('done', '2026-06-02', 100, { payment_date_normalization: { version: PAYMENT_DATE_MIGRATION } }),
      row('fix', '2026-06-02', 100, { paid_at: '2026-08-12' }),
    ], []);
    expect(p.orders.length).toBe(1); expect(p.orders[0].original).toBe('2026-08-12'); expect(p.orders[0].day).toBe('2026-06-02');
  });
  it('normaliza la fecha canónica del evento sin inventar cobros rechazados o pendientes', () => {
    const events = ['confirmed', 'reported', 'rejected', 'difference'].map(status => ({ id: status, data: { business_id: 'bm', order_id: '1', verification_status: status, amount: 100, created_at: '2026-08-12' } }));
    const p = paymentDatePlan([row('1', '2026-06-02', 100)], events);
    expect(p.events.map(r => r.id)).toEqual(['confirmed']); expect(p.events[0].day).toBe('2026-06-02');
  });
});
