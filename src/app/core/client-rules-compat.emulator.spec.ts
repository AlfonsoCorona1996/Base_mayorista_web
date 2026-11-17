import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, query, where } from "firebase/firestore";

import { DEFAULT_ROLE_PRESETS, RoleId } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { InventoryService } from "./inventory.service";
import { Order, OrdersService } from "./orders.service";
import { SupplierOperationsService } from "./supplier-operations.service";
import { ReturnsService } from "./returns.service";
import { FeatureFlagsService } from "./feature-flags.service";

/**
 * Compatibilidad cliente ↔ reglas (emulador, reglas REALES).
 *
 * Ejecuta las operaciones diarias del cliente (reservar, liberar, recibir, entregar, cobrar,
 * devolver…) con cada rol y anota el resultado y el estado final de los documentos. El mismo
 * spec se corre con dos juegos de reglas y las matrices se comparan
 * (`node scripts/emulator/matrix.cjs --diff a.log b.log`):
 *
 *   - cliente PUBLICADO × reglas publicadas   → línea base
 *   - cliente PUBLICADO × reglas propuestas   → ninguna celda debe empeorar antes de publicar reglas
 *   - cliente NUEVO     × reglas propuestas   → lo que se va a publicar
 *
 * Solo usa la parte de la API de los servicios que existe desde v2.3.0, para compilar igual en
 * el árbol publicado y en el nuevo. Los datos se siembran con la forma ANTERIOR (sin
 * `inventory_allocations` ni `inventory_sync`): también comprueba la lectura de documentos
 * que no tienen los campos nuevos.
 *
 * NO corre en `npm test`. Ver scripts/emulator/README.md.
 */
const FIRESTORE_PORT = 8597;
const AUTH_PORT = 9697;
const PROJECT = "base-mayorista";
const REST = `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;
let emulatorsConnected = false;

function connectEmulatorsOnce(): void {
  if (emulatorsConnected) return;
  connectFirestoreEmulator(FIRESTORE, "127.0.0.1", FIRESTORE_PORT);
  connectAuthEmulator(FIREBASE_AUTH, `http://127.0.0.1:${AUTH_PORT}`, { disableWarnings: true });
  emulatorsConnected = true;
}

// ------------------------------------------------------------------ acceso owner (siembra y lectura de estado)
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

// ------------------------------------------------------------------ identidades
type IdentityKey =
  | "super_admin" | "admin" | "administrativo" | "operativo" | "repartidor" | "durango_operativo"
  | "sin_permisos_inventario" | "otro_negocio" | "inactivo" | "anonimo";

async function signUp(email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Test1234!", returnSecureToken: true }),
  });
  const json = await res.json();
  if (!json.localId) throw new Error(`signUp ${email}: ${JSON.stringify(json)}`);
  return json.localId as string;
}

function userDocFor(key: IdentityKey): Record<string, unknown> {
  const roleFor: Record<Exclude<IdentityKey, "anonimo">, RoleId> = {
    super_admin: "super_admin", admin: "admin", administrativo: "administrativo", operativo: "operativo",
    repartidor: "repartidor", durango_operativo: "durango_operativo",
    sin_permisos_inventario: "repartidor", otro_negocio: "operativo", inactivo: "operativo",
  };
  const roleId = roleFor[key as Exclude<IdentityKey, "anonimo">];
  const preset = DEFAULT_ROLE_PRESETS[roleId];
  let sections: Record<string, boolean> = { ...preset.sections } as Record<string, boolean>;
  let capabilities: Record<string, boolean> = { ...preset.capabilities } as Record<string, boolean>;
  if (key === "sin_permisos_inventario") {
    sections = { "sections.pedidos": true };
    capabilities = { "cap.orders.view": true };
  }
  const businessId = key === "otro_negocio" ? "catalogo" : "bm";
  return {
    isActive: key !== "inactivo",
    roleId,
    displayName: `Compat ${key}`,
    email: `${key}@example.com`,
    sections,
    capabilities,
    businessMemberships: { [businessId]: { businessId, enabled: true, roleId } },
  };
}

