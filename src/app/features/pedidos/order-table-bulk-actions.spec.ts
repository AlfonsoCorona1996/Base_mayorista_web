import type { Order } from "../../core/orders.service";
import { canMarkOrderAsPaidFromTable } from "./order-table-bulk-actions";

describe("canMarkOrderAsPaidFromTable", () => {
  function makeOrder(overrides: Partial<Order> = {}): Order {
    return {
      order_id: "order-1",
      business_id: "bm",
      customer_id: "customer-1",
      route_id: null,
      status: "delivered",
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
      items: [
        {
          item_id: "item-1",
          title: "Producto",
          quantity: 1,
          source: "manual",
          state: "entregado",
          price_clienta: 100,
        },
      ],
      packages: [],
      timeline: [],
      packing: { status: "done", packages_count: 1 },
      dispatch_request: { status: "none", requested_at: null, requested_by: null, note: null },
      delivery_status: "delivered",
      customer_payment_status: "pending",
      collection_status: "pending",
      totals: {
        total_amount: 100,
        paid_amount: 0,
        balance_due: 100,
      },
      ...overrides,
    };
  }

  it("permite marcar como pagado un pedido entregado con saldo pendiente", () => {
    expect(canMarkOrderAsPaidFromTable(makeOrder())).toBeTrue();
  });

  it("permite liquidar un pedido con pago parcial", () => {
    const order = makeOrder({
      status: "pagado_parcial",
      customer_payment_status: "partial",
      totals: { total_amount: 100, paid_amount: 40, balance_due: 60 },
    });

    expect(canMarkOrderAsPaidFromTable(order)).toBeTrue();
  });

  it("mantiene habilitado el flujo existente para pedidos listos para ruta", () => {
    const order = makeOrder({
      status: "ready_for_route",
      delivery_status: "pending",
    });

    expect(canMarkOrderAsPaidFromTable(order)).toBeTrue();
  });

  it("mantiene el cierre de pedidos sin importe que ya estan listos para ruta", () => {
    const order = makeOrder({
      status: "ready_for_route",
      delivery_status: "pending",
      items: [],
      totals: { total_amount: 0, paid_amount: 0, balance_due: 0 },
    });

    expect(canMarkOrderAsPaidFromTable(order)).toBeTrue();
  });

  it("rechaza pedidos sin saldo o cuyo cobro ya fue registrado", () => {
    const withoutBalance = makeOrder({
      totals: { total_amount: 100, paid_amount: 100, balance_due: 0 },
    });
    const collected = makeOrder({ customer_payment_status: "collected" });
    const paidCollection = makeOrder({ collection_status: "paid" });

    expect(canMarkOrderAsPaidFromTable(withoutBalance)).toBeFalse();
    expect(canMarkOrderAsPaidFromTable(collected)).toBeFalse();
    expect(canMarkOrderAsPaidFromTable(paidCollection)).toBeFalse();
  });

  it("rechaza pedidos que todavia no llegan a una etapa cobrable", () => {
    const draft = makeOrder({
      status: "borrador",
      delivery_status: "pending",
    });

    expect(canMarkOrderAsPaidFromTable(draft)).toBeFalse();
  });
});
