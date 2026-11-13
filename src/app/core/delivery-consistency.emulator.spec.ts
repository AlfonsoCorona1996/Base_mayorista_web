import { EnvironmentInjector, runInInjectionContext } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";

import { DEFAULT_ROLE_PRESETS, RoleId } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { InventoryService } from "./inventory.service";
import { Order, OrdersService } from "./orders.service";
import { ReturnInventoryUnverifiedError, ReturnRecord, ReturnsService } from "./returns.service";
import { FeatureFlagsService } from "./feature-flags.service";
import { INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId } from "./inventory-allocations";
import { deliveryInventoryOpen, pendingDeliveryInventorySync } from "./delivery-inventory";
import { canCloseBySettlement } from "./order-closure";
import { returnedInventoryCost } from "./accounting-period";
import { calculateOrderFinancials } from "./order-financials";

/**
 * FIX 03B-1.1 — consistencia entrega ↔ inventario y devoluciones sin inventario comprobado,
 * con las reglas REALES (`firestore.rules`) en el emulador oficial e identidades por rol
 * (presets del sistema). Los datos se siembran con acceso "owner" del emulador.
 *
 * "Dos sesiones" = dos instancias independientes del servicio (cada una con su propia copia
 * del pedido, como dos pestañas o dos teléfonos) que escriben a la vez contra Firestore.
 *
 * NO corre en `npm test`. Ver tmp/fix-03b11/run-spec.cjs.
 */
const FIRESTORE_PORT = 8597;
const AUTH_PORT = 9697;
const REST = `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/base-mayorista/databases/(default)/documents`;
let emulatorsConnected = false;

