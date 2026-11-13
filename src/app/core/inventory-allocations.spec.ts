import {
  allocationDocId,
  applyAllocationConsume,
  applyAllocationRelease,
  applyAllocationReserve,
  applyAllocationReturnRestock,
  emptyAllocation,
  InventoryAllocation,
  legacyEvidenceFromMovements,
  planReturnInventory,
  reservationCapForLine,
} from "./inventory-allocations";
import { planPackageDelivery } from "./delivery-inventory";

function allocation(overrides: Partial<InventoryAllocation> = {}): InventoryAllocation {
  return {
    ...emptyAllocation({ businessId: "bm", orderId: "P-1", orderItemId: "item-1", inventoryId: "inv-a" }),
    ...overrides,
  };
}

describe("inventory-allocations (FIX 03B-1)", () => {
  it("genera un id determinista y seguro para Firestore", () => {
    expect(allocationDocId("P-1", "item/1", "inv a")).toBe("alloc__P-1__item_1__inv_a");
    expect(allocationDocId("P-1", "item-1", "inv-a")).toBe(allocationDocId("P-1", "item-1", "inv-a"));
  });

  it("reserva, consume y devuelve sin superar lo apartado ni lo entregado", () => {
    let row = applyAllocationReserve(allocation(), 2, "m1");
    expect(row.reserved_qty).toBe(2);
    row = applyAllocationConsume(row, 5, "m2");
    expect(row.reserved_qty).toBe(0);
    expect(row.delivered_qty).toBe(2);
    row = applyAllocationReturnRestock(row, 5, "m3");
    expect(row.returned_qty).toBe(2);
    row = applyAllocationRelease(row, 1, "m4");
    expect(row.released_qty).toBe(0);
  });

  it("el tope por línea nunca usa reservas de otro pedido", () => {
    // Documento con 5 apartadas: 1 de este pedido, 4 de otros.
    expect(reservationCapForLine({ allocation: null, orderReservedQty: 1, docReservedQty: 5, docOnHandQty: 5 })).toBe(1);
    // Con asignación: lo que la línea tiene apartado.
    expect(reservationCapForLine({ allocation: allocation({ reserved_qty: 1 }), orderReservedQty: 3, docReservedQty: 5, docOnHandQty: 5 })).toBe(1);
    // Pedido sin reserva en el documento: 0 (antes consumía la de otro pedido).
    expect(reservationCapForLine({ allocation: null, orderReservedQty: 0, docReservedQty: 5, docOnHandQty: 5 })).toBe(0);
  });

  it("devolución tras entrega: reincorpora al mismo documento", () => {
    const plan = planReturnInventory({
      requestedQty: 1,
      hasDeliveryEvidence: true,
      candidates: [{ inventoryId: "inv-a", allocation: allocation({ delivered_qty: 2 }), orderReservedQty: 0, legacySoldQty: 0 }],
    });
    expect(plan).toEqual({
      status: "ok",
      legs: [{ inventoryId: "inv-a", kind: "restock_delivered", qty: 1, fromAllocation: true }],
      primaryInventoryId: "inv-a",
      usedLegacyEvidence: false,
    });
  });

  it("devolución antes de entregar: libera la reserva, no suma existencia", () => {
    const plan = planReturnInventory({
      requestedQty: 2,
      hasDeliveryEvidence: false,
      candidates: [{ inventoryId: "inv-a", allocation: allocation({ reserved_qty: 2 }), orderReservedQty: 2, legacySoldQty: 0 }],
    });
    expect(plan.status).toBe("ok");
    if (plan.status === "ok") expect(plan.legs).toEqual([{ inventoryId: "inv-a", kind: "release_reserved", qty: 2, fromAllocation: true }]);
  });

  it("no permite devolver más de lo entregado y apartado sin devolver", () => {
    const plan = planReturnInventory({
      requestedQty: 2,
      hasDeliveryEvidence: true,
      candidates: [{ inventoryId: "inv-a", allocation: allocation({ delivered_qty: 2, returned_qty: 1 }), orderReservedQty: 0, legacySoldQty: 0 }],
    });
    expect(plan.status).toBe("unverified");
    if (plan.status === "unverified") expect(plan.coverableQty).toBe(1);
  });

  it("pedido anterior con reserva viva (caso María Zara): libera, no duplica", () => {
    const plan = planReturnInventory({
      requestedQty: 1,
      hasDeliveryEvidence: false,
      candidates: [{ inventoryId: "inv-frodam", allocation: null, orderReservedQty: 1, legacySoldQty: 0 }],
    });
    expect(plan.status).toBe("ok");
    if (plan.status === "ok") {
      expect(plan.legs[0].kind).toBe("release_reserved");
      expect(plan.usedLegacyEvidence).toBeTrue();
    }
  });

  it("pedido anterior con venta probada en movimientos: regresa al mismo documento", () => {
    const evidence = legacyEvidenceFromMovements([
      { inventory_id: "inv-a", order_item_id: "item-1", type: "sale", delta_on_hand: -2 },
      { inventory_id: "inv-a", order_item_id: "item-1", type: "sale", delta_on_hand: 0 },
      { inventory_id: "ret-x", order_item_id: "item-1", type: "return", delta_on_hand: 1 },
      { inventory_id: "inv-a", order_item_id: "item-2", type: "sale", delta_on_hand: -5 },
    ], "item-1");
    expect(evidence.soldByInventory.get("inv-a")).toBe(2);
    expect(evidence.returnedQty).toBe(1);
    const plan = planReturnInventory({
      requestedQty: 1,
      hasDeliveryEvidence: true,
      candidates: [{ inventoryId: "inv-a", allocation: null, orderReservedQty: 0, legacySoldQty: 2 }],
      legacyReturnedQty: evidence.returnedQty,
    });
    expect(plan.status).toBe("ok");
    // La segunda pieza ya no tiene evidencia: una devolución previa la reincorporó en otro documento.
    const second = planReturnInventory({
      requestedQty: 2,
      hasDeliveryEvidence: true,
      candidates: [{ inventoryId: "inv-a", allocation: null, orderReservedQty: 0, legacySoldQty: 2 }],
      legacyReturnedQty: evidence.returnedQty,
    });
    expect(second.status).toBe("unverified");
  });

  it("pedido antiguo sin evidencia: no inventa asignación ni existencia", () => {
    const plan = planReturnInventory({
      requestedQty: 1,
      hasDeliveryEvidence: true,
      candidates: [{ inventoryId: "inv-a", allocation: null, orderReservedQty: 0, legacySoldQty: 0 }],
    });
    expect(plan.status).toBe("unverified");
  });
});

