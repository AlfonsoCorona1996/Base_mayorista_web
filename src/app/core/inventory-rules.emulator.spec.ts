import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, signInWithEmailAndPassword, signOut } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { DEFAULT_ROLE_PRESETS, RoleId } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { InventoryService } from "./inventory.service";
import { Order, OrdersService } from "./orders.service";
import { SupplierOperationsService } from "./supplier-operations.service";
import { ReturnRecord, ReturnsService } from "./returns.service";
import { FeatureFlagsService } from "./feature-flags.service";
import { INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId } from "./inventory-allocations";

/**
 * FIX 03B-1.1 — matriz de permisos con las reglas REALES (`firestore.rules`, sin reglas
 * permisivas) en el emulador oficial. Cada celda ejecuta la transacción completa del
 * servicio con la identidad indicada; los datos se siembran con el acceso "owner" del
 * emulador (omite reglas, igual que el Admin SDK del backend para `users/{uid}`).
 *
 * NO corre en `npm test`. Ver tmp/fix-03b11/run-rules.cjs.
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

// ------------------------------------------------------------------ acceso owner (siembra)
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
async function ownerQuery(collectionId: string, field: string, value: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${REST}:runQuery`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } } } }),
  });
  const rows = await res.json() as Array<{ document?: { fields: Record<string, any> } }>;
  return rows.filter((row) => row.document).map((row) => Object.fromEntries(Object.entries(row.document!.fields).map(([k, v]) => [k, fromValue(v)])));
}

// ------------------------------------------------------------------ identidades
type IdentityKey =
  | "super_admin" | "admin" | "administrativo" | "operativo" | "repartidor" | "durango_operativo"
  | "sin_permisos_inventario" | "otro_negocio" | "inactivo" | "anonimo";

interface Identity { key: IdentityKey; email: string | null; uid: string | null }

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
    // Usuario activo del negocio que solo ve pedidos: ninguna capacidad de inventario, entrega ni devolución.
    sections = { "sections.pedidos": true };
    capabilities = { "cap.orders.view": true };
  }
  const businessId = key === "otro_negocio" ? "catalogo" : "bm";
  return {
    isActive: key !== "inactivo",
    roleId,
    displayName: `Rules ${key}`,
    email: `${key}@example.com`,
    sections,
    capabilities,
    businessMemberships: { [businessId]: { businessId, enabled: true, roleId } },
  };
}

// ------------------------------------------------------------------ matriz
type Outcome = "ALLOW" | "DENY" | "ERROR";
interface Cell { identity: IdentityKey; operation: string; outcome: Outcome; detail: string; ms: number }
const matrix: Cell[] = [];

function classify(error: unknown): { outcome: Outcome; detail: string } {
  const code = (error as { code?: string } | null)?.code || "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "permission-denied" || /permission|PERMISSION_DENIED|insufficient permissions/i.test(message)) {
    return { outcome: "DENY", detail: code || message.slice(0, 160) };
  }
  return { outcome: "ERROR", detail: `${code} ${message}`.trim().slice(0, 200) };
}

describe("FIX 03B-1.1 — reglas reales: permisos de inventario y asignaciones (emulador)", () => {
  let inventory: InventoryService;
  let orders: OrdersService;
  let supplierOps: SupplierOperationsService;
  let returns: ReturnsService;
  const identities = new Map<IdentityKey, Identity>();
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let seq = 0;
  let previousTimeout = 0;

  const ALL: IdentityKey[] = [
    "super_admin", "admin", "administrativo", "operativo", "repartidor", "durango_operativo",
    "sin_permisos_inventario", "otro_negocio", "inactivo", "anonimo",
  ];

  beforeAll(async () => {
    previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 600000;
    connectEmulatorsOnce();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    inventory = TestBed.inject(InventoryService);
    orders = TestBed.inject(OrdersService);
    supplierOps = TestBed.inject(SupplierOperationsService);
    returns = TestBed.inject(ReturnsService);
    TestBed.inject(FeatureFlagsService).set("returnsV2", true);
    for (const key of ALL) {
      if (key === "anonimo") { identities.set(key, { key, email: null, uid: null }); continue; }
      const email = `rules-${key}-${run}@example.com`;
      const uid = await signUp(email);
      await ownerSet(`users/${uid}`, userDocFor(key));
      identities.set(key, { key, email, uid });
    }
  });

  afterAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    await signOut(FIREBASE_AUTH).catch(() => undefined);
    console.log(`[FIX03B11-RULES] ${JSON.stringify(matrix)}`);
  });

  async function as(key: IdentityKey): Promise<void> {
    const identity = identities.get(key)!;
    if (FIREBASE_AUTH.currentUser) await signOut(FIREBASE_AUTH);
    if (identity.email) await signInWithEmailAndPassword(FIREBASE_AUTH, identity.email, "Test1234!");
  }

  async function record(identity: IdentityKey, operation: string, fn: () => Promise<string | void>): Promise<Cell> {
    const started = performance.now();
    let cell: Cell;
    try {
      const detail = await fn();
      cell = { identity, operation, outcome: "ALLOW", detail: detail || "", ms: Math.round(performance.now() - started) };
    } catch (error) {
      cell = { identity, operation, ...classify(error), ms: Math.round(performance.now() - started) };
    }
    matrix.push(cell);
    return cell;
  }

  // ---------------------------------------------------------------- siembra
  function next(prefix: string): string { seq += 1; return `${prefix}-${run}-${seq}`; }

  function item(id: string, overrides: Record<string, unknown> = {}) {
    return {
      item_id: id, title: `Artículo ${id}`, quantity: 1, confirmed_qty: 1, returned_qty: 0,
      price_clienta: 300, price_public: 300, price_cost: 100, state: "reservado_inventario", confirmation_state: "confirmed",
      ...overrides,
    };
  }

  async function seedInventory(id: string, onHand: number, extra: Record<string, unknown> = {}): Promise<void> {
    const reservations = (extra["reservations"] || {}) as Record<string, { qty: number }>;
    const reserved = Object.values(reservations).reduce((sum, row) => sum + row.qty, 0);
    await ownerSet(`inventory_items/${id}`, {
      inventory_id: id, business_id: "bm", title: `Producto ${id}`, sku: id,
      on_hand_qty: onHand, reserved_qty: reserved, available_qty: onHand - reserved, in_review_qty: 0, damaged_qty: 0,
      unit_price: 100, image_urls: [], source_reason: "ajuste_manual", reservations: {}, idempotency_keys: {},
      ...extra,
    });
  }

  async function seedAllocation(orderId: string, itemId: string, invId: string, fields: Record<string, unknown> = {}, businessId = "bm"): Promise<string> {
    const id = allocationDocId(orderId, itemId, invId);
    await ownerSet(`${INVENTORY_ALLOCATIONS_COLLECTION}/${id}`, {
      allocation_id: id, business_id: businessId, order_id: orderId, order_item_id: itemId, inventory_id: invId,
      source: "own_stock", supplier_id: null, supplier_operation_id: null,
      reserved_qty: 1, delivered_qty: 0, returned_qty: 0, return_released_qty: 0, released_qty: 0, allocated_total_qty: 1,
      last_movement_id: null, ...fields,
    });
    return id;
  }

  async function seedOrder(orderId: string, data: Record<string, unknown>): Promise<void> {
    await ownerSet(`orders/${orderId}`, {
      order_id: orderId, business_id: "bm", customer_id: `cust-${run}`, route_id: null, status: "recibido_qa",
      packages: [], timeline: [], totals: { total_amount: 300, paid_amount: 0, balance_due: 300 }, ...data,
    });
    await ownerSet(`customers/cust-${run}`, { customer_id: `cust-${run}`, business_id: "bm", name: "Clienta reglas" });
  }

  /** Pedido con una línea propia ya apartada (asignación incluida), listo para entregar o liberar. */
  async function seedReservedOrder(status = "ready_for_route", extraOrder: Record<string, unknown> = {}) {
    const orderId = next("PR");
    const invId = next("inv");
    await seedInventory(invId, 3, { reservations: { [orderId]: { qty: 1, order_number: orderId, status: "reserved", updated_at: new Date().toISOString() } } });
    await seedAllocation(orderId, "l-1", invId);
    await seedOrder(orderId, { status, items: [item("l-1", { source: "inventario", inventory_id: invId })], ...extraOrder });
    return { orderId, invId };
  }

  /** El servicio trabaja con la copia en memoria (en la app la mantiene el listener). */
  function localOrder(raw: Record<string, any>, orderId: string): Order {
    const order = { ...raw, order_id: orderId, timeline: [] } as unknown as Order;
    orders.add(order);
    return order;
  }
  async function loadAs(orderId: string): Promise<Order> {
    const snap = await getDoc(doc(FIRESTORE, "orders", orderId));
    if (!snap.exists()) throw new Error("pedido no legible");
    return localOrder(snap.data() as Record<string, any>, orderId);
  }

  // ---------------------------------------------------------------- 0. diagnóstico
  it("0. lecturas aisladas que usan las transacciones (diagnóstico)", async () => {
    const opId = next("op-diag");
    await ownerSet(`supplier_operations/${opId}`, { op_id: opId, business_id: "bm", order_id: `P-${opId}` });
    for (const key of ALL) {
      await as(key);
      await record(key, "0a_get_return_inexistente", async () => { await getDoc(doc(FIRESTORE, "returns", `ret_nope_${seq}_${key}`)); });
      await record(key, "0b_get_finance_period_inexistente", async () => { await getDoc(doc(FIRESTORE, "finance_periods", "bm_2026-11")); });
      await record(key, "0c_query_supplier_ops_por_pedido", async () => { await getDocs(query(collection(FIRESTORE, "supplier_operations"), where("order_id", "==", `P-${opId}`))); });
      await record(key, "0d_query_supplier_ops_negocio_y_pedido", async () => { await getDocs(query(collection(FIRESTORE, "supplier_operations"), where("business_id", "==", "bm"), where("order_id", "==", `P-${opId}`))); });
      await record(key, "0e_get_supplier_op_existente", async () => { await getDoc(doc(FIRESTORE, "supplier_operations", opId)); });
      await record(key, "0f_get_supplier_op_inexistente", async () => { await getDoc(doc(FIRESTORE, "supplier_operations", `op-nope-${seq}`)); });
      await record(key, "0g_get_inventario_inexistente", async () => { await getDoc(doc(FIRESTORE, "inventory_items", `inv-nope-${seq}`)); });
      await record(key, "0h_get_customer_inexistente", async () => { await getDoc(doc(FIRESTORE, "customers", `c-nope-${seq}`)); });
      await record(key, "0i_query_movimientos_por_pedido", async () => { await getDocs(query(collection(FIRESTORE, "inventory_movements"), where("business_id", "==", "bm"), where("order_id", "==", `P-${opId}`))); });
    }
  });

  // ---------------------------------------------------------------- 1. lectura
  it("1. lectura de una asignación existente y de una inexistente", async () => {
    for (const key of ALL) {
      const { orderId, invId } = await seedReservedOrder();
      await as(key);
      await record(key, "1a_leer_asignacion_existente", async () => {
        const snap = await getDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId(orderId, "l-1", invId)));
        return snap.exists() ? "leída" : "no existe";
      });
      await record(key, "1b_leer_asignacion_inexistente", async () => {
        const snap = await getDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, `alloc__nope__${seq}__x`));
        return snap.exists() ? "existe" : "no existe";
      });
      await record(key, "1c_consulta_asignaciones_del_pedido", async () => {
        const rows = await inventory.loadAllocationsForOrder(orderId, "bm");
        return `${rows.length} filas`;
      });
    }
  });

  // ---------------------------------------------------------------- 2. reserva
  it("2. reserva de stock propio (transacción completa con asignación nueva)", async () => {
    for (const key of ALL) {
      const orderId = next("PRES");
      const invId = next("inv");
      await seedInventory(invId, 2);
      await seedOrder(orderId, { status: "borrador", items: [item("r-1", { source: "inventario", inventory_id: invId })] });
      await as(key);
      await record(key, "2_reservar", async () => {
        await inventory.reserveStock({ sku: invId, qty: 1, orderId, orderItemId: "r-1", idempotencyKey: `reserve_${orderId}_r-1`, allocation: { source: "own_stock" } }, { refreshCache: false });
        const alloc = await ownerGet(`${INVENTORY_ALLOCATIONS_COLLECTION}/${allocationDocId(orderId, "r-1", invId)}`);
        return `reserved=${(await ownerGet(`inventory_items/${invId}`))?.["reserved_qty"]} alloc=${alloc?.["reserved_qty"]}`;
      });
      // 7. Reintento idempotente con la misma llave (solo si el primero pasó).
      if (matrix[matrix.length - 1].outcome === "ALLOW") {
        await record(key, "7a_reintento_reserva", async () => {
          await inventory.reserveStock({ sku: invId, qty: 1, orderId, orderItemId: "r-1", idempotencyKey: `reserve_${orderId}_r-1`, allocation: { source: "own_stock" } }, { refreshCache: false });
          const after = await ownerGet(`inventory_items/${invId}`);
          if (after?.["reserved_qty"] !== 1) throw new Error(`duplicó: reserved=${after?.["reserved_qty"]}`);
          return "sin cambios";
        });
      }
    }
  });

  // ---------------------------------------------------------------- 3. recepción
  it("3. recepción de proveedor con reserva atómica", async () => {
    for (const key of ALL) {
      const orderId = next("PREC");
      const opId = `op-${orderId}-s-1`;
      await seedOrder(orderId, { status: "supplier_processing", items: [item("s-1", { source: "catalogo", supplier_id: "sup-r", product_id: `prod-${orderId}` })] });
      await ownerSet(`supplier_operations/${opId}`, {
        op_id: opId, business_id: "bm", order_id: orderId, order_item_id: "s-1", reserved_for_order_id: orderId,
        supplier_id: "sup-r", supplier_name: "Proveedor", product_id: `prod-${orderId}`, title: "Artículo s-1",
        quantity: 1, status: "en_camino", received_to_inventory: false, reservation_applied: false,
        customer_name: "Clienta", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      await as(key);
      await record(key, "3_recibir_y_apartar", async () => {
        await loadAs(orderId).catch(() => null);
        await supplierOps.receiveLineAndAllocate(opId, `${opId}:recibido`);
        const op = await ownerGet(`supplier_operations/${opId}`);
        const inv = String(op?.["inventory_item_id"] || "");
        const state = inv ? await ownerGet(`inventory_items/${inv}`) : null;
        if (!inv || state?.["on_hand_qty"] !== 1 || state?.["reserved_qty"] !== 1) {
          throw new Error(`incompleto: inv=${inv} on_hand=${state?.["on_hand_qty"]} reserved=${state?.["reserved_qty"]} status=${op?.["status"]}`);
        }
        return `on_hand=1 reserved=1 status=${op?.["status"]}`;
      });
    }
  });

  // ---------------------------------------------------------------- 4. entrega
  it("4. entrega completa (pedido + inventario) y entrega por caja", async () => {
    for (const key of ALL) {
      const { orderId, invId } = await seedReservedOrder();
      await as(key);
      await record(key, "4a_marcar_entregado", async () => {
        const order = await loadAs(orderId);
        const result = await orders.markOrderDelivered(order.order_id);
        const inv = await ownerGet(`inventory_items/${invId}`);
        const saved = await ownerGet(`orders/${orderId}`);
        const detail = `sync_ok=${result.ok} on_hand=${inv?.["on_hand_qty"]} delivery=${saved?.["delivery_status"]} inv_sync=${JSON.stringify(saved?.["inventory_sync"]?.["status"] ?? null)}`;
        if (!result.ok || inv?.["on_hand_qty"] !== 2) throw new Error(`PARCIAL: ${detail} err=${result.error}`);
        return detail;
      });
      const boxOrder = next("PBOX");
      const boxInv = next("inv");
      await seedInventory(boxInv, 3, { reservations: { [boxOrder]: { qty: 2, order_number: boxOrder, status: "reserved", updated_at: new Date().toISOString() } } });
      await seedAllocation(boxOrder, "b-1", boxInv, { reserved_qty: 2, allocated_total_qty: 2 });
      await seedOrder(boxOrder, {
        status: "en_ruta",
        items: [item("b-1", { source: "inventario", inventory_id: boxInv, quantity: 2, confirmed_qty: 2 })],
        packages: [{ package_id: "box-1", label: "Caja 1", state: "cerrado", item_ids: ["b-1"], items: [{ orderItemId: "b-1", qty: 1 }] }],
      });
      await record(key, "4b_entregar_caja", async () => {
        await loadAs(boxOrder);
        const res = await orders.consumeInventoryForDelivery(boxOrder, "box-1");
        const inv = await ownerGet(`inventory_items/${boxInv}`);
        if (inv?.["on_hand_qty"] !== 2) throw new Error(`no consumió: on_hand=${inv?.["on_hand_qty"]}`);
        return `consumed=${res.consumed}`;
      });
    }
  });

  // ---------------------------------------------------------------- 5/8. devoluciones
  it("5, 8. devolución tras entrega y resolución tras conteo", async () => {
    for (const key of ALL) {
      // Pedido ya entregado por un administrador (estado de partida igual para todos).
      const orderId = next("PDEV");
      const invId = next("inv");
      await seedInventory(invId, 2);
      await seedAllocation(orderId, "d-1", invId, { reserved_qty: 0, delivered_qty: 1 });
      await seedOrder(orderId, {
        status: "entregado", delivery_status: "delivered", delivered_at: new Date().toISOString(),
        items: [item("d-1", { source: "inventario", inventory_id: invId })],
      });
      await as(key);
      await record(key, "5_registrar_devolucion", async () => {
        const order = await loadAs(orderId);
        const saved = await returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "available", attemptId: `att-${orderId}`, paymentResolution: "not_required" });
        const inv = await ownerGet(`inventory_items/${invId}`);
        return `on_hand=${inv?.["on_hand_qty"]} status=${saved.status}`;
      });

      // 5b/5c. Devolución de un pedido pagado: reembolso (cuenta + ledger + reembolso) y saldo a
      // favor (movimiento + clienta). Son las transacciones con más escrituras del flujo.
      for (const resolution of ["refund", "credit"] as const) {
        const paidOrder = next(`PPAG-${resolution}`);
        const paidInv = next("inv");
        await seedInventory(paidInv, 2);
        await seedAllocation(paidOrder, "p-1", paidInv, { reserved_qty: 0, delivered_qty: 1 });
        await seedOrder(paidOrder, {
          status: "pagado", delivery_status: "delivered", delivered_at: new Date().toISOString(), customer_payment_status: "collected",
          totals: { total_amount: 300, paid_amount: 300, balance_due: 0 },
          items: [item("p-1", { source: "inventario", inventory_id: paidInv })],
        });
        await ownerSet(`finance_accounts/acc-${run}`, { account_id: `acc-${run}`, business_id: "bm", name: "General", balance: 5000 });
        await record(key, resolution === "refund" ? "5b_devolucion_con_reembolso" : "5c_devolucion_con_saldo_a_favor", async () => {
          const order = await loadAs(paidOrder);
          const saved = await returns.registerReturn({
            order, item: order.items[0], qty: 1, disposition: "available", attemptId: `att-${paidOrder}`,
            paymentResolution: resolution, createdBy: `Rules ${key}`,
            ...(resolution === "refund" ? { refundAccountId: `acc-${run}`, refundMethod: "efectivo" } : {}),
          });
          const inv = await ownerGet(`inventory_items/${paidInv}`);
          return `on_hand=${inv?.["on_hand_qty"]} resolución=${saved.payment_resolution} monto=${saved.resolution_amount}`;
        });
      }

      // Devolución sin inventario comprobado ya registrada (sembrada) → resolución tras conteo.
      const heldOrder = next("PHOLD");
      const heldInv = next("inv");
      await seedInventory(heldInv, 0);
      await seedOrder(heldOrder, {
        status: "pagado", delivered_at: new Date().toISOString(),
        items: [item("h-1", { source: "catalogo", returned_qty: 1, returned_restockable_qty: 0, returned_unverified_qty: 1 })],
        has_returns: true,
      });
      const returnId = `ret_${heldOrder}_h-1_seed`;
      const heldRecord = {
        return_id: returnId, business_id: "bm", order_id: heldOrder, order_item_id: "h-1", qty: 1, disposition: "available",
        status: "inventory_unverified", inventory_id: null, inventory_legs: [], inventory_resolution: "unverified",
        product_snapshot: { title: "Artículo h-1", inventory_id: heldInv, product_id: null, supplier_id: null },
        unit_cost: 100, returned_cost_amount: 0, pending_recovery_cost_amount: 100, occurred_at: "2026-11-10",
      };
      await ownerSet(`returns/${returnId}`, heldRecord);
      await record(key, "8_resolver_tras_conteo", async () => {
        await returns.resolveUnverifiedReturn(heldRecord as unknown as ReturnRecord, "restock_after_count", key);
        const after = await ownerGet(`returns/${returnId}`);
        const inv = await ownerGet(`inventory_items/${heldInv}`);
        if (after?.["status"] === "inventory_unverified") throw new Error("sin cambios");
        return `status=${after?.["status"]} on_hand=${inv?.["on_hand_qty"]}`;
      });
    }
  });

  // ---------------------------------------------------------------- 6/7. liberación y reintento
  it("6, 7. liberación de reserva y reintento idempotente del ajuste de entrega", async () => {
    for (const key of ALL) {
      const { orderId, invId } = await seedReservedOrder("borrador");
      await as(key);
      await record(key, "6_liberar_reserva", async () => {
        const order = await loadAs(orderId);
        await orders.releaseInventoryForOrder(order.order_id);
        const inv = await ownerGet(`inventory_items/${invId}`);
        if (inv?.["reserved_qty"] !== 0) throw new Error(`no liberó: reserved=${inv?.["reserved_qty"]}`);
        return "reserved=0";
      });

      // Entrega guardada con inventario pendiente (como si la sesión anterior hubiera fallado).
      const pending = await seedReservedOrder("entregado", {
        delivery_status: "delivered", delivered_at: new Date().toISOString(),
        inventory_sync: { status: "pending", scope: "close", requested_at: new Date().toISOString(), attempts: 0 },
      });
      await record(key, "7b_reintentar_ajuste_entrega", async () => {
        await loadAs(pending.orderId);
        const first = await orders.retryDeliveryInventorySync(pending.orderId);
        const second = await orders.retryDeliveryInventorySync(pending.orderId);
        const inv = await ownerGet(`inventory_items/${pending.invId}`);
        const saved = await ownerGet(`orders/${pending.orderId}`);
        const detail = `ok=${first.ok}/${second.ok} on_hand=${inv?.["on_hand_qty"]} inv_sync=${saved?.["inventory_sync"]?.["status"] ?? null}`;
        if (!first.ok || inv?.["on_hand_qty"] !== 2) throw new Error(`PARCIAL: ${detail} err=${first.error}`);
        return detail;
      });
    }
  });

  // ---------------------------------------------------------------- 9–14. ataques directos
  it("9-14. escrituras directas no autorizadas sobre asignaciones e inventario", async () => {
    for (const key of ALL) {
      const { orderId, invId } = await seedReservedOrder();
      const allocId = allocationDocId(orderId, "l-1", invId);
      const allocRef = doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocId);
      const otherInv = next("inv-cat");
      await ownerSet(`inventory_items/${otherInv}`, { inventory_id: otherInv, business_id: "catalogo", on_hand_qty: 5, reserved_qty: 0, available_qty: 5 });
      const catAlloc = await seedAllocation(`PCAT-${run}-${seq}`, "c-1", otherInv, {}, "catalogo");
      await as(key);
      await record(key, "9_cambiar_pedido_propietario", () => updateDoc(allocRef, { order_id: "P-AJENO" }));
      await record(key, "10_cambiar_inventory_id", () => updateDoc(allocRef, { inventory_id: "inv-ajeno" }));
      await record(key, "11a_cantidad_negativa", () => updateDoc(allocRef, { reserved_qty: -5 }));
      await record(key, "11b_cantidad_superior", () => updateDoc(allocRef, { delivered_qty: 999 }));
      await record(key, "11c_cantidad_no_numerica", () => updateDoc(allocRef, { reserved_qty: "muchas" }));
      await record(key, "12_borrar_asignacion", () => deleteDoc(allocRef));
      await record(key, "13a_leer_asignacion_otro_negocio", async () => { await getDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, catAlloc)); });
      await record(key, "13b_consultar_asignaciones_otro_negocio", async () => {
        await getDocs(query(collection(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION), where("business_id", "==", "catalogo")));
      });
      await record(key, "14a_crear_asignacion_sin_transaccion", () => setDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId("P-X", "x", invId)), {
        allocation_id: allocationDocId("P-X", "x", invId), business_id: "bm", order_id: "P-X", order_item_id: "x", inventory_id: invId,
        reserved_qty: 3, delivered_qty: 0, returned_qty: 0, return_released_qty: 0, released_qty: 0, allocated_total_qty: 3,
      }));
      await record(key, "14b_crear_asignacion_id_inconsistente", () => setDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, `alloc__otro__${seq}`), {
        allocation_id: "x", business_id: "bm", order_id: orderId, order_item_id: "l-1", inventory_id: invId,
        reserved_qty: 1, delivered_qty: 0, returned_qty: 0, return_released_qty: 0, released_qty: 0, allocated_total_qty: 1,
      }));
      await record(key, "14c_crear_asignacion_inventario_otro_negocio", () => setDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId("P-Y", "y", otherInv)), {
        allocation_id: allocationDocId("P-Y", "y", otherInv), business_id: "bm", order_id: "P-Y", order_item_id: "y", inventory_id: otherInv,
        reserved_qty: 1, delivered_qty: 0, returned_qty: 0, return_released_qty: 0, released_qty: 0, allocated_total_qty: 1,
      }));
      await record(key, "14d_editar_existencia_directa", () => updateDoc(doc(FIRESTORE, "inventory_items", invId), { on_hand_qty: 50, available_qty: 49 }));
      await record(key, "14e_existencia_negativa_directa", () => updateDoc(doc(FIRESTORE, "inventory_items", invId), { on_hand_qty: -1 }));
      await record(key, "14f_movimiento_sin_documento", () => setDoc(doc(FIRESTORE, "inventory_movements", `fake_${run}_${seq}`), {
        movement_id: `fake_${run}_${seq}`, business_id: "bm", inventory_id: invId, type: "receipt", delta_on_hand: 10,
      }));
      await record(key, "14g_editar_inventario_otro_negocio", () => updateDoc(doc(FIRESTORE, "inventory_items", otherInv), { on_hand_qty: 0 }));
      await record(key, "14h_marcar_sync_completado_directo", () => updateDoc(doc(FIRESTORE, "orders", orderId), {
        inventory_sync: { status: "synced", verified_lines: 0 },
      }));
      await record(key, "14i_marcar_resuelto_manual_directo", () => updateDoc(doc(FIRESTORE, "orders", orderId), {
        inventory_sync: { status: "resolved_manual", resolution_note: "forzado" },
      }));
      await record(key, "14j_subir_apartado_directo", () => updateDoc(doc(FIRESTORE, "inventory_items", invId), {
        reserved_qty: 3, available_qty: 0, idempotency_keys: { [`forced_${seq}`]: new Date().toISOString() },
      }));
    }
    const leaked = await ownerQuery(INVENTORY_ALLOCATIONS_COLLECTION, "order_id", "P-AJENO");
    expect(leaked.length).withContext("ninguna asignación terminó con otro pedido").toBe(0);
  });
});
