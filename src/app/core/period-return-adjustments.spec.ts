import { buildPeriodView, originalSaleOrder, PeriodReturnRecord, splitCollection } from './period-return-adjustments';
import { AuditOrder, buildProfitAudit } from './profit-audit';

/**
 * FIX 03A-2 — regresión financiera obligatoria (prompt FIX 03A §9 "Finanzas"):
 * venta en septiembre, septiembre cerrado, devolución en octubre con crédito, crédito
 * aplicado a una venta nueva pagada en parte con efectivo, recuperación y reventa.
 */
describe('period-return-adjustments (FIX 03A-2, RC-03..RC-06)', () => {
  const tenis = { order_item_id: 'tenis', title: 'Tenis', quantity: 1, price_clienta: 500, price_public: 650, price_cost: 300 };

  const septemberSale: AuditOrder = {
    order_id: 'P-SEP', status: 'closed', created_at: '2026-09-15T18:00:00.000Z',
    items: [tenis], totals: { paid_amount: 500, discount_amount: 0 },
  };
  const septemberSaleAfterReturn: AuditOrder = {
    ...septemberSale,
    items: [{ ...tenis, returned_qty: 1, returned_restockable_qty: 1 }],
  };
  const octoberReturn: PeriodReturnRecord = {
    return_id: 'ret_P-SEP_tenis_1', order_id: 'P-SEP', occurred_at: '2026-10-05', qty: 1,
    disposition: 'available', stage_at_return: 'closed',
    net_return_amount: 500, returned_cost_amount: 300, profit_impact: 200,
    payment_resolution: 'credit', resolution_amount: 500,
  };
  const octoberNewOrder: AuditOrder = {
    order_id: 'P-OCT', status: 'entregado', created_at: '2026-10-10T18:00:00.000Z',
    items: [{ order_item_id: 'blusa', title: 'Blusa', quantity: 1, price_clienta: 2000, price_public: 2600, price_cost: 1200 }],
    // 500 de crédito aplicado + 1 500 en efectivo.
    totals: { paid_amount: 2000, discount_amount: 0 },
  };
  const novemberResale: AuditOrder = {
    order_id: 'P-NOV', status: 'entregado', created_at: '2026-11-03T18:00:00.000Z',
    items: [{ ...tenis, order_item_id: 'tenis-reventa' }], totals: { paid_amount: 500, discount_amount: 0 },
  };

  const before = buildPeriodView([septemberSale], []);
  const after = buildPeriodView([septemberSaleAfterReturn, octoberNewOrder, novemberResale], [octoberReturn]);

  it('1-2. septiembre cerrado permanece intacto después de la devolución de octubre', () => {
    expect(before.months['2026-09']).toEqual(after.months['2026-09']);
    expect(after.months['2026-09']).toEqual(jasmine.objectContaining({ sales: 500, cost: 300, grossProfit: 200, returnsSale: 0, netGrossProfit: 200 }));
  });

  it('3. octubre reconoce el ajuste: venta −500, costo recuperado 300, utilidad −200', () => {
    expect(after.months['2026-10']).toEqual(jasmine.objectContaining({
      returnsSale: 500, recoveredCost: 300, returnsProfitAdjustment: -200,
    }));
  });

  it('4-5. la venta nueva no disminuye por pagarse con crédito y el crédito no es caja', () => {
    expect(after.months['2026-10']).toEqual(jasmine.objectContaining({
      sales: 2000, cost: 1200, grossProfit: 800, netSales: 1500, netGrossProfit: 600,
    }));
    expect(splitCollection({ paidAmount: 2000, creditApplied: 500 })).toEqual({ cash: 1500, credit: 500 });
  });

  it('6. la cobranza en efectivo nunca es negativa ni mayor que lo pagado', () => {
    expect(splitCollection({ paidAmount: 300, creditApplied: 500 })).toEqual({ cash: 0, credit: 300 });
    expect(splitCollection({ paidAmount: 0, creditApplied: 0 })).toEqual({ cash: 0, credit: 0 });
  });

  it('7-8. la reventa reconoce su propio costo: utilidad 200, no 500', () => {
    expect(after.months['2026-11']).toEqual(jasmine.objectContaining({ sales: 500, cost: 300, grossProfit: 200, netGrossProfit: 200 }));
  });

  it('no crea utilidad ficticia: el acumulado es una venta neta de tenis más la venta nueva', () => {
    const total = Object.values(after.months).reduce((sum, month) => sum + month.netGrossProfit, 0);
    expect(total).toBe(200 + 800 - 200 + 200);
  });

  it('no duplica una devolución registrada dos veces (reintento o doble clic)', () => {
    const duplicated = buildPeriodView([septemberSaleAfterReturn], [octoberReturn, { ...octoberReturn }]);
    expect(duplicated.months['2026-10'].returnsProfitAdjustment).toBe(-200);
    expect(duplicated.issues.some((issue) => issue.includes('repetida'))).toBeTrue();
  });

  it('una devolución dañada no recupera costo: el ajuste de utilidad es la venta completa', () => {
    const damaged: PeriodReturnRecord = { ...octoberReturn, disposition: 'damaged', returned_cost_amount: 0, profit_impact: 500 };
    const view = buildPeriodView([{ ...septemberSale, items: [{ ...tenis, returned_qty: 1, returned_damaged_qty: 1 }] }], [damaged]);
    expect(view.months['2026-09'].grossProfit).toBe(200);
    expect(view.months['2026-10']).toEqual(jasmine.objectContaining({ recoveredCost: 0, returnsProfitAdjustment: -500 }));
  });

  it('un pedido que el código anterior pasó a "devuelto" conserva su venta original en su mes', () => {
    const legacyReturned: AuditOrder = { ...septemberSaleAfterReturn, status: 'devuelto' };
    expect(originalSaleOrder(legacyReturned, [octoberReturn]).status).toBe('closed');
    expect(buildPeriodView([legacyReturned], [octoberReturn]).months['2026-09'].sales).toBe(500);
    // Sin devoluciones registradas que lo expliquen, "devuelto" sigue excluido.
    expect(buildPeriodView([legacyReturned], []).months['2026-09'].sales).toBe(0);
  });

  it('caso real María Zara (lectura de producción 09-nov): agosto conserva 898.50 / 300.50 y octubre ajusta', () => {
    const pair = (id: string) => ({ order_item_id: id, title: 'New Balance Modelo 9060', quantity: 1, price_clienta: 449.25, price_public: 599, price_cost: 299, returned_qty: 1, returned_restockable_qty: 1 });
    const order: AuditOrder = {
      order_id: 'P-260829-JNT4NK6450', status: 'devuelto', created_at: '2026-08-30T04:36:33.812Z',
      items: [pair('item-1788064643774'), pair('item-1788064675719')], totals: { paid_amount: 898.5, discount_amount: 0 },
    };
    const ret = (id: string): PeriodReturnRecord => ({
      return_id: `ret_${id}`, order_id: order.order_id, occurred_at: '2026-10-21', qty: 1, disposition: 'available', stage_at_return: 'pagado',
      net_return_amount: 449.25, returned_cost_amount: 299, profit_impact: 150.25, payment_resolution: 'refund', resolution_amount: 449.25,
    });
    const view = buildPeriodView([order], [ret('a'), ret('b')]);
    expect(view.months['2026-08']).toEqual(jasmine.objectContaining({ sales: 898.5, cost: 598, grossProfit: 300.5 }));
    expect(view.months['2026-10']).toEqual(jasmine.objectContaining({ returnsSale: 898.5, recoveredCost: 598, returnsProfitAdjustment: -300.5 }));
  });

  it('documenta el defecto vigente P0-03: el reporte actual reescribe septiembre y no muestra octubre', () => {
    // Si este caso falla porque el reporte ya conserva septiembre, D9 se implementó: actualizar la prueba.
    const current = buildProfitAudit([septemberSaleAfterReturn], [], []);
    const september = current.months.find((month) => month.id === '2026-09');
    expect(september?.profit).toBe(0);
    expect(current.months.find((month) => month.id === '2026-10')).toBeUndefined();
  });
});
