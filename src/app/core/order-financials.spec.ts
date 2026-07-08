import { calculateOrderFinancials, calculateItemFinancials } from "./order-financials";

describe("order financials", () => {
  it("prorratea el descuento y recalcula una devolución parcial pagada", () => {
    const result = calculateOrderFinancials({
      items: [{ quantity: 3, confirmed_qty: 3, returned_qty: 1, returned_restockable_qty: 1, price_clienta: 100, price_public: 120, price_cost: 60 }],
      totals: { discount_amount: 30, paid_amount: 270 },
    });
    expect(result.netUnits).toBe(2);
    expect(result.returnsDiscount).toBe(10);
    expect(result.returnsAmount).toBe(90);
    expect(result.netAmount).toBe(180);
    expect(result.netCost).toBe(120);
    expect(result.grossProfit).toBe(60);
    expect(result.balanceDue).toBe(0);
    expect(result.overpaymentAmount).toBe(90);
  });

  it("acumula múltiples devoluciones sin permitir más que lo confirmado", () => {
    const row = calculateItemFinancials({ quantity: 3, confirmed_qty: 2, returned_qty: 9, price_clienta: 80, price_cost: 40 });
    expect(row.recognizedQty).toBe(2);
    expect(row.returnedQty).toBe(2);
    expect(row.netQty).toBe(0);
  });

  it("conserva el costo de una pieza dañada y permite una pérdida real", () => {
    const result = calculateOrderFinancials({
      items: [{ quantity: 1, confirmed_qty: 1, returned_qty: 1, returned_damaged_qty: 1, returned_restockable_qty: 0, price_clienta: 50, price_cost: 60 }],
      totals: { paid_amount: 50 },
    });
    expect(result.netAmount).toBe(0);
    expect(result.netCost).toBe(60);
    expect(result.grossProfit).toBe(-60);
    expect(result.overpaymentAmount).toBe(50);
  });

  it("redondea a centavos el descuento devuelto", () => {
    const result = calculateOrderFinancials({
      items: [{ quantity: 3, returned_qty: 1, price_clienta: 99.99 }],
      totals: { discount_amount: 10 },
    });
    expect(result.returnsDiscount).toBe(3.33);
    expect(result.netAmount).toBe(193.31);
  });

  it("trata un costo faltante como cero sin producir NaN", () => {
    const result = calculateOrderFinancials({ items: [{ quantity: 2, price_clienta: 100, price_cost: null }] });
    expect(result.netCost).toBe(0);
    expect(result.grossProfit).toBe(200);
  });
});
