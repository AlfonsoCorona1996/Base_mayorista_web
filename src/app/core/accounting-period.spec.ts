import {
  calculateAccountingPeriodOutcome,
  originalOrderFinancials,
} from "./accounting-period";

describe("cortes contables por fecha del hecho", () => {
  const returnedOrder = {
    items: [{
      quantity: 1,
      confirmed_qty: 1,
      returned_qty: 1,
      returned_restockable_qty: 1,
      price_clienta: 500,
      price_cost: 300,
    }],
    totals: { paid_amount: 500 },
  };

  it("no reescribe la venta original cuando la devolución sucede después", () => {
    const july = calculateAccountingPeriodOutcome({
      deliveredOrders: [returnedOrder],
      returns: [],
      operatingExpenses: 0,
    });
    const august = calculateAccountingPeriodOutcome({
      deliveredOrders: [],
      returns: [{
        net_return_amount: 500,
        returned_cost_amount: 300,
        unit_cost: 300,
        qty: 1,
        disposition: "available",
      }],
      operatingExpenses: 0,
    });

    expect(july.netSales).toBe(500);
    expect(july.netProfit).toBe(200);
    expect(august.netSales).toBe(-500);
    expect(august.netCost).toBe(-300);
    expect(august.netProfit).toBe(-200);
    expect(july.netProfit + august.netProfit).toBe(0);
  });

  it("hace visible el costo de una devolución dañada", () => {
    const result = calculateAccountingPeriodOutcome({
      deliveredOrders: [],
      returns: [{ net_return_amount: 500, unit_cost: 300, qty: 1, disposition: "damaged" }],
      operatingExpenses: 0,
    });

    expect(result.returnedInventoryCost).toBe(0);
    expect(result.damagedWriteOff).toBe(300);
    expect(result.netProfit).toBe(-500);
  });

  it("reconstruye importes previos a devoluciones desde el pedido vivo", () => {
    const original = originalOrderFinancials(returnedOrder);
    expect(original.netAmount).toBe(500);
    expect(original.grossCost).toBe(300);
  });
});
