import { calculateOrderProfitProjection } from "./order-profit-projection";

describe("proyeccion de utilidad por pedido", () => {
  it("proyecta todo el margen de un borrador o pedido aun no entregado", () => {
    const result = calculateOrderProfitProjection({
      status: "borrador",
      items: [{ quantity: 1, price_clienta: 1_000, price_cost: 600 }],
      totals: { paid_amount: 0 },
    });

    expect(result.stage).toBe("in_process");
    expect(result.projectedProfit).toBe(400);
    expect(result.pendingBalance).toBe(0);
  });

  it("proyecta solo el margen proporcional que sigue por cobrar", () => {
    const result = calculateOrderProfitProjection({
      status: "pago_pendiente",
      items: [{ quantity: 1, price_clienta: 1_000, price_cost: 600 }],
      totals: { paid_amount: 400 },
    });

    expect(result.stage).toBe("pending_collection");
    expect(result.pendingBalance).toBe(600);
    expect(result.projectedProfit).toBe(240);
  });

  it("no vuelve a proyectar pedidos liquidados", () => {
    const result = calculateOrderProfitProjection({
      status: "entregado",
      items: [{ quantity: 1, price_clienta: 1_000, price_cost: 600 }],
      totals: { paid_amount: 1_000 },
    });

    expect(result).toEqual({ stage: "settled", projectedProfit: 0, pendingBalance: 0 });
  });

  it("excluye pedidos cancelados o devueltos", () => {
    for (const status of ["cancelado", "devuelto"]) {
      expect(calculateOrderProfitProjection({
        status,
        items: [{ quantity: 1, price_clienta: 1_000, price_cost: 600 }],
      })).toEqual({ stage: "excluded", projectedProfit: 0, pendingBalance: 0 });
    }
  });
});