// ------------------------------------------------------------------ matriz
type Outcome = "ALLOW" | "DENY" | "ERROR";
interface Cell { identity: IdentityKey; operation: string; outcome: Outcome; state: string; detail: string }
const matrix: Cell[] = [];

function classify(error: unknown): { outcome: Outcome; detail: string } {
  const code = (error as { code?: string } | null)?.code || "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "permission-denied" || /permission|PERMISSION_DENIED|insufficient permissions/i.test(message)) {
    return { outcome: "DENY", detail: code || message.slice(0, 120) };
  }
  return { outcome: "ERROR", detail: `${code} ${message}`.trim().slice(0, 160) };
}

describe("Compatibilidad cliente ↔ reglas reales (emulador)", () => {
  let inventory: InventoryService;
  let orders: OrdersService;
  let supplierOps: SupplierOperationsService;
  let returns: ReturnsService;
  const emails = new Map<IdentityKey, string | null>();
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let seq = 0;
  let previousTimeout = 0;

  const ALL: IdentityKey[] = [
    "super_admin", "admin", "administrativo", "operativo", "repartidor", "durango_operativo",
    "sin_permisos_inventario", "otro_negocio", "inactivo", "anonimo",
  ];

  beforeAll(async () => {
    previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 900000;
    connectEmulatorsOnce();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    inventory = TestBed.inject(InventoryService);
    orders = TestBed.inject(OrdersService);
    supplierOps = TestBed.inject(SupplierOperationsService);
    returns = TestBed.inject(ReturnsService);
    TestBed.inject(FeatureFlagsService).set("returnsV2", true);
    for (const key of ALL) {
      if (key === "anonimo") { emails.set(key, null); continue; }
      const email = `compat-${key}-${run}@example.com`;
      const uid = await signUp(email);
      await ownerSet(`users/${uid}`, userDocFor(key));
      emails.set(key, email);
    }
    await ownerSet(`customers/cust-${run}`, { customer_id: `cust-${run}`, business_id: "bm", first_name: "Clienta", last_name: "Compat" });
    await ownerSet("finance_accounts/acc_caja_general", { account_id: "acc_caja_general", business_id: "bm", name: "General", balance: 1000 });
  });

  afterAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    await signOut(FIREBASE_AUTH).catch(() => undefined);
    console.log(`[RULES-COMPAT] ${JSON.stringify(matrix)}`);
  });

  async function as(key: IdentityKey): Promise<void> {
    if (FIREBASE_AUTH.currentUser) await signOut(FIREBASE_AUTH);
    const email = emails.get(key);
    if (email) await signInWithEmailAndPassword(FIREBASE_AUTH, email, "Test1234!");
  }

  /** Ejecuta la operación y, pase lo que pase, lee el estado final con acceso owner. */
  async function record(identity: IdentityKey, operation: string, fn: () => Promise<unknown>, probe: () => Promise<string>): Promise<void> {
    let result: { outcome: Outcome; detail: string };
    try {
      await fn();
      result = { outcome: "ALLOW", detail: "" };
    } catch (error) {
      result = classify(error);
    }
    const state = await probe().catch((error) => `probe: ${String(error).slice(0, 80)}`);
    matrix.push({ identity, operation, outcome: result.outcome, state, detail: result.detail });
  }

  function next(prefix: string): string { seq += 1; return `${prefix}-${run}-${seq}`; }
  const nowIso = () => new Date().toISOString();

  function item(id: string, overrides: Record<string, unknown> = {}) {
    return {
      item_id: id, title: `Artículo ${id}`, quantity: 1, confirmed_qty: 1, returned_qty: 0,
      price_clienta: 300, price_public: 300, price_cost: 100, state: "reservado_inventario", confirmation_state: "confirmed",
      source: "inventario", ...overrides,
    };
  }

  /** Inventario con la forma anterior: reservas por pedido en el documento, sin asignación. */
  async function seedInventory(id: string, onHand: number, reservedFor: Record<string, number> = {}): Promise<void> {
    const reservations = Object.fromEntries(Object.entries(reservedFor).map(([orderId, qty]) => [
      orderId, { qty, order_number: orderId, status: "reserved", updated_at: nowIso() },
    ]));
    const reserved = Object.values(reservedFor).reduce((sum, qty) => sum + qty, 0);
    await ownerSet(`inventory_items/${id}`, {
      inventory_id: id, business_id: "bm", title: `Producto ${id}`, sku: id,
      on_hand_qty: onHand, reserved_qty: reserved, available_qty: onHand - reserved, in_review_qty: 0, damaged_qty: 0,
      unit_price: 100, image_urls: [], source_reason: "ajuste_manual", reservations, idempotency_keys: {},
    });
  }

  async function seedOrder(orderId: string, data: Record<string, unknown>): Promise<void> {
    await ownerSet(`orders/${orderId}`, {
      order_id: orderId, business_id: "bm", customer_id: `cust-${run}`, route_id: null, status: "recibido_qa",
      items: [], packages: [], timeline: [], notes: "",
      packing: { status: "in_progress", packages_count: 0, completed_at: null },
      dispatch_request: { status: "none" },
      totals: { total_amount: 300, paid_amount: 0, balance_due: 300, gross_amount: 300, net_amount: 300, discount_amount: 0 },
      created_at: nowIso(), updated_at: nowIso(), ...data,
    });
  }

  async function loadAs(orderId: string): Promise<Order> {
    const snap = await getDoc(doc(FIRESTORE, "orders", orderId));
    if (!snap.exists()) throw new Error("pedido no legible");
    const order = { ...(snap.data() as Record<string, any>), order_id: orderId, timeline: [] } as unknown as Order;
    orders.add(order);
    return order;
  }

  const inv = async (id: string) => {
    const row = await ownerGet(`inventory_items/${id}`);
    return row ? `on_hand=${row["on_hand_qty"]} reserved=${row["reserved_qty"]} available=${row["available_qty"]}` : "inventario=inexistente";
  };
  const ord = async (id: string, fields: string[]) => {
    const row = await ownerGet(`orders/${id}`);
    return fields.map((field) => `${field}=${JSON.stringify(field.split(".").reduce<any>((acc, key) => acc?.[key], row) ?? null)}`).join(" ");
  };

  it("lecturas base del cliente", async () => {
    const orderId = next("PL");
    await seedOrder(orderId, {});
    await seedInventory(next("inv"), 1);
    for (const key of ALL) {
      await as(key);
      await record(key, "leer_pedidos_del_negocio", () => getDocs(query(collection(FIRESTORE, "orders"), where("business_id", "in", ["bm"]))), async () => "-");
      await record(key, "leer_inventario", () => inventory.loadFromFirestore({ includeMovements: false }), async () => "-");
    }
  });

  it("inventario: reservar, liberar, ajustar y recibir entrada", async () => {
    for (const key of ALL) {
      const orderId = next("PINV");
      const reserveInv = next("inv");
      const releaseInv = next("inv");
      const adjustInv = next("inv");
      const inboundInv = next("inv-nuevo");
      await seedOrder(orderId, { status: "borrador", items: [item("r-1", { inventory_id: reserveInv }), item("l-1", { inventory_id: releaseInv })] });
      await seedInventory(reserveInv, 2);
      await seedInventory(releaseInv, 2, { [orderId]: 1 });
      await seedInventory(adjustInv, 2);
      await as(key);
      await record(key, "reservar", () => inventory.reserveStock(
        { sku: reserveInv, qty: 1, orderId, orderItemId: "r-1", idempotencyKey: `reserve_${orderId}_r-1` }, { refreshCache: false },
      ), () => inv(reserveInv));
      await record(key, "liberar_reserva", () => inventory.releaseReservation(
        { sku: releaseInv, qty: 1, orderId, orderItemId: "l-1", idempotencyKey: `release_${orderId}_l-1` },
      ), () => inv(releaseInv));
      await record(key, "ajustar_existencia", () => inventory.adjustQuantity(adjustInv, 1), () => inv(adjustInv));
      await record(key, "recibir_entrada_nueva", () => inventory.receiveInbound({
        sku: inboundInv, qty: 2, business_id: "bm", unit_price: 100, supplierOperationId: `manual-${orderId}`, lineId: "n-1",
        idempotencyKey: `inbound_${orderId}_n-1`, title: "Entrada compat",
      }, { refreshCache: false }), () => inv(inboundInv));
    }
  });

  it("proveedor: crear líneas y recibir con reserva", async () => {
    for (const key of ALL) {
      const createOrder = next("PSUP");
      await seedOrder(createOrder, { status: "borrador", items: [item("c-1", { source: "catalogo", supplier_id: "sup-c", product_id: `prod-${createOrder}` })] });
      const receiveOrder = next("PREC");
      const opId = `op-${receiveOrder}-s-1`;
      await seedOrder(receiveOrder, { status: "supplier_processing", items: [item("s-1", { source: "catalogo", supplier_id: "sup-c", product_id: `prod-${receiveOrder}` })] });
      await ownerSet(`supplier_operations/${opId}`, {
        op_id: opId, business_id: "bm", order_id: receiveOrder, order_item_id: "s-1", reserved_for_order_id: receiveOrder,
        supplier_id: "sup-c", supplier_name: "Proveedor", product_id: `prod-${receiveOrder}`, title: "Artículo s-1",
        quantity: 1, status: "en_camino", received_to_inventory: false, reservation_applied: false,
        customer_name: "Clienta", created_at: nowIso(), updated_at: nowIso(),
      });
      await as(key);
      await record(key, "crear_lineas_proveedor", async () => {
        const order = await loadAs(createOrder);
        await supplierOps.upsertFromConfirmedOrder(order, "Clienta Compat");
      }, async () => `linea=${(await ownerGet(`supplier_operations/op-${createOrder}-c-1`)) ? "creada" : "no"}`);
      await record(key, "recibir_proveedor", async () => {
        await loadAs(receiveOrder).catch(() => null);
        await supplierOps.receiveLineAndAllocate(opId, `${opId}:recibido`, { refreshInventory: false, reloadSupplierOperations: false, syncOrderStatus: false });
      }, async () => {
        const op = await ownerGet(`supplier_operations/${opId}`);
        const inventoryId = String(op?.["inventory_item_id"] || "");
        return `linea=${op?.["status"]} recibido=${op?.["received_to_inventory"]} ${inventoryId ? await inv(inventoryId) : "inventario=sin_crear"}`;
      });
    }
  });

  it("empaque y estado operativo", async () => {
    for (const key of ALL) {
      const readyOrder = next("PEMP");
      const stateOrder = next("POPE");
      await seedOrder(readyOrder, { status: "empaque", items: [item("e-1")] });
      await seedOrder(stateOrder, { status: "ready_for_route", items: [item("o-1")] });
      await as(key);
      await record(key, "listo_para_ruta", async () => {
        await loadAs(readyOrder);
        await orders.markReadyForRoute(readyOrder, 1);
      }, () => ord(readyOrder, ["status", "packing.status"]));
      await record(key, "estado_operativo", async () => {
        await loadAs(stateOrder);
        await orders.updateOperationalState(stateOrder, { current_holder_location: "durango", current_holder_name: "Compat" }, "Recibido en Durango");
      }, () => ord(stateOrder, ["current_holder_location"]));
      await record(key, "registrar_evento", async () => {
        await loadAs(stateOrder);
        await orders.logEvent(stateOrder, "COMPAT_EVENT", "Evento de compatibilidad");
      }, async () => "-");
    }
  });

  it("entrega: stock propio y mercancía de proveedor ya recibida", async () => {
    for (const key of ALL) {
      const ownOrder = next("PENT");
      const ownInv = next("inv");
      await seedInventory(ownInv, 3, { [ownOrder]: 1 });
      await seedOrder(ownOrder, { status: "ready_for_route", items: [item("d-1", { inventory_id: ownInv })] });

      const supOrder = next("PENTSUP");
      const supInv = next("inv");
      const opId = `op-${supOrder}-p-1`;
      await seedInventory(supInv, 2, { [supOrder]: 1 });
      await seedOrder(supOrder, { status: "ready_for_route", items: [item("p-1", { source: "catalogo", supplier_id: "sup-c", product_id: `prod-${supOrder}`, state: "recibido_qa" })] });
      await ownerSet(`supplier_operations/${opId}`, {
        op_id: opId, business_id: "bm", order_id: supOrder, order_item_id: "p-1", reserved_for_order_id: supOrder,
        supplier_id: "sup-c", supplier_name: "Proveedor", product_id: `prod-${supOrder}`, title: "Artículo p-1",
        quantity: 1, status: "recibido", inventory_item_id: supInv, received_to_inventory: true, reservation_applied: true,
        received_qty: 1, reserved_qty_for_order: 1, customer_name: "Clienta", created_at: nowIso(), updated_at: nowIso(),
      });

      await as(key);
      await record(key, "entregar_stock_propio", async () => {
        await loadAs(ownOrder);
        await orders.markOrderDelivered(ownOrder);
      }, async () => `${await ord(ownOrder, ["status", "delivery_status"])} ${await inv(ownInv)}`);
      await record(key, "entregar_mercancia_proveedor", async () => {
        await loadAs(supOrder);
        await supplierOps.loadForOrder(supOrder).catch(() => undefined);
        await orders.markOrderDelivered(supOrder);
      }, async () => `${await ord(supOrder, ["status", "delivery_status"])} ${await inv(supInv)}`);
    }
  });

  it("cobro, conciliación y devolución", async () => {
    for (const key of ALL) {
      const payOrder = next("PCOB");
      await seedOrder(payOrder, { status: "entregado", delivery_status: "delivered", delivered_at: nowIso(), items: [item("c-1")] });
      const settleOrder = next("PCON");
      await seedOrder(settleOrder, {
        status: "pagado", delivery_status: "delivered", delivered_at: nowIso(), customer_payment_status: "collected", settlement_status: "pending",
        totals: { total_amount: 300, paid_amount: 300, balance_due: 0, gross_amount: 300, net_amount: 300, discount_amount: 0 }, items: [item("s-1")],
      });
      const returnOrder = next("PDEV");
      const returnInv = next("inv");
      await seedInventory(returnInv, 2);
      await seedOrder(returnOrder, { status: "entregado", delivery_status: "delivered", delivered_at: nowIso(), items: [item("v-1", { inventory_id: returnInv })] });
      // Evidencia con la forma anterior: la venta quedó como movimiento, sin asignación.
      await ownerSet(`inventory_movements/delivery_${returnOrder}_close_v-1`, {
        movement_id: `delivery_${returnOrder}_close_v-1`, business_id: "bm", inventory_id: returnInv, type: "sale",
        delta_on_hand: -1, delta_available: 0, delta_reserved: -1, delta_in_review: 0, delta_damaged: 0,
        order_id: returnOrder, order_item_id: "v-1", return_id: null, idempotency_key: `delivery_${returnOrder}_close_v-1`,
      });

      await as(key);
      await record(key, "registrar_cobro", async () => {
        await loadAs(payOrder);
        await orders.registerCustomerCollection(payOrder, 100, "efectivo");
      }, () => ord(payOrder, ["status", "totals.paid_amount", "customer_payment_status"]));
      await record(key, "marcar_dinero_enviado", async () => {
        await loadAs(settleOrder);
        await orders.markSettlement(settleOrder, "sent_to_gdl", "Compat");
      }, () => ord(settleOrder, ["status", "settlement_status"]));
      await record(key, "registrar_devolucion", async () => {
        const order = await loadAs(returnOrder);
        await returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "available", attemptId: `att-${returnOrder}`, paymentResolution: "not_required" });
      }, async () => {
        const saved = await ownerGet(`orders/${returnOrder}`);
        const record = await ownerGet(`returns/ret_${returnOrder}_v-1_att-${returnOrder}`);
        return `devueltas=${saved?.["items"]?.[0]?.["returned_qty"] ?? 0} registro=${record ? record["status"] : "no"} ${await inv(returnInv)}`;
      });
    }
  });

  it("deja la matriz en el log", () => {
    expect(matrix.length).toBeGreaterThan(0);
  });
});
