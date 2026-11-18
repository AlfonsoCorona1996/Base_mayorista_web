import {
  deliveryInventoryOpen,
  normalizeDeliveryInventorySync,
  pendingDeliveryInventorySync,
} from "./delivery-inventory";
import { canCloseBySettlement } from "./order-closure";
import { damagedReturnWriteOff, returnedInventoryCost } from "./accounting-period";
import { calculateItemFinancials } from "./order-financials";

describe("delivery-inventory — ajuste pendiente de la entrega (FIX 03B-1.1)", () => {
  const now = "2026-11-10T12:00:00.000Z";

  it("normaliza solo estados válidos y conserva contadores", () => {
    expect(normalizeDeliveryInventorySync(null)).toBeNull();
    expect(normalizeDeliveryInventorySync({ status: "otro" })).toBeNull();
    const state = normalizeDeliveryInventorySync({ status: "failed", attempts: 3, last_error: " sin red ", scope: "packages" });
    expect(state?.status).toBe("failed");
    expect(state?.attempts).toBe(3);
    expect(state?.last_error).toBe("sin red");
    expect(state?.scope).toBe("packages");
  });

  it("pendiente y fallido bloquean; completo y resuelto no", () => {
    expect(deliveryInventoryOpen({ inventory_sync: { status: "pending" } })).toBeTrue();
    expect(deliveryInventoryOpen({ inventory_sync: { status: "failed" } })).toBeTrue();
    expect(deliveryInventoryOpen({ inventory_sync: { status: "synced" } })).toBeFalse();
    expect(deliveryInventoryOpen({ inventory_sync: { status: "resolved_manual" } })).toBeFalse();
    expect(deliveryInventoryOpen({})).withContext("entregas anteriores sin estado").toBeFalse();
  });

  it("una nueva entrega conserva intentos y la entrega completa engloba las cajas", () => {
    const previous = normalizeDeliveryInventorySync({ status: "failed", attempts: 2, scope: "packages", last_error: "x", last_error_code: "unavailable" });
    const next = pendingDeliveryInventorySync("close", now, previous);
    expect(next.status).toBe("pending");
    expect(next.attempts).toBe(2);
    expect(next.scope).toBe("close");
    expect(next.last_error_code).toBe("unavailable");
    expect(pendingDeliveryInventorySync("packages", now, next).scope).withContext("una caja no reduce el alcance").toBe("close");
  });

  it("el cierre por conciliación espera a que el inventario de la entrega esté confirmado", () => {
    const order = {
      delivered_at: now, delivery_status: "delivered",
      items: [{ item_id: "i1", quantity: 1, confirmed_qty: 1, price_clienta: 500, price_cost: 300 }],
      totals: { paid_amount: 500 },
    };
    expect(canCloseBySettlement(order, "collected")).toBeTrue();
    expect(canCloseBySettlement({ ...order, inventory_sync: { status: "failed" } }, "collected")).toBeFalse();
    expect(canCloseBySettlement({ ...order, inventory_sync: { status: "pending" } }, "collected")).toBeFalse();
    expect(canCloseBySettlement({ ...order, inventory_sync: { status: "resolved_manual" } }, "collected")).toBeTrue();
  });
});

describe("devolución sin inventario comprobado — sin capital ficticio (FIX 03B-1.1)", () => {
  it("no cuenta como costo devuelto a inventario ni como merma mientras está pendiente", () => {
    const row = { status: "inventory_unverified", disposition: "available", qty: 2, unit_cost: 150, returned_cost_amount: 0 };
    expect(returnedInventoryCost(row)).withContext("antes el respaldo qty × costo daba 300").toBe(0);
    expect(damagedReturnWriteOff(row)).toBe(0);
    expect(returnedInventoryCost({ ...row, status: "restocked", returned_cost_amount: 300 })).toBe(300);
  });

  it("la pieza sin comprobar no recupera costo en el pedido hasta el conteo", () => {
    const base = { item_id: "i1", quantity: 2, confirmed_qty: 2, price_clienta: 500, price_cost: 300, returned_qty: 1 };
    const pending = calculateItemFinancials({ ...base, returned_restockable_qty: 0, returned_unverified_qty: 1 } as never);
    expect(pending.returnedCost).toBe(0);
    const counted = calculateItemFinancials({ ...base, returned_restockable_qty: 1, returned_unverified_qty: 0 } as never);
    expect(counted.returnedCost).toBe(300);
  });
});
