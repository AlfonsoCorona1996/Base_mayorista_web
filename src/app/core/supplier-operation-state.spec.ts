import {
  canAdvanceSupplierOperationStatus,
  isSupplierReceiptComplete,
  supplierOperationReservedForOrderId,
} from "./supplier-operation-state";

describe("supplier operation state", () => {
  it("uses order_id only for legacy rows without an explicit reservation link", () => {
    expect(supplierOperationReservedForOrderId({ order_id: "P-1" })).toBe("P-1");
  });

  it("keeps an explicitly detached operation detached", () => {
    expect(
      supplierOperationReservedForOrderId({
        order_id: "P-1",
        reserved_for_order_id: "",
      }),
    ).toBe("");
  });

  it("does not treat a partial receipt as complete", () => {
    expect(
      isSupplierReceiptComplete({
        order_id: "P-1",
        reserved_for_order_id: "P-1",
        order_item_id: "item-1",
        status: "recibido",
        quantity: 2,
        received_to_inventory: false,
        reservation_applied: false,
        received_qty: 0,
        reserved_qty_for_order: 0,
      }),
    ).toBeFalse();
  });

  it("requires both inbound inventory and the order reservation", () => {
    expect(
      isSupplierReceiptComplete({
        order_id: "P-1",
        reserved_for_order_id: "P-1",
        order_item_id: "item-1",
        status: "recibido",
        quantity: 2,
        received_to_inventory: true,
        reservation_applied: true,
        received_qty: 2,
        reserved_qty_for_order: 2,
      }),
    ).toBeTrue();
  });

  it("prevents supplier operation status regressions", () => {
    expect(canAdvanceSupplierOperationStatus("recibido", "en_camino")).toBeFalse();
    expect(canAdvanceSupplierOperationStatus("levantado", "en_camino")).toBeTrue();
  });
});
