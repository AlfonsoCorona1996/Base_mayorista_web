import { calculatePartnerWithdrawalSummary, calculateWithdrawalProfit, isDeliveredForProfit } from "./withdrawal-profit";

describe("withdrawal profit", () => {
  it("solo deja disponible el efectivo cobrado después del costo ya invertido", () => {
    const result = calculateWithdrawalProfit(
      [
        {
          status: "entregado",
          items: [{ quantity: 1, confirmed_qty: 1, price_clienta: 500, price_cost: 300 }],
          totals: { paid_amount: 200 },
        },
      ],
      25,
    );

    expect(result.collectedRevenue).toBe(200);
    expect(result.deliveredGrossCost).toBe(300);
    expect(result.collectedProfitBase).toBe(-125);
    expect(result.pendingCollection).toBe(300);
    expect(result.pendingProfit).toBe(120);
    expect(result.accruedNetProfit).toBe(175);
  });

  it("conserva como inversión el costo de una devolución que regresó al inventario", () => {
    const result = calculateWithdrawalProfit(
      [
        {
          status: "pagado",
          items: [
            {
              quantity: 1,
              confirmed_qty: 1,
              returned_qty: 1,
              returned_restockable_qty: 1,
              price_clienta: 502.5,
              price_cost: 335,
            },
          ],
          totals: { paid_amount: 0 },
        },
      ],
      0,
    );

    expect(result.collectedProfitBase).toBe(-335);
    expect(result.pendingCollection).toBe(0);
    expect(result.pendingProfit).toBe(0);
    expect(result.accruedNetProfit).toBe(0);
  });

  it("ignora pedidos que todavía no se entregan", () => {
    const result = calculateWithdrawalProfit(
      [
        {
          status: "in_transit",
          items: [{ quantity: 1, price_clienta: 500, price_cost: 300 }],
          totals: { paid_amount: 500 },
        },
      ],
      0,
    );

    expect(result.collectedRevenue).toBe(0);
    expect(result.collectedProfitBase).toBe(0);
    expect(isDeliveredForProfit({ status: "in_transit", delivered_at: "2026-08-18T12:00:00.000Z" })).toBeTrue();
  });

  it("descuenta del otro socio cualquier exceso retirado sobre la utilidad ya cobrada", () => {
    const result = calculatePartnerWithdrawalSummary(39_537.61, 0, 21_689.3, 8_773.3);

    expect(result.distributableBase).toBeCloseTo(30_764.31, 2);
    expect(result.perPartnerTarget).toBeCloseTo(15_382.155, 3);
    expect(result.excessAndreaPepe).toBeCloseTo(6_307.145, 3);
    expect(result.pendingBlanca).toBeCloseTo(9_075.01, 2);
    expect(result.pendingAndreaPepe).toBe(0);
  });
});
