import {
  canCloseBySettlement,
  hasDeliveryEvidence,
  isAtOrAfterDelivery,
  isTrulyClosed,
  statusAfterCollection,
  statusAfterDelivery,
} from "./order-closure";
import { computeOrderStatus } from "./orders.service";
import type { OrderItem } from "./orders.service";

const item = (over: Partial<OrderItem> = {}): OrderItem => ({
  item_id: "i1", title: "Tenis", quantity: 1, source: "catalogo", state: "confirmando_proveedor",
  confirmation_state: "confirmed", confirmed_qty: 1, price_clienta: 500, price_cost: 300, ...over,
});
const paidOrder = (over: Record<string, unknown> = {}) => ({
  status: "closed", delivery_status: "delivered", delivered_at: "2026-09-10T12:00:00.000Z",
  items: [item()], totals: { paid_amount: 500 }, ...over,
});

describe("order-closure — entrega, cobro y cierre separados (RC-01/RC-02)", () => {
  it("un cobro no es evidencia de entrega", () => {
    expect(hasDeliveryEvidence({ status: "pagado" })).toBeFalse();
    expect(hasDeliveryEvidence({ status: "pagado", delivered_at: "2026-10-01" })).toBeTrue();
    expect(hasDeliveryEvidence({ status: "entregado" })).toBeTrue();
    expect(hasDeliveryEvidence({ status: "delivered" })).toBeTrue();
  });

  it("antes de entregar, el cobro conserva la etapa operativa", () => {
    expect(statusAfterCollection({ status: "borrador" }, "collected")).toBe("borrador");
    expect(statusAfterCollection({ status: "recibido_qa" }, "partial")).toBe("recibido_qa");
    expect(statusAfterCollection({ status: "ready_for_route" }, "collected")).toBe("ready_for_route");
  });

  it("después de entregar, el cobro sí se refleja en el estado", () => {
    expect(statusAfterCollection({ status: "entregado" }, "collected")).toBe("pagado");
    expect(statusAfterCollection({ status: "entregado" }, "partial")).toBe("pagado_parcial");
    expect(statusAfterCollection({ status: "pagado_parcial" }, "pending")).toBe("pago_pendiente");
    expect(statusAfterCollection({ status: "assigned_to_run", delivered_at: "2026-10-02" }, "collected")).toBe("pagado");
    expect(statusAfterCollection({ status: "closed" }, "collected")).toBe("closed");
    expect(isAtOrAfterDelivery({ status: "delivered" })).toBeTrue();
  });

  it("entregar conserva lo ya cobrado y usa el nombre canónico", () => {
    expect(statusAfterDelivery("collected")).toBe("pagado");
    expect(statusAfterDelivery("partial")).toBe("pagado_parcial");
    expect(statusAfterDelivery("pending")).toBe("entregado");
    expect(statusAfterDelivery(undefined)).toBe("entregado");
  });

  it("solo es cerrado un `closed` con entrega registrada y saldo cero", () => {
    expect(isTrulyClosed(paidOrder())).toBeTrue();
    expect(isTrulyClosed(paidOrder({ delivered_at: null }))).toBeFalse();
    expect(isTrulyClosed(paidOrder({ totals: { paid_amount: 200 } }))).toBeFalse();
    expect(isTrulyClosed(paidOrder({ status: "pagado" }))).toBeFalse();
    expect(isTrulyClosed(paidOrder({ status: "devuelto" }))).toBeFalse();
  });

  it("un pedido cerrado con devolución posterior sigue cerrado", () => {
    const returned = paidOrder({ items: [item({ returned_qty: 1 })] });
    expect(isTrulyClosed(returned)).toBeTrue();
  });

  it("la conciliación no cierra sin entrega real o con saldo", () => {
    expect(canCloseBySettlement(paidOrder({ status: "pagado" }), "collected")).toBeTrue();
    expect(canCloseBySettlement(paidOrder({ status: "pagado", delivered_at: null }), "collected")).toBeFalse();
    expect(canCloseBySettlement(paidOrder({ status: "pagado", delivery_status: "pending" }), "collected")).toBeFalse();
    expect(canCloseBySettlement(paidOrder({ status: "pagado", totals: { paid_amount: 100 } }), "partial")).toBeFalse();
  });
});

describe("computeOrderStatus — quitar o editar artículos no avanza la etapa (A1)", () => {
  it("un borrador con todo resuelto y sin operaciones sigue en borrador", () => {
    expect(computeOrderStatus({ status: "borrador" }, [item()], [])).toBe("borrador");
    expect(computeOrderStatus({ status: "borrador" }, [item(), item({ item_id: "i2", confirmation_state: "out_of_stock" })], [])).toBe("borrador");
  });

  it("Confirmar existencias sí promueve desde borrador", () => {
    expect(computeOrderStatus({ status: "borrador" }, [item()], [], { allowFromDraft: true })).toBe("recibido_qa");
    expect(computeOrderStatus({ status: "borrador" }, [item()], [{ status: "por_levantar" }], { allowFromDraft: true })).toBe("supplier_processing");
  });

  it("las transiciones posteriores a la confirmación siguen funcionando", () => {
    expect(computeOrderStatus({ status: "supplier_processing" }, [item()], [{ status: "recibido" }])).toBe("recibido_qa");
    expect(computeOrderStatus({ status: "supplier_processing" }, [item()], [{ status: "en_camino" }])).toBe("en_transito");
    expect(computeOrderStatus({ status: "pagado" }, [item()], [])).toBe("pagado");
  });
});
