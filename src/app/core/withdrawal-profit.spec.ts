import { calculatePartnerWithdrawalSummary, calculateWithdrawalProfit, isDeliveredForProfit } from "./withdrawal-profit";

describe("withdrawal profit", () => {
  it("no descuenta de la utilidad el capital que sigue por cobrar", () => {
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

    expect(result.netSales).toBe(500);
    expect(result.collectedRevenue).toBe(200);
    expect(result.deliveredNetCost).toBe(300);
    expect(result.accruedNetProfit).toBe(175);
    expect(result.pendingCollection).toBe(300);
    expect(result.pendingProfit).toBe(120);
    expect(result.pendingPrincipal).toBe(180);
    // El modelo anterior daba -125 porque restaba el costo completo de lo
    // entregado contra el dinero cobrado. Los 180 de capital en la calle son
    // inversion por recuperar, no utilidad consumida.
    expect(result.collectedNetProfit).toBe(55);
  });

  it("suma exacta: la utilidad cobrada mas la pendiente es la utilidad generada", () => {
    const result = calculateWithdrawalProfit(
      [
        {
          status: "entregado",
          items: [{ quantity: 3, confirmed_qty: 3, price_clienta: 210, price_cost: 130 }],
          totals: { paid_amount: 155 },
        },
        {
          status: "pagado",
          items: [{ quantity: 2, confirmed_qty: 2, price_clienta: 90, price_cost: 61.5 }],
          totals: { paid_amount: 180 },
        },
      ],
      41.75,
    );

    expect(result.collectedNetProfit + result.pendingProfit).toBeCloseTo(result.accruedNetProfit, 2);
    expect(result.pendingPrincipal + result.pendingProfit).toBeCloseTo(result.pendingCollection, 2);
  });

  it("devuelve al inventario el costo de una devolucion en lugar de contarlo dos veces", () => {
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

    // La mercancia regreso completa: no hubo venta, no hubo costo consumido.
    expect(result.deliveredNetCost).toBe(0);
    expect(result.collectedNetProfit).toBe(0);
    expect(result.pendingCollection).toBe(0);
    expect(result.accruedNetProfit).toBe(0);
  });

  it("castiga el costo completo cuando la devolucion regresa danada", () => {
    const result = calculateWithdrawalProfit(
      [
        {
          status: "pagado",
          items: [
            {
              quantity: 1,
              confirmed_qty: 1,
              returned_qty: 1,
              returned_damaged_qty: 1,
              returned_restockable_qty: 0,
              price_clienta: 500,
              price_cost: 300,
            },
          ],
          totals: { paid_amount: 0 },
        },
      ],
      0,
    );

    expect(result.deliveredNetCost).toBe(300);
    expect(result.accruedNetProfit).toBe(-300);
  });

  it("ignora pedidos que todavia no se entregan", () => {
    const result = calculateWithdrawalProfit(
      [
        {
          status: "en_ruta",
          items: [{ quantity: 1, price_clienta: 500, price_cost: 300 }],
          totals: { paid_amount: 500 },
        },
      ],
      0,
    );

    expect(result.collectedRevenue).toBe(0);
    expect(result.accruedNetProfit).toBe(0);
    expect(isDeliveredForProfit({ status: "en_ruta", delivered_at: "2026-08-18T12:00:00.000Z" })).toBeTrue();
  });
});

describe("reparto entre socios", () => {
  it("mantiene el saldo de un socio aunque el otro haya retirado de mas", () => {
    const result = calculatePartnerWithdrawalSummary(10_000, 4_000, 0, 3_000);

    expect(result.blanca.collectedShare).toBe(2_000);
    // Antes el exceso de Andrea y Pepe borraba lo pendiente de Blanca.
    expect(result.blanca.availableNow).toBe(2_000);
    expect(result.blanca.pendingTotal).toBe(5_000);

    expect(result.andreaPepe.availableNow).toBe(-1_000);
    expect(result.andreaPepe.overdrawn).toBe(1_000);
    expect(result.andreaPepe.pendingTotal).toBe(2_000);
  });

  it("separa lo que se puede retirar hoy de lo que sigue por cobrar", () => {
    const result = calculatePartnerWithdrawalSummary(82_475.51, 65_576.11, 0, 21_689.3);

    expect(result.accruedBase).toBeCloseTo(82_475.51, 2);
    expect(result.collectedBase).toBeCloseTo(65_576.11, 2);
    expect(result.pendingBase).toBeCloseTo(16_899.4, 2);

    expect(result.blanca.share).toBeCloseTo(41_237.76, 1);
    expect(result.blanca.availableNow).toBeCloseTo(32_788.06, 1);
    expect(result.blanca.pendingShare).toBeCloseTo(8_449.7, 2);

    expect(result.andreaPepe.availableNow).toBeCloseTo(11_098.76, 1);
    expect(result.andreaPepe.pendingTotal).toBeCloseTo(19_548.46, 1);
    expect(result.andreaPepe.overdrawn).toBe(0);
  });

  it("descuenta de la base las salidas que no son gasto ni reparto", () => {
    const result = calculatePartnerWithdrawalSummary(10_000, 10_000, 0, 0, 2_000);

    expect(result.accruedBase).toBe(8_000);
    expect(result.blanca.share).toBe(4_000);
    expect(result.unclassifiedWithdrawals).toBe(2_000);
  });
});