describe("planPackageDelivery (FIX 03B-1)", () => {
  const items = [
    { item_id: "a", quantity: 3, confirmed_qty: 3 },
    { item_id: "b", quantity: 2, confirmed_qty: 2, returned_qty: 1 },
  ];

  it("usa las cantidades registradas en la caja", () => {
    const plan = planPackageDelivery(
      [{ package_id: "p1", item_ids: ["a"], items: [{ orderItemId: "a", qty: 2 }] }],
      items,
      "p1",
    );
    expect(plan.ok).toBeTrue();
    if (plan.ok) expect(plan.qtyByItem.get("a")).toBe(2);
  });

  it("caja sin cantidades con artículo exclusivo: todo lo entregable de la línea", () => {
    const plan = planPackageDelivery([{ package_id: "p1", item_ids: ["b"], items: [] }], items, "p1");
    expect(plan.ok).toBeTrue();
    if (plan.ok) expect(plan.qtyByItem.get("b")).toBe(1);
  });

  it("bloquea si un artículo sin cantidades está repartido en varias cajas", () => {
    const plan = planPackageDelivery(
      [
        { package_id: "p1", item_ids: ["a"], items: [] },
        { package_id: "p2", item_ids: ["a"], items: [] },
      ],
      items,
      "p1",
    );
    expect(plan.ok).toBeFalse();
    if (!plan.ok) expect(plan.ambiguousItemIds).toEqual(["a"]);
  });
});
