import { AuditOrder, auditDate, auditOrder, auditPartners, buildProfitAudit } from './profit-audit';

describe('Auditoría de utilidades por mes de creación', () => {
  const order = (overrides: Partial<AuditOrder> = {}): AuditOrder => ({
    order_id: '1', created_at: '2026-06-01T18:00:00Z', status: 'ready_for_route',
    items: [{ quantity: 2, price_clienta: 750, price_public: 1000, price_cost: 500 }],
    totals: { paid_amount: 750 }, ...overrides,
  });

  it('incluye pedidos en proceso y separa margen cobrado y pendiente', () => {
    const r = auditOrder(order());
    expect([r.sale, r.cost, r.profit]).toEqual([1500, 1000, 500]);
    expect([r.collected, r.pending, r.collectedProfit, r.pendingProfit]).toEqual([750, 750, 250, 250]);
  });

  it('imputa público / 2 solo cuando falta costo y conserva costo cero explícito', () => {
    const r = auditOrder(order({ items: [
      { quantity: 2, price_clienta: 750, price_public: 1000 },
      { quantity: 1, price_clienta: 100, price_public: 120, price_cost: 0 },
    ] }));
    expect(r.cost).toBe(1000);
    expect(r.profit).toBe(600);
    expect(r.estimatedItems).toBe(1);
    expect(r.items[1].costSource).toBe('registered');
  });

  it('conserva todos los pedidos, incluyendo vacíos y sin fecha, sin fabricar ganancia', () => {
    const r = buildProfitAudit([
      order(), order({ order_id: '2', created_at: null, items: [], totals: { total_amount: 1200, paid_amount: 300 } }),
      order({ order_id: '3', items: [{ quantity: 1, price_clienta: 500 }] }),
    ], [], []);
    expect(r.orders.length).toBe(3);
    expect(r.months.find(m => m.id === 'undated')?.sale).toBe(1200);
    expect(r.totals.sale).toBe(3200);
    expect(r.totals.profit).toBe(500);
    expect(r.incompleteOrders).toBe(2);
    expect(r.months.reduce((sum, m) => sum + m.orders.length, 0)).toBe(3);
  });

  it('no reubica un pedido por cobro posterior y usa fecha de México', () => {
    expect(auditDate('2026-06-01T05:59:00Z')).toBe('2026-05-31');
    expect(auditDate('2026-06-01')).toBe('2026-06-01');
    expect(auditDate('2026-02-31')).toBeNull();
    const r = auditOrder(order({ created_at: '2026-06-01T05:59:00Z', totals: { paid_amount: 1500 } }));
    expect(r.month).toBe('2026-05');
    expect(r.collectedProfit).toBe(500);
    expect(auditOrder(order({ audit_created_at: null })).month).toBe('undated');
  });

  it('incluye cantidades pendientes, pero no unidades canceladas ni sin existencia', () => {
    const r = auditOrder(order({ items: [
      { quantity: 2, confirmed_qty: 0, confirmation_state: 'pending', price_clienta: 100, price_cost: 50 },
      { quantity: 2, confirmation_state: 'out_of_stock', price_clienta: 100, price_cost: 50 },
      { quantity: 2, state: 'cancelado', price_clienta: 100, price_cost: 50 },
    ] }));
    expect(r.sale).toBe(200); expect(r.cost).toBe(100);
  });

  it('descuenta devoluciones, prorratea descuentos y conserva costo de daños', () => {
    const r = auditOrder(order({
      items: [{ quantity: 3, returned_qty: 2, returned_damaged_qty: 1, price_clienta: 100, price_cost: 50 }],
      totals: { discount_amount: 30, shipping_fee: 10, paid_amount: 25 },
    }));
    expect([r.sale, r.cost, r.profit]).toEqual([100, 100, 0]);
    expect(r.pending).toBe(75);
    expect(r.items[0].returned).toBe(2);
  });

  it('limita sobrepagos y mantiene cancelados visibles sin reconocer venta', () => {
    const paid = auditOrder(order({ totals: { paid_amount: 9000 } }));
    expect(paid.collected).toBe(1500); expect(paid.pending).toBe(0); expect(paid.collectedProfit).toBe(500);
    const canceled = auditOrder(order({ status: 'cancelado' }));
    expect(canceled.sale).toBe(0); expect(canceled.profit).toBe(0); expect(canceled.excluded).toBeTrue();
    expect(canceled.issues.length).toBeGreaterThan(0);
  });

  it('reparte lo generado menos gastos, sin volver a descontar cobranza ni retiros', () => {
    const r = buildProfitAudit([order({ items: [{ quantity: 1, price_clienta: 200000, price_cost: 90000 }], totals: { paid_amount: 100000 } })], [
      { expense_id: 'g', category: 'viaticos', amount: 10000, occurred_at: '2026-06-01' },
      { expense_id: 'i', category: 'compra_inversion', amount: 30000, occurred_at: '2026-06-01' },
    ], [{ withdrawal_id: 'w', purpose: 'socio_andrea_pepe', amount: 20000, occurred_at: '2026-07-01' }]);
    const partners = auditPartners(r.totals);
    expect(r.totals.netProfit).toBe(100000);
    expect(partners[1].share).toBe(50000);
    expect(partners[1].remaining).toBe(30000);
    expect(partners[1].pendingCollection).toBe(27500);
    expect(partners[0].remaining).toBe(50000);
    expect(r.months.find(m => m.id === '2026-07')?.andreaPepeWithdrawn).toBe(20000);
  });

  it('no asigna retiros por nombres en notas y señala gastos estimados', () => {
    const r = buildProfitAudit([order()], [{ expense_id: 'a', category: 'ajuste', amount: 100, occurred_at: '2026-06-01', notes: '15% por devolución' }], [
      { withdrawal_id: 'w', purpose: 'otro', notes: 'Pepe pagó gasolina', amount: 100, occurred_at: '' },
    ]);
    expect(r.totals.andreaPepeWithdrawn).toBe(0);
    expect(r.totals.unclassified).toBe(100);
    expect(r.totals.netProfit).toBe(400);
    expect(r.movements.every(m => m.issues.length > 0)).toBeTrue();
  });

  it('reconstruye la venta desde productos aunque el total histórico guardado sea cero', () => {
    const r = auditOrder(order({ totals: { total_amount: 0, paid_amount: 0 } }));
    expect(r.sale).toBe(1500);
    expect(r.recordedSale).toBe(0);
    expect(r.incomplete).toBeFalse();
    expect(r.issues).toContain('El total guardado difiere del cálculo por productos; se usa el detalle vigente');
  });

  it('conserva pérdidas y centavos en el reparto y las sumas mensuales', () => {
    const r = buildProfitAudit([order({ items: [{ quantity: 1, price_clienta: 10, price_cost: 11.01 }], totals: { paid_amount: 5 } })], [], []);
    const p = auditPartners(r.totals);
    expect(r.totals.profit).toBe(-1.01);
    expect(Math.round((p[0].share + p[1].share) * 100)).toBe(-101);
    expect(Math.round((r.totals.collectedProfit + r.totals.pendingProfit) * 100)).toBe(-101);
    expect(p[0].remaining).toBeLessThan(0);
  });
});
