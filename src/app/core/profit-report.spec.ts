import { buildProfitAudit } from './profit-audit';
import { selectProfitReport } from './profit-report';

describe('Selección del reporte para socios', () => {
  const report = buildProfitAudit([
    { order_id: 'inicio', created_at: '2026-06-01', paid_at: '2026-09-01', items: [{ quantity: 1, price_clienta: 100, price_cost: 40 }], totals: { paid_amount: 100 } },
    { order_id: 'fin', created_at: '2026-06-30', items: [{ quantity: 1, price_clienta: 200, price_cost: 100 }] },
    { order_id: 'fuera', created_at: '2026-07-01', items: [] },
    { order_id: 'sin-fecha', items: [], totals: { total_amount: 500 } },
  ], [{ expense_id: 'gasto', occurred_at: '2026-06-30', category: 'viaticos', amount: 10 }],
  [{ withdrawal_id: 'retiro', occurred_at: '2026-07-01', purpose: 'socio_andrea_pepe', amount: 20 }]);
  it('incluye ambos extremos por creación, conserva cobranza posterior y separa registros sin fecha', () => {
    const selection = selectProfitReport(report, { month: 'custom', from: '2026-06-01', to: '2026-06-30' });
    expect(selection.orders.map(r => r.id)).toEqual(['fin', 'inicio']);
    expect(selection.totals.sale).toBe(300);
    expect(selection.totals.collected).toBe(100);
    expect(selection.totals.netProfit).toBe(150);
    expect(selection.totals.andreaPepeWithdrawn).toBe(0);
    expect(selection.undatedOrders.map(r => r.id)).toEqual(['sin-fecha']);
    expect(selection.error).toBeNull();
    expect(selectProfitReport(report, { month: '2026-06', from: '', to: '' }).totals).toEqual(selection.totals);
  });
  it('no convierte rangos inválidos en todo el historial', () => {
    for (const [from, to] of [['', ''], ['2026-06-30', '2026-06-01'], ['2026-02-30', '2026-03-01']]) {
      const selection = selectProfitReport(report, { month: 'custom', from, to });
      expect(selection.error).toBeTruthy();
      expect(selection.orders.length).toBe(0);
      expect(selection.movements.length).toBe(0);
    }
  });
  it('conserva todos los pedidos incompletos y evita duplicar el anexo sin fecha en el historial', () => {
    const all = selectProfitReport(report, { month: 'all', from: '', to: '' });
    expect(all.orders.length).toBe(4);
    expect(all.totals.sale).toBe(800);
    expect(all.undatedOrders.length).toBe(0);
    const undated = selectProfitReport(report, { month: 'undated', from: '', to: '' });
    expect(undated.orders[0].incomplete).toBeTrue();
    expect(undated.totals.sale).toBe(500);
    expect(undated.undatedOrders.length).toBe(0);
  });
});