function connectEmulatorsOnce(): void {
  if (emulatorsConnected) return;
  connectFirestoreEmulator(FIRESTORE, "127.0.0.1", FIRESTORE_PORT);
  connectAuthEmulator(FIREBASE_AUTH, `http://127.0.0.1:${AUTH_PORT}`, { disableWarnings: true });
  emulatorsConnected = true;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function toValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toValue(v)])) } };
}
function fromValue(v: Record<string, any>): Json {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v["booleanValue"];
  if ("integerValue" in v) return Number(v["integerValue"]);
  if ("doubleValue" in v) return v["doubleValue"];
  if ("stringValue" in v) return v["stringValue"];
  if ("timestampValue" in v) return v["timestampValue"];
  if ("arrayValue" in v) return (v["arrayValue"]["values"] || []).map(fromValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v["mapValue"]["fields"] || {}).map(([k, x]) => [k, fromValue(x as Record<string, any>)]));
  return null;
}
async function ownerSet(path: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${REST}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`ownerSet ${path}: ${res.status} ${await res.text()}`);
}
async function ownerGet(path: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/${path}`, { headers: { Authorization: "Bearer owner" } });
  if (res.status === 404) return null;
  const json = await res.json();
  return Object.fromEntries(Object.entries(json.fields || {}).map(([k, v]) => [k, fromValue(v as Record<string, any>)]));
}
async function ownerQuery(collectionId: string, filters: Record<string, string>, parent = ""): Promise<Record<string, any>[]> {
  const where = Object.entries(filters).map(([field, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } }));
  const res = await fetch(`${REST}${parent ? `/${parent}` : ""}:runQuery`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], ...(where.length ? { where: where.length === 1 ? where[0] : { compositeFilter: { op: "AND", filters: where } } } : {}) } }),
  });
  const rows = await res.json() as Array<{ document?: { fields: Record<string, any> } }>;
  return rows.filter((row) => row.document).map((row) => Object.fromEntries(Object.entries(row.document!.fields).map(([k, v]) => [k, fromValue(v)])));
}
async function signUp(email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Test1234!", returnSecureToken: true }),
  });
  return (await res.json()).localId as string;
}

const perf: Array<{ action: string; ms: number }> = [];
async function timed<T>(action: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await run(); } finally { perf.push({ action, ms: Math.round(performance.now() - started) }); }
}

describe("FIX 03B-1.1 — consistencia de entrega e inventario con reglas reales (emulador)", () => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const emails = new Map<RoleId, string>();
  let injector: EnvironmentInjector;
  let orders: OrdersService;
  let inventory: InventoryService;
  let returns: ReturnsService;
  let seq = 0;
  let previousTimeout = 0;

  beforeAll(async () => {
    previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 120000;
    connectEmulatorsOnce();
    for (const role of ["admin", "administrativo", "repartidor", "durango_operativo"] as RoleId[]) {
      const email = `consistency-${role}-${run}@example.com`;
      const uid = await signUp(email);
      const preset = DEFAULT_ROLE_PRESETS[role];
      await ownerSet(`users/${uid}`, {
        isActive: true, roleId: role, displayName: `Prueba ${role}`, sections: preset.sections, capabilities: preset.capabilities,
        businessMemberships: { bm: { businessId: "bm", enabled: true, roleId: role } },
      });
      emails.set(role, email);
    }
  });

  // TestBed destruye el inyector después de cada prueba: servicios nuevos por prueba.
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    injector = TestBed.inject(EnvironmentInjector);
    orders = TestBed.inject(OrdersService);
    inventory = TestBed.inject(InventoryService);
    returns = TestBed.inject(ReturnsService);
    TestBed.inject(FeatureFlagsService).set("returnsV2", true);
  });

  afterAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    await signOut(FIREBASE_AUTH).catch(() => undefined);
    console.log(`[FIX03B11-PERF] ${JSON.stringify(perf)}`);
  });

  async function as(role: RoleId): Promise<void> {
    if (FIREBASE_AUTH.currentUser) await signOut(FIREBASE_AUTH);
    await signInWithEmailAndPassword(FIREBASE_AUTH, emails.get(role)!, "Test1234!");
  }
  function next(prefix: string): string { seq += 1; return `${prefix}-${run}-${seq}`; }
  /** Otra "sesión": instancia propia del servicio, con su propia copia del pedido. */
  function newOrdersSession(): OrdersService { return runInInjectionContext(injector, () => new OrdersService()); }
  function newReturnsSession(): ReturnsService { return runInInjectionContext(injector, () => new ReturnsService()); }

  function item(id: string, overrides: Record<string, unknown> = {}) {
    return {
      item_id: id, title: `Artículo ${id}`, quantity: 1, confirmed_qty: 1, returned_qty: 0,
      price_clienta: 300, price_public: 300, price_cost: 100, state: "reservado_inventario", confirmation_state: "confirmed",
      ...overrides,
    };
  }
  async function seedInventory(id: string, onHand: number, reservations: Record<string, number> = {}): Promise<void> {
    const reserved = Object.values(reservations).reduce((a, b) => a + b, 0);
    await ownerSet(`inventory_items/${id}`, {
      inventory_id: id, business_id: "bm", title: `Producto ${id}`, sku: id,
      on_hand_qty: onHand, reserved_qty: reserved, available_qty: onHand - reserved, in_review_qty: 0, damaged_qty: 0, unit_price: 100,
      reservations: Object.fromEntries(Object.entries(reservations).map(([order, qty]) => [order, { qty, order_number: order, status: "reserved", updated_at: new Date().toISOString() }])),
      idempotency_keys: {}, image_urls: [], source_reason: "ajuste_manual",
    });
  }
  async function seedAllocation(orderId: string, itemId: string, invId: string, reserved: number): Promise<void> {
    const id = allocationDocId(orderId, itemId, invId);
    await ownerSet(`${INVENTORY_ALLOCATIONS_COLLECTION}/${id}`, {
      allocation_id: id, business_id: "bm", order_id: orderId, order_item_id: itemId, inventory_id: invId, source: "own_stock",
      supplier_id: null, supplier_operation_id: null, reserved_qty: reserved, delivered_qty: 0, returned_qty: 0,
      return_released_qty: 0, released_qty: 0, allocated_total_qty: reserved, last_movement_id: null,
    });
  }
  async function seedOrder(orderId: string, data: Record<string, unknown>): Promise<void> {
    await ownerSet(`orders/${orderId}`, {
      order_id: orderId, business_id: "bm", customer_id: `cust-${run}`, route_id: null, status: "ready_for_route",
      packages: [], timeline: [], totals: { total_amount: 600, paid_amount: 0, balance_due: 600 }, ...data,
    });
    await ownerSet(`customers/cust-${run}`, { customer_id: `cust-${run}`, business_id: "bm", name: "Clienta" });
  }
  /** Carga el pedido en la sesión indicada, como lo haría su listener. */
  async function loadInto(session: OrdersService, orderId: string): Promise<Order> {
    const snap = await getDoc(doc(FIRESTORE, "orders", orderId));
    const order = { ...(snap.data() as Record<string, unknown>), order_id: orderId, timeline: (snap.data() as Record<string, unknown>)["timeline"] || [] } as unknown as Order;
    session.add(order);
    return order;
  }
  async function inv(id: string) {
    const row = await ownerGet(`inventory_items/${id}`);
    return { onHand: Number(row?.["on_hand_qty"] || 0), reserved: Number(row?.["reserved_qty"] || 0), available: Number(row?.["available_qty"] || 0), reservations: (row?.["reservations"] || {}) as Record<string, { qty: number }> };
  }
  async function saleMovements(orderId: string, invId: string) {
    return (await ownerQuery("inventory_movements", { order_id: orderId, inventory_id: invId })).filter((row) => row["type"] === "sale");
  }
  async function events(orderId: string, type: string) {
    return (await ownerQuery("events", { orderId }, `orders/${orderId}`)).filter((row) => row["type"] === type);
  }

  /** Pedido con 1 línea propia (qty 2 apartadas) en un SKU que también aparta OTRO pedido (1). */
  async function reservedOrder(extra: Record<string, unknown> = {}, lineQty = 2) {
    const orderId = next("PC");
    const otherOrder = next("POTRO");
    const invId = next("inv");
    await seedInventory(invId, 5, { [orderId]: lineQty, [otherOrder]: 1 });
    await seedAllocation(orderId, "l-1", invId, lineQty);
    await seedAllocation(otherOrder, "o-1", invId, 1);
    await seedOrder(orderId, { items: [item("l-1", { source: "inventario", inventory_id: invId, quantity: lineQty, confirmed_qty: lineQty })], ...extra });
    return { orderId, otherOrder, invId };
  }

  // ------------------------------------------------------------------ 3.1
  it("3.1 fallo tras guardar la entrega: estado duradero, varios fallos, otro dispositivo, cierre bloqueado y reintento verificado", async () => {
    const { orderId, otherOrder, invId } = await reservedOrder({
      customer_payment_status: "collected", totals: { total_amount: 600, paid_amount: 600, balance_due: 0 },
    });
    await as("repartidor");
    await loadInto(orders, orderId);
    // Falla la red justo después de guardar la entrega (dos veces seguidas).
    const spy = spyOn(inventory, "consumeOnDelivery").and.callFake(() => Promise.reject(Object.assign(new Error("unavailable: sin conexión"), { code: "unavailable" })));
    const first = await timed("mark_delivered_fail", () => orders.markOrderDelivered(orderId, "Prueba 3.1"));
    expect(first.ok).toBeFalse();
    let saved = await ownerGet(`orders/${orderId}`);
    expect(saved?.["delivery_status"]).withContext("la entrega quedó guardada").toBe("delivered");
    expect(saved?.["inventory_sync"]?.["status"]).withContext("estado duradero en el pedido").toBe("failed");
    expect(saved?.["inventory_sync"]?.["attempts"]).toBe(1);
    await orders.retryDeliveryInventorySync(orderId);
    saved = await ownerGet(`orders/${orderId}`);
    expect(saved?.["inventory_sync"]?.["attempts"]).withContext("varios fallos consecutivos quedan contados").toBe(2);
    expect(saved?.["inventory_sync"]?.["last_error_code"]).toBe("unavailable");
    expect((await inv(invId)).onHand).withContext("inventario intacto mientras falla").toBe(5);

    // Muchos eventos después (antes el aviso dependía de los 20 más recientes).
    for (let i = 0; i < 25; i += 1) {
      await setDoc(doc(FIRESTORE, "orders", orderId, "events", `noise-${i}`), { id: `noise-${i}`, orderId, type: "NOTE", message: "ruido", createdAt: serverTimestamp() });
    }
    // "Al día siguiente, en otro teléfono": sesión nueva, solo lo guardado en Firestore.
    const otherDevice = newOrdersSession();
    const fresh = await loadInto(otherDevice, orderId);
    expect(deliveryInventoryOpen(fresh)).withContext("pendiente visible desde otro dispositivo").toBeTrue();

    // Cierre: aunque está cobrado y conciliado, no se cierra con el inventario sin confirmar.
    expect(canCloseBySettlement({ ...fresh, delivered_at: fresh.delivered_at || "x" }, "collected")).toBeFalse();
    await as("admin");
    const adminSession = newOrdersSession();
    await loadInto(adminSession, orderId);
    await adminSession.markSettlement(orderId, "reconciled", "Prueba cierre bloqueado");
    expect((await ownerGet(`orders/${orderId}`))?.["status"]).withContext("no se cierra con inventario pendiente").not.toBe("closed");

    // Otro empleado (Durango) reintenta: ajusta, comprueba y marca `synced`.
    spy.and.callThrough();
    await as("durango_operativo");
    const durango = newOrdersSession();
    await loadInto(durango, orderId);
    const retry = await timed("retry_delivery_inventory", () => durango.retryDeliveryInventorySync(orderId));
    expect(retry.ok).toBeTrue();
    expect(retry.verified).withContext("movimiento comprobado en el servidor").toBe(1);
    saved = await ownerGet(`orders/${orderId}`);
    expect(saved?.["inventory_sync"]?.["status"]).toBe("synced");
    expect(saved?.["inventory_sync"]?.["verified_keys"]).toBe(1);
    let state = await inv(invId);
    expect(state.onHand).toBe(3);
    expect(state.reservations[otherOrder]?.qty).withContext("reserva ajena intacta").toBe(1);
    // Otro reintento (y otra sesión) no vuelve a descontar.
    await as("repartidor");
    await loadInto(orders, orderId);
    await orders.retryDeliveryInventorySync(orderId);
    state = await inv(invId);
    expect(state.onHand).withContext("reintentos idempotentes").toBe(3);
    expect((await saleMovements(orderId, invId)).length).withContext("un solo movimiento de venta").toBe(1);

    // Ya confirmado: el cierre procede.
    await as("admin");
    await loadInto(adminSession, orderId);
    await adminSession.markSettlement(orderId, "reconciled", "Prueba cierre tras ajuste");
    expect((await ownerGet(`orders/${orderId}`))?.["status"]).toBe("closed");
  });

  it("3.1 pestaña cerrada antes del ajuste y verificación fallida: nunca se marca completo sin comprobar", async () => {
    const { orderId, invId } = await reservedOrder();
    await as("repartidor");
    // La sesión guardó la entrega (misma escritura que markOrderDelivered) y se cerró.
    await updateDoc(doc(FIRESTORE, "orders", orderId), {
      status: "entregado", delivery_status: "delivered", current_holder_location: "customer",
      delivered_at: serverTimestamp(), updated_at: serverTimestamp(),
      inventory_sync: pendingDeliveryInventorySync("close", new Date().toISOString()),
    });
    const later = newOrdersSession();
    const order = await loadInto(later, orderId);
    expect(deliveryInventoryOpen(order)).toBeTrue();
    expect(order.inventory_sync?.attempts).toBe(0);

    // El ajuste se aplica pero la comprobación no encuentra el movimiento: queda `failed`.
    const verify = spyOn(inventory, "verifyAppliedKeys").and.resolveTo({ verified: 0, missing: [`${invId}:x`], absent: [] });
    const unverified = await later.retryDeliveryInventorySync(orderId);
    expect(unverified.ok).toBeFalse();
    expect((await ownerGet(`orders/${orderId}`))?.["inventory_sync"]?.["status"]).withContext("sin comprobar no es completo").toBe("failed");
    verify.and.callThrough();
    const ok = await later.retryDeliveryInventorySync(orderId);
    expect(ok.ok).toBeTrue();
    expect((await ownerGet(`orders/${orderId}`))?.["inventory_sync"]?.["status"]).toBe("synced");
    expect((await inv(invId)).onHand).withContext("se descontó una sola vez").toBe(3);
    expect((await saleMovements(orderId, invId)).length).toBe(1);
  });

  it("3.1 resolución supervisada: solo administración, con nota y evento", async () => {
    const { orderId } = await reservedOrder();
    await as("repartidor");
    const session = newOrdersSession();
    await loadInto(session, orderId);
    spyOn(inventory, "consumeOnDelivery").and.rejectWith(new Error("unavailable"));
    await session.markOrderDelivered(orderId);
    await loadInto(session, orderId);
    await expectAsync(session.resolveDeliveryInventoryManually(orderId, "Conté y ya estaba ajustado")).withContext("repartidor no resuelve manualmente").toBeRejected();
    await as("admin");
    const admin = newOrdersSession();
    await loadInto(admin, orderId);
    await expectAsync(admin.resolveDeliveryInventoryManually(orderId, "ok")).withContext("nota obligatoria").toBeRejected();
    await admin.resolveDeliveryInventoryManually(orderId, "Conteo físico: el inventario ya se había ajustado a mano.");
    const saved = await ownerGet(`orders/${orderId}`);
    expect(saved?.["inventory_sync"]?.["status"]).toBe("resolved_manual");
    expect(saved?.["inventory_sync"]?.["resolved_by"]).toBeTruthy();
    expect((await events(orderId, "INVENTORY_DELIVERY_RESOLVED_MANUAL")).length).toBe(1);
  });

  // ------------------------------------------------------------------ 3.2
  it("3.2 dos sesiones entregan el mismo pedido a la vez: una sola salida, sin reescribir la entrega", async () => {
    const { orderId, otherOrder, invId } = await reservedOrder();
    await as("repartidor");
    const sessionA = newOrdersSession();
    const sessionB = newOrdersSession();
    await loadInto(sessionA, orderId);
    await loadInto(sessionB, orderId);
    const results = await timed("concurrent_mark_delivered", () => Promise.all([sessionA.markOrderDelivered(orderId, "A"), sessionB.markOrderDelivered(orderId, "B")]));
    expect(results.every((row) => row.ok)).withContext(JSON.stringify(results)).toBeTrue();
    expect(results.filter((row) => row.alreadyDelivered).length).withContext("el segundo intento recibe respuesta controlada").toBe(1);
    const state = await inv(invId);
    expect(state.onHand).withContext("una única salida física por pieza").toBe(3);
    expect(state.reserved).toBe(1);
    expect(state.reservations[otherOrder]?.qty).withContext("ninguna reserva ajena consumida").toBe(1);
    const sales = await saleMovements(orderId, invId);
    expect(sales.length).withContext("ningún movimiento duplicado").toBe(1);
    expect(sales.reduce((sum, row) => sum + Number(row["delta_on_hand"]), 0)).toBe(-2);
    const allocation = await ownerGet(`${INVENTORY_ALLOCATIONS_COLLECTION}/${allocationDocId(orderId, "l-1", invId)}`);
    expect(allocation?.["delivered_qty"]).withContext("un único consumo de reserva").toBe(2);
    expect(allocation?.["reserved_qty"]).toBe(0);
    const saved = await ownerGet(`orders/${orderId}`);
    expect(saved?.["inventory_sync"]?.["status"]).toBe("synced");
    expect((saved?.["timeline"] || []).filter((row: { label?: string }) => row.label === "Pedido entregado").length).withContext("historial sin duplicar").toBe(1);
    expect((await events(orderId, "ORDER_DELIVERED")).length).withContext("un solo evento de entrega").toBe(1);
    expect((await events(orderId, "INVENTORY_DELIVERY_SHORTFALL")).length).withContext("sin faltantes falsos").toBe(0);
  });

  it("3.2 entrega por caja y entrega completa simultáneas: total exacto, sin faltante falso", async () => {
    const orderId = next("PBOX");
    const otherOrder = next("POTRO");
    const invId = next("inv");
    await seedInventory(invId, 6, { [orderId]: 3, [otherOrder]: 2 });
    await seedAllocation(orderId, "b-1", invId, 3);
    await seedAllocation(otherOrder, "o-1", invId, 2);
    await seedOrder(orderId, {
      status: "en_ruta",
      items: [item("b-1", { source: "inventario", inventory_id: invId, quantity: 3, confirmed_qty: 3 })],
      packages: [
        { package_id: "box-1", label: "Caja 1", state: "cerrado", item_ids: ["b-1"], items: [{ orderItemId: "b-1", qty: 2 }] },
        { package_id: "box-2", label: "Caja 2", state: "cerrado", item_ids: ["b-1"], items: [{ orderItemId: "b-1", qty: 1 }] },
      ],
    });
    await as("admin"); // la entrega por caja escribe `packages` (rama de administración en las reglas)
    const boxSession = newOrdersSession();
    const fullSession = newOrdersSession();
    await loadInto(boxSession, orderId);
    await loadInto(fullSession, orderId);
    const [box, full] = await timed("concurrent_box_and_full", () => Promise.all([
      boxSession.deliverPackage(orderId, "box-1"),
      fullSession.markOrderDelivered(orderId, "completa"),
    ]));
    expect(box.ok && full.ok).withContext(JSON.stringify({ box, full })).toBeTrue();
    const state = await inv(invId);
    expect(state.onHand).withContext("caja + completa = 3 piezas, no 5").toBe(3);
    expect(state.reservations[otherOrder]?.qty).withContext("reserva ajena intacta").toBe(2);
    const sales = await saleMovements(orderId, invId);
    expect(sales.reduce((sum, row) => sum + Number(row["delta_on_hand"]), 0)).toBe(-3);
    expect((await events(orderId, "INVENTORY_DELIVERY_SHORTFALL")).length).withContext("sin faltante falso").toBe(0);
    // Entrega por caja seguida de completa (en serie) en otro pedido.
    const serial = next("PSER");
    const serialInv = next("inv");
    await seedInventory(serialInv, 3, { [serial]: 3 });
    await seedAllocation(serial, "s-1", serialInv, 3);
    await seedOrder(serial, {
      status: "en_ruta",
      items: [item("s-1", { source: "inventario", inventory_id: serialInv, quantity: 3, confirmed_qty: 3 })],
      packages: [{ package_id: "box-1", label: "Caja 1", state: "cerrado", item_ids: ["s-1"], items: [{ orderItemId: "s-1", qty: 2 }] }],
    });
    await loadInto(boxSession, serial);
    await boxSession.deliverPackage(serial, "box-1");
    await loadInto(boxSession, serial);
    const after = await boxSession.markOrderDelivered(serial);
    expect(after.shortfall).withContext("lo entregado por caja no es faltante").toBe(0);
    expect((await inv(serialInv)).onHand).toBe(0);
  });

  // ------------------------------------------------------------------ 4
  async function heldReturn(): Promise<{ orderId: string; record: ReturnRecord }> {
    const orderId = next("PUNV");
    await seedOrder(orderId, {
      status: "entregado", delivered_at: new Date().toISOString(), delivery_status: "delivered",
      totals: { total_amount: 300, paid_amount: 0, balance_due: 300 },
      // Título único: sin inventory_id, la resolución usa un documento `ret-…` derivado del título.
      items: [item("u-1", { title: `Artículo ${orderId}`, source: "catalogo", supplier_id: "sup", inventory_id: null, state: "entregado" })],
    });
    await as("administrativo");
    const snap = await getDoc(doc(FIRESTORE, "orders", orderId));
    const order = { ...(snap.data() as Record<string, unknown>), order_id: orderId, timeline: [] } as unknown as Order;
    await expectAsync(returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "available", attemptId: `u-${orderId}`, paymentResolution: "not_required", createdBy: "Prueba" }))
      .toBeRejectedWith(jasmine.any(ReturnInventoryUnverifiedError));
    const record = await timed("register_return_unverified", () => returns.registerReturn({
      order, item: order.items[0], qty: 1, disposition: "available", attemptId: `u-${orderId}`, paymentResolution: "not_required", createdBy: "Prueba", inventoryMode: "hold_unverified",
    }));
    return { orderId, record };
  }

  it("4. devolución sin inventario comprobado: sin existencias ni costo recuperado ficticio; resolución única", async () => {
    const { orderId, record } = await heldReturn();
    expect(record.status).toBe("inventory_unverified");
    expect(record.returned_cost_amount).withContext("no se reconoce costo recuperado").toBe(0);
    expect(record.pending_recovery_cost_amount).withContext("queda como recuperación pendiente").toBe(100);
    expect(returnedInventoryCost(record)).withContext("reportes: costo devuelto a inventario = 0").toBe(0);
    expect((await ownerQuery("inventory_movements", { order_id: orderId })).length).withContext("sin movimiento de inventario").toBe(0);
    let order = await ownerGet(`orders/${orderId}`);
    let line = order?.["items"][0];
    expect(line["returned_restockable_qty"]).withContext("la pieza no cuenta como reintegrable").toBe(0);
    expect(line["returned_unverified_qty"]).toBe(1);
    const financials = calculateOrderFinancials({ ...(order as Record<string, unknown>), items: order?.["items"] } as never);
    expect(financials.returnedCost).withContext("el costo del pedido no se recupera todavía").toBe(0);

    // Dos empleados resuelven a la vez con decisiones distintas: solo una se aplica.
    const sessionA = newReturnsSession();
    const sessionB = newReturnsSession();
    await Promise.allSettled([
      sessionA.resolveUnverifiedReturn(record, "restock_after_count", "Empleada A"),
      sessionB.resolveUnverifiedReturn(record, "not_found", "Empleada B"),
    ]);
    const saved = await ownerGet(`returns/${record.return_id}`);
    const counted = await ownerQuery("inventory_movements", { return_id: record.return_id });
    order = await ownerGet(`orders/${orderId}`);
    line = order?.["items"][0];
    expect(Number(line["returned_restockable_qty"]) + Number(line["returned_damaged_qty"] || 0) + Number(line["returned_unverified_qty"] || 0))
      .withContext("cada pieza devuelta en un solo estado").toBe(1);
    if (saved?.["status"] === "restocked") {
      expect(counted.length).withContext("una sola entrada auditable").toBe(1);
      expect(saved?.["returned_cost_amount"]).toBe(100);
      expect(saved?.["pending_recovery_cost_amount"]).toBe(0);
      expect(Number(saved?.["profit_impact"])).withContext("el costo deja de ser pérdida una sola vez").toBe(Number(record.profit_impact) - 100);
      const restocked = await ownerGet(`inventory_items/${counted[0]["inventory_id"]}`);
      expect(restocked?.["on_hand_qty"]).toBe(1);
    } else {
      expect(saved?.["status"]).toBe("damaged");
      expect(counted.length).withContext("no se encontró: sin inventario").toBe(0);
      expect(saved?.["returned_cost_amount"]).toBe(0);
    }
    // Un tercer intento no hace nada.
    await returns.resolveUnverifiedReturn(record, "restock_after_count", "Empleada C");
    expect((await ownerQuery("inventory_movements", { return_id: record.return_id })).length).toBe(counted.length);
  });

  it("4. «No se encontró» no genera inventario y pasa a merma; «Ingresar tras conteo» deja una sola entrada", async () => {
    const lost = await heldReturn();
    await returns.resolveUnverifiedReturn(lost.record, "not_found", "Prueba");
    const lostSaved = await ownerGet(`returns/${lost.record.return_id}`);
    expect(lostSaved?.["status"]).toBe("damaged");
    expect(lostSaved?.["inventory_resolution"]).toBe("not_found");
    expect(lostSaved?.["returned_cost_amount"]).toBe(0);
    expect(lostSaved?.["pending_recovery_cost_amount"]).toBe(0);
    expect((await ownerQuery("inventory_movements", { return_id: lost.record.return_id })).length).toBe(0);
    const lostLine = (await ownerGet(`orders/${lost.orderId}`))?.["items"][0];
    expect(lostLine["returned_unverified_qty"]).toBe(0);
    expect(lostLine["returned_damaged_qty"]).toBe(1);
    expect(lostLine["returned_restockable_qty"]).toBe(0);

    const found = await heldReturn();
    await returns.resolveUnverifiedReturn(found.record, "restock_after_count", "Prueba");
    await returns.resolveUnverifiedReturn(found.record, "restock_after_count", "Prueba");
    const entries = await ownerQuery("inventory_movements", { return_id: found.record.return_id });
    expect(entries.length).withContext("una sola entrada auditable").toBe(1);
    expect(entries[0]["type"]).toBe("adjustment");
    expect(entries[0]["reason"]).toContain("conteo");
    const foundLine = (await ownerGet(`orders/${found.orderId}`))?.["items"][0];
    expect(foundLine["returned_restockable_qty"]).toBe(1);
    expect(foundLine["returned_unverified_qty"]).toBe(0);
  });
});
