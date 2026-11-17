import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, createUserWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { CAPABILITY_KEYS, SECTION_KEYS } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { InventoryService, InventoryStockInsufficientError } from "./inventory.service";
import { Order, OrdersService, PackageDeliveryEvidenceError } from "./orders.service";
import { SupplierOperationsService } from "./supplier-operations.service";
import { ReturnInventoryUnverifiedError, ReturnsService } from "./returns.service";
import { FeatureFlagsService } from "./feature-flags.service";
import { INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId } from "./inventory-allocations";

/**
 * FIX 03B-1 — integridad de inventario en pedidos nuevos, contra el emulador local.
 * NO corre en `npm test`. Ver scripts/emulator/README.md (emulador permisivo, puertos 8297/9397).
 * Usa reglas permisivas solo del emulador (ver firestore.emulator-test.rules).
 */
const FIRESTORE_PORT = 8297;
const AUTH_PORT = 9397;
let emulatorsConnected = false;

function connectEmulatorsOnce(): void {
  if (emulatorsConnected) return;
  connectFirestoreEmulator(FIRESTORE, "127.0.0.1", FIRESTORE_PORT);
  connectAuthEmulator(FIREBASE_AUTH, `http://127.0.0.1:${AUTH_PORT}`, { disableWarnings: true });
  emulatorsConnected = true;
}

interface InvState { onHand: number; reserved: number; available: number; review: number; damaged: number; reservations: Record<string, { qty: number }> }

const perf: Array<{ action: string; ms: number }> = [];
async function timed<T>(action: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    perf.push({ action, ms: Math.round(performance.now() - started) });
  }
}

describe("FIX 03B-1 — asignaciones de inventario (emulador)", () => {
  let inventory: InventoryService;
  let orders: OrdersService;
  let supplierOps: SupplierOperationsService;
  let returns: ReturnsService;
  let stamp = "";
  /** Existencia sembrada por documento (para la invariante "movimientos explican existencias"). */
  const seeded = new Map<string, { onHand: number; reserved: number }>();

  let previousTimeout = 0;

  beforeAll(async () => {
    // Escenarios de extremo a extremo con varias transacciones: más de los 5 s por defecto.
    previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
    connectEmulatorsOnce();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    const cred = await createUserWithEmailAndPassword(FIREBASE_AUTH, `fix03b1-${Date.now()}@example.com`, "Test1234!");
    await setDoc(doc(FIRESTORE, "users", cred.user.uid), {
      isActive: true,
      roleId: "super_admin",
      displayName: "FIX 03B-1",
      sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, true])),
      capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true])),
      businessMemberships: { bm: { businessId: "bm", enabled: true, roleId: "super_admin" } },
    });
    inventory = TestBed.inject(InventoryService);
    orders = TestBed.inject(OrdersService);
    supplierOps = TestBed.inject(SupplierOperationsService);
    returns = TestBed.inject(ReturnsService);
    TestBed.inject(FeatureFlagsService).set("returnsV2", true);
  });

  beforeEach(() => {
    stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    console.log(`[FIX03B1-PERF] ${JSON.stringify(perf)}`);
  });

  // ---------------------------------------------------------------- helpers
  async function seedInventory(id: string, onHand: number, extra: Record<string, unknown> = {}): Promise<void> {
    const reservations = (extra["reservations"] || {}) as Record<string, { qty: number }>;
    const reserved = Object.values(reservations).reduce((sum, row) => sum + row.qty, 0);
    seeded.set(id, { onHand, reserved });
    await setDoc(doc(FIRESTORE, "inventory_items", id), {
      inventory_id: id,
      business_id: "bm",
      title: `Producto ${id}`,
      sku: id,
      on_hand_qty: onHand,
      reserved_qty: reserved,
      available_qty: onHand - reserved,
      in_review_qty: 0,
      damaged_qty: 0,
      unit_price: 100,
      image_urls: [],
      source_reason: "ajuste_manual",
      reservations: {},
      idempotency_keys: {},
      ...extra,
    });
  }

  async function inv(id: string): Promise<InvState> {
    const snap = await getDoc(doc(FIRESTORE, "inventory_items", id));
    const data = (snap.data() || {}) as Record<string, any>;
    return {
      onHand: Number(data["on_hand_qty"] || 0),
      reserved: Number(data["reserved_qty"] || 0),
      available: Number(data["available_qty"] || 0),
      review: Number(data["in_review_qty"] || 0),
      damaged: Number(data["damaged_qty"] || 0),
      reservations: (data["reservations"] || {}) as Record<string, { qty: number }>,
    };
  }

  async function alloc(orderId: string, itemId: string, invId: string): Promise<Record<string, any> | null> {
    const snap = await getDoc(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId(orderId, itemId, invId)));
    return snap.exists() ? snap.data() as Record<string, any> : null;
  }

  function item(id: string, overrides: Record<string, unknown> = {}) {
    return {
      item_id: id,
      title: `Artículo ${id}`,
      quantity: 1,
      confirmed_qty: 1,
      returned_qty: 0,
      price_clienta: 300,
      price_public: 300,
      price_cost: 100,
      state: "reservado_inventario",
      confirmation_state: "confirmed",
      ...overrides,
    };
  }

  async function seedOrder(orderId: string, data: Record<string, unknown>): Promise<Order> {
    await setDoc(doc(FIRESTORE, "orders", orderId), {
      order_id: orderId,
      business_id: "bm",
      customer_id: `cust-${stamp}`,
      route_id: null,
      status: "recibido_qa",
      packages: [],
      timeline: [],
      totals: { total_amount: 0, paid_amount: 0, balance_due: 0 },
      ...data,
    });
    return refreshLocal(orderId);
  }

  /** El servicio de pedidos trabaja con su copia en memoria (en la app la mantiene el listener). */
  async function refreshLocal(orderId: string): Promise<Order> {
    const snap = await getDoc(doc(FIRESTORE, "orders", orderId));
    const order = { ...(snap.data() as Record<string, unknown>), order_id: orderId, timeline: [] } as unknown as Order;
    orders.add(order);
    return order;
  }

  /** Invariantes por documento: movimientos explican existencias; reservas y asignaciones cuadran. */
  async function expectInvariants(invId: string): Promise<void> {
    const state = await inv(invId);
    const seed = seeded.get(invId) || { onHand: 0, reserved: 0 };
    const movements = (await getDocs(query(collection(FIRESTORE, "inventory_movements"), where("inventory_id", "==", invId))))
      .docs.map((entry) => entry.data() as Record<string, any>);
    const sum = (field: string) => movements.reduce((acc, row) => acc + Number(row[field] || 0), 0);
    expect(seed.onHand + sum("delta_on_hand")).withContext(`${invId}: on_hand explicado por movimientos`).toBe(state.onHand);
    expect(seed.reserved + sum("delta_reserved")).withContext(`${invId}: reservado explicado por movimientos`).toBe(state.reserved);
    expect(state.available).withContext(`${invId}: disponible = existencia − apartado − revisión − dañado`)
      .toBe(state.onHand - state.reserved - state.review - state.damaged);
    expect(state.available).withContext(`${invId}: nunca negativo`).toBeGreaterThanOrEqual(0);
    const reservationsTotal = Object.values(state.reservations).reduce((acc, row) => acc + Number(row.qty || 0), 0);
    expect(reservationsTotal).withContext(`${invId}: reservas por pedido = apartado`).toBe(state.reserved);
    const allocations = (await getDocs(query(collection(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION), where("inventory_id", "==", invId))))
      .docs.map((entry) => entry.data() as Record<string, any>);
    const allocated = allocations.reduce((acc, row) => acc + Number(row["reserved_qty"] || 0), 0);
    expect(allocated).withContext(`${invId}: asignaciones nunca superan lo apartado`).toBeLessThanOrEqual(state.reserved);
    expect(state.reserved).withContext(`${invId}: apartado ≤ existencia válida`).toBeLessThanOrEqual(state.onHand - state.review - state.damaged);
  }

  /** Pedido nuevo con dos artículos: uno de inventario propio y uno de proveedor (qty 2). */
  async function newTwoItemOrder() {
    const orderId = `P-${stamp}`;
    const ownInv = `inv-own-${stamp}`;
    await seedInventory(ownInv, 3);
    await seedOrder(orderId, {
      status: "supplier_processing",
      items: [
        item("own-1", { source: "inventario", inventory_id: ownInv }),
        item("sup-1", { source: "catalogo", supplier_id: `sup-${stamp}`, product_id: `prod-${stamp}`, quantity: 2, confirmed_qty: 1 }),
      ],
    });
    // Reserva de inventario propio: mismo camino que "Agregar producto".
    await inventory.reserveStock({
      sku: ownInv, qty: 1, orderId, orderItemId: "own-1",
      idempotencyKey: `reserve_${orderId}_own-1`, allocation: { source: "own_stock" },
    });
    return { orderId, ownInv };
  }

  async function receiveSupplier(orderId: string): Promise<string> {
    const order = await refreshLocal(orderId);
    await supplierOps.upsertFromConfirmedOrder(order, "Clienta FIX");
    const opId = `op-${orderId}-sup-1`;
    await timed("receive_supplier_line", () => supplierOps.receiveLineAndAllocate(opId, `${opId}:recibido`));
    const op = (await getDoc(doc(FIRESTORE, "supplier_operations", opId))).data() as Record<string, any>;
    return String(op["inventory_item_id"]);
  }

  // -------------------------------------------------------------- escenarios
  it("1-5, 7-10, 12, 18: pedido de dos artículos, recepción parcial y completa, reserva, entrega, devoluciones e idempotencia", async () => {
    // 1. Pedido nuevo con dos artículos.
    const { orderId, ownInv } = await newTwoItemOrder();
    expect((await alloc(orderId, "own-1", ownInv))?.["reserved_qty"]).toBe(1);

    // 2. Recepción parcial: llega 1 de 2.
    const supInv = await receiveSupplier(orderId);
    let state = await inv(supInv);
    expect(state.onHand).toBe(1);
    expect(state.reserved).toBe(1);
    expect((await alloc(orderId, "sup-1", supInv))?.["reserved_qty"]).toBe(1);

    // 3. Recepción completa: se confirma la segunda pieza y vuelve a recibirse.
    await updateDoc(doc(FIRESTORE, "orders", orderId), {
      items: [
        item("own-1", { source: "inventario", inventory_id: ownInv }),
        item("sup-1", { source: "catalogo", supplier_id: `sup-${stamp}`, product_id: `prod-${stamp}`, quantity: 2, confirmed_qty: 2 }),
      ],
    });
    await receiveSupplier(orderId);
    // Reintento / doble clic de la recepción: misma llave, sin cambios.
    await Promise.all([receiveSupplier(orderId), receiveSupplier(orderId)]);
    state = await inv(supInv);
    expect(state.onHand).withContext("solo entran unidades realmente recibidas").toBe(2);
    expect(state.reserved).toBe(2);
    expect(state.available).toBe(0);

    // 4. Reserva correcta: reservas del pedido = asignación.
    expect(state.reservations[orderId]?.qty).toBe(2);
    expect((await alloc(orderId, "sup-1", supInv))?.["reserved_qty"]).toBe(2);
    await expectInvariants(supInv);

    // 5. Entrega completa.
    await refreshLocal(orderId);
    const delivery = await timed("mark_delivered", () => orders.markOrderDelivered(orderId, "FIX 03B-1"));
    expect(delivery.ok).toBeTrue();
    expect(delivery.shortfall).toBe(0);
    expect((await inv(ownInv)).onHand).toBe(2);
    state = await inv(supInv);
    expect(state.onHand).withContext("la mercancía de proveedor sale del inventario").toBe(0);
    expect(state.available).withContext("no queda disponible lo que salió").toBe(0);
    expect((await alloc(orderId, "sup-1", supInv))?.["delivered_qty"]).toBe(2);
    // Reintento de la entrega: no descuenta dos veces.
    await orders.retryDeliveryInventorySync(orderId);
    expect((await inv(ownInv)).onHand).toBe(2);
    expect((await inv(supInv)).onHand).toBe(0);

    // 7 y 12. Devolución de una unidad, disponible: regresa al MISMO documento (no `ret-…`).
    let order = await refreshLocal(orderId);
    const supItem = order.items.find((row) => row.item_id === "sup-1")!;
    const first = await timed("register_return", () => returns.registerReturn({
      order, item: supItem, qty: 1, disposition: "available", attemptId: `a1-${stamp}`, paymentResolution: "not_required",
    }));
    expect(first.inventory_id).toBe(supInv);
    expect(first.inventory_resolution).toBe("allocation");
    state = await inv(supInv);
    expect(state.onHand).toBe(1);
    expect(state.available).toBe(1);
    expect((await alloc(orderId, "sup-1", supInv))?.["returned_qty"]).toBe(1);
    const sameProduct = await getDocs(query(collection(FIRESTORE, "inventory_items"), where("product_id", "==", `prod-${stamp}`)));
    expect(sameProduct.docs.map((entry) => entry.id)).withContext("no se crea un documento ret-… paralelo").toEqual([supInv]);

    // 9 y 10. Reintento y doble clic con el mismo intento: un solo registro y un solo ingreso.
    order = await refreshLocal(orderId);
    const again = await Promise.all([
      returns.registerReturn({ order, item: supItem, qty: 1, disposition: "available", attemptId: `a1-${stamp}`, paymentResolution: "not_required" }),
      returns.registerReturn({ order, item: supItem, qty: 1, disposition: "available", attemptId: `a1-${stamp}`, paymentResolution: "not_required" }),
    ]);
    expect(again.map((row) => row.return_id)).toEqual([first.return_id, first.return_id]);
    expect((await inv(supInv)).onHand).toBe(1);

    // Una devolución mayor a lo entregado y no devuelto se rechaza (queda 1 de 2).
    order = await refreshLocal(orderId);
    await expectAsync(returns.registerReturn({
      order, item: order.items.find((row) => row.item_id === "sup-1")!, qty: 2, disposition: "available", attemptId: `a9-${stamp}`, paymentResolution: "not_required",
    })).toBeRejectedWithError(/Sólo quedan 1/);
    expect((await inv(supInv)).onHand).toBe(1);

    // 8. Devolución de todas las unidades (la restante de proveedor + la propia).
    order = await refreshLocal(orderId);
    await returns.registerReturn({ order, item: order.items.find((row) => row.item_id === "sup-1")!, qty: 1, disposition: "available", attemptId: `a2-${stamp}`, paymentResolution: "not_required" });
    order = await refreshLocal(orderId);
    await returns.registerReturn({ order, item: order.items.find((row) => row.item_id === "own-1")!, qty: 1, disposition: "available", attemptId: `a3-${stamp}`, paymentResolution: "not_required" });
    expect((await inv(supInv)).onHand).toBe(2);
    expect((await inv(ownInv)).onHand).toBe(3);
    const finalOrder = (await getDoc(doc(FIRESTORE, "orders", orderId))).data() as Record<string, any>;
    expect(finalOrder["status"]).toBe("devuelto");

    // Ya no queda nada por devolver: se rechaza (pedido devuelto o sin piezas).
    order = await refreshLocal(orderId);
    await expectAsync(returns.registerReturn({
      order, item: order.items.find((row) => row.item_id === "own-1")!, qty: 1, disposition: "available", attemptId: `a4-${stamp}`, paymentResolution: "not_required",
    })).toBeRejected();

    // 18. El inventario físico no se duplica.
    await expectInvariants(supInv);
    await expectInvariants(ownInv);
  });

  it("6, 17: entrega por caja parcial y mismo SKU reservado por varios pedidos", async () => {
    const shared = `inv-shared-${stamp}`;
    await seedInventory(shared, 6);
    const orderA = `PA-${stamp}`;
    const orderB = `PB-${stamp}`;
    await seedOrder(orderA, {
      status: "en_ruta",
      items: [item("a-1", { source: "inventario", inventory_id: shared, quantity: 3, confirmed_qty: 3 })],
      packages: [
        { package_id: "box-1", label: "Caja 1", state: "cerrado", item_ids: ["a-1"], items: [{ orderItemId: "a-1", qty: 2 }] },
        { package_id: "box-2", label: "Caja 2", state: "cerrado", item_ids: ["a-1"], items: [{ orderItemId: "a-1", qty: 1 }] },
      ],
    });
    await seedOrder(orderB, {
      status: "recibido_qa",
      items: [item("b-1", { source: "inventario", inventory_id: shared, quantity: 2, confirmed_qty: 2 })],
    });
    await inventory.reserveStock({ sku: shared, qty: 3, orderId: orderA, orderItemId: "a-1", idempotencyKey: `r_${orderA}`, allocation: { source: "own_stock" } });
    await inventory.reserveStock({ sku: shared, qty: 2, orderId: orderB, orderItemId: "b-1", idempotencyKey: `r_${orderB}`, allocation: { source: "own_stock" } });

    // 6. Entrega parcial soportada: caja 1 (2 piezas). Después, la entrega completa solo descuenta 1 más.
    await refreshLocal(orderA);
    await timed("deliver_package", () => orders.consumeInventoryForDelivery(orderA, "box-1"));
    expect((await inv(shared)).onHand).toBe(4);
    expect((await alloc(orderA, "a-1", shared))?.["delivered_qty"]).toBe(2);
    await refreshLocal(orderA);
    await orders.markOrderDelivered(orderA);
    let state = await inv(shared);
    expect(state.onHand).withContext("entrega por caja + completa = 3, no 5").toBe(3);
    expect(state.reservations[orderB]?.qty).withContext("la reserva del otro pedido queda intacta").toBe(2);

    // 17. Pedido B con una línea inflada (pide 4 aunque solo apartó 2): nunca toma piezas ajenas.
    await updateDoc(doc(FIRESTORE, "orders", orderB), { items: [item("b-1", { source: "inventario", inventory_id: shared, quantity: 4, confirmed_qty: 4 })] });
    await refreshLocal(orderB);
    const res = await orders.markOrderDelivered(orderB);
    expect(res.shortfall).withContext("faltante registrado, no tomado de otro pedido ni de disponible").toBe(2);
    state = await inv(shared);
    expect(state.onHand).toBe(1);
    expect(state.available).toBe(1);
    expect(state.reserved).toBe(0);
    const events = await getDocs(collection(FIRESTORE, "orders", orderB, "events"));
    expect(events.docs.some((entry) => entry.data()["type"] === "INVENTORY_DELIVERY_SHORTFALL")).toBeTrue();

    // Caja sin cantidades repartida entre cajas: se bloquea antes de escribir.
    const orderC = `PC-${stamp}`;
    await seedOrder(orderC, {
      status: "en_ruta",
      items: [item("c-1", { source: "inventario", inventory_id: shared, quantity: 1, confirmed_qty: 1 })],
      packages: [
        { package_id: "x", label: "X", state: "cerrado", item_ids: ["c-1"], items: [] },
        { package_id: "y", label: "Y", state: "cerrado", item_ids: ["c-1"], items: [] },
      ],
    });
    await expectAsync(orders.consumeInventoryForDelivery(orderC, "x")).toBeRejectedWith(jasmine.any(PackageDeliveryEvidenceError));
    expect((await inv(shared)).onHand).toBe(1);
    await expectInvariants(shared);
  });

  it("11: dos sesiones concurrentes no pierden ni duplican cantidades", async () => {
    const lastUnit = `inv-last-${stamp}`;
    await seedInventory(lastUnit, 1);
    // Dos pedidos intentan apartar la última pieza a la vez: solo uno gana.
    const results = await Promise.allSettled([
      inventory.reserveStock({ sku: lastUnit, qty: 1, orderId: `PX-${stamp}`, orderItemId: "x-1", idempotencyKey: `rx_${stamp}`, allocation: { source: "own_stock" } }),
      inventory.reserveStock({ sku: lastUnit, qty: 1, orderId: `PY-${stamp}`, orderItemId: "y-1", idempotencyKey: `ry_${stamp}`, allocation: { source: "own_stock" } }),
    ]);
    expect(results.filter((row) => row.status === "fulfilled").length).toBe(1);
    const rejected = results.find((row) => row.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason instanceof InventoryStockInsufficientError).toBeTrue();
    const state = await inv(lastUnit);
    expect(state.reserved).toBe(1);
    expect(state.available).toBe(0);

    // Dos empleados devuelven la última pieza entregada con intentos distintos: una gana.
    const winner = results[0].status === "fulfilled" ? `PX-${stamp}` : `PY-${stamp}`;
    const winnerItem = winner.startsWith("PX") ? "x-1" : "y-1";
    await seedOrder(winner, { status: "recibido_qa", items: [item(winnerItem, { source: "inventario", inventory_id: lastUnit })] });
    await orders.markOrderDelivered(winner);
    const order = await refreshLocal(winner);
    const line = order.items[0];
    const concurrent = await Promise.allSettled([
      returns.registerReturn({ order, item: line, qty: 1, disposition: "available", attemptId: `s1-${stamp}`, paymentResolution: "not_required" }),
      returns.registerReturn({ order, item: line, qty: 1, disposition: "available", attemptId: `s2-${stamp}`, paymentResolution: "not_required" }),
    ]);
    expect(concurrent.filter((row) => row.status === "fulfilled").length).toBe(1);
    expect((await inv(lastUnit)).onHand).withContext("una sola pieza física reincorporada").toBe(1);
    await expectInvariants(lastUnit);
  });

  it("13, 14: devolución dañada y reventa de una pieza devuelta", async () => {
    const invId = `inv-resale-${stamp}`;
    await seedInventory(invId, 2);
    const first = `PR1-${stamp}`;
    await seedOrder(first, { status: "recibido_qa", items: [item("r-1", { source: "inventario", inventory_id: invId, quantity: 2, confirmed_qty: 2 })] });
    await inventory.reserveStock({ sku: invId, qty: 2, orderId: first, orderItemId: "r-1", idempotencyKey: `rr_${first}`, allocation: { source: "own_stock" } });
    await orders.markOrderDelivered(first);
    let order = await refreshLocal(first);
    // 13. Una dañada: entra a existencia como dañada, no disponible.
    await returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "damaged", attemptId: `d-${stamp}`, paymentResolution: "not_required" });
    let state = await inv(invId);
    expect(state.onHand).toBe(1);
    expect(state.damaged).toBe(1);
    expect(state.available).toBe(0);
    // 12/14. Otra disponible y se revende a un pedido nuevo.
    order = await refreshLocal(first);
    await returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "available", attemptId: `ok-${stamp}`, paymentResolution: "not_required" });
    state = await inv(invId);
    expect(state.available).toBe(1);
    const resale = `PR2-${stamp}`;
    await seedOrder(resale, { status: "recibido_qa", items: [item("s-1", { source: "inventario", inventory_id: invId })] });
    await inventory.reserveStock({ sku: invId, qty: 1, orderId: resale, orderItemId: "s-1", idempotencyKey: `rs_${resale}`, allocation: { source: "own_stock" } });
    // La pieza dañada no se puede apartar.
    await expectAsync(inventory.reserveStock({ sku: invId, qty: 1, orderId: `PR3-${stamp}`, orderItemId: "z", idempotencyKey: `rz_${stamp}` }))
      .toBeRejectedWith(jasmine.any(InventoryStockInsufficientError));
    await orders.markOrderDelivered(resale);
    state = await inv(invId);
    expect(state.onHand).withContext("solo queda la dañada").toBe(1);
    expect(state.available).toBe(0);
    expect((await alloc(resale, "s-1", invId))?.["delivered_qty"]).toBe(1);
    await expectInvariants(invId);
  });

  it("15: fallo entre guardar la entrega y ajustar inventario se recupera sin duplicar", async () => {
    const invId = `inv-fail-${stamp}`;
    await seedInventory(invId, 2);
    const orderId = `PF-${stamp}`;
    await seedOrder(orderId, { status: "recibido_qa", items: [item("f-1", { source: "inventario", inventory_id: invId, quantity: 2, confirmed_qty: 2 })] });
    await inventory.reserveStock({ sku: invId, qty: 2, orderId, orderItemId: "f-1", idempotencyKey: `rf_${orderId}`, allocation: { source: "own_stock" } });
    const spy = spyOn(inventory, "consumeOnDelivery").and.callFake(() => Promise.reject(new Error("unavailable: sin conexión")));
    const result = await orders.markOrderDelivered(orderId);
    expect(result.ok).toBeFalse();
    const savedOrder = (await getDoc(doc(FIRESTORE, "orders", orderId))).data() as Record<string, any>;
    expect(savedOrder["delivered_at"]).withContext("la entrega quedó guardada").toBeTruthy();
    expect((await inv(invId)).onHand).toBe(2);
    const events = await getDocs(collection(FIRESTORE, "orders", orderId, "events"));
    expect(events.docs.some((entry) => entry.data()["type"] === "INVENTORY_DELIVERY_SYNC_FAILED")).toBeTrue();
    spy.and.callThrough();
    const retry = await orders.retryDeliveryInventorySync(orderId);
    expect(retry.ok).toBeTrue();
    await orders.retryDeliveryInventorySync(orderId);
    expect((await inv(invId)).onHand).withContext("reintentos no descuentan dos veces").toBe(0);
    await expectInvariants(invId);

    // Recepción atómica: si la reserva no cabe, tampoco entra la mercancía (nada a medias).
    const tight = `inv-tight-${stamp}`;
    await seedInventory(tight, 0);
    await expectAsync(inventory.receiveInbound({
      sku: tight, qty: 1, supplierOperationId: "op-x", lineId: "l", idempotencyKey: `in_${stamp}`,
      reserveFor: { orderId: `PT-${stamp}`, orderItemId: "t", qty: 2, idempotencyKey: `rv_${stamp}` },
    })).toBeRejectedWith(jasmine.any(InventoryStockInsufficientError));
    expect((await inv(tight)).onHand).toBe(0);
  });

  it("16: pedidos sin entrega comprobada o sin evidencia no crean existencias ficticias", async () => {
    // Pedido anterior (sin asignaciones) cobrado sin entrega, con reserva viva: caso María Zara.
    const frodam = `inv-legacy-${stamp}`;
    const legacyOrder = `PL-${stamp}`;
    await seedInventory(frodam, 3, {
      reservations: { [legacyOrder]: { qty: 1, order_number: legacyOrder, status: "reserved", updated_at: new Date().toISOString() } },
    });
    await setDoc(doc(FIRESTORE, "supplier_operations", `op-${legacyOrder}-l-1`), {
      op_id: `op-${legacyOrder}-l-1`, business_id: "bm", order_id: legacyOrder, reserved_for_order_id: legacyOrder,
      order_item_id: "l-1", supplier_id: "sup", status: "recibido", inventory_item_id: frodam, quantity: 1,
      received_to_inventory: true, reservation_applied: true, received_qty: 1, reserved_qty_for_order: 1,
    });
    let order = await seedOrder(legacyOrder, {
      status: "pagado",
      items: [item("l-1", { source: "catalogo", supplier_id: "sup", inventory_id: null })],
    });
    const released = await returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "available", attemptId: `l-${stamp}`, paymentResolution: "not_required" });
    expect(released.inventory_legs).toEqual([{ inventory_id: frodam, kind: "release_reserved", qty: 1 }]);
    expect(released.inventory_resolution).toBe("legacy_evidence");
    const state = await inv(frodam);
    expect(state.onHand).withContext("la pieza nunca salió: no se suma existencia").toBe(3);
    expect(state.reserved).withContext("sin reserva fantasma").toBe(0);
    expect(state.available).toBe(3);
    expect(await alloc(legacyOrder, "l-1", frodam)).withContext("no se inventa asignación para el histórico").toBeNull();

    // Pedido antiguo entregado sin ninguna evidencia de inventario: se bloquea y se ofrece registrar sin ingreso.
    const ambiguous = `PZ-${stamp}`;
    order = await seedOrder(ambiguous, {
      status: "pagado",
      delivered_at: new Date().toISOString(),
      items: [item("z-1", { source: "catalogo", supplier_id: "sup", inventory_id: null })],
    });
    await expectAsync(returns.registerReturn({ order, item: order.items[0], qty: 1, disposition: "available", attemptId: `z-${stamp}`, paymentResolution: "not_required" }))
      .toBeRejectedWith(jasmine.any(ReturnInventoryUnverifiedError));
    const held = await returns.registerReturn({
      order, item: order.items[0], qty: 1, disposition: "available", attemptId: `z-${stamp}`, paymentResolution: "not_required", inventoryMode: "hold_unverified",
    });
    expect(held.status).toBe("inventory_unverified");
    expect(held.inventory_id).toBeNull();
    const movements = await getDocs(query(collection(FIRESTORE, "inventory_movements"), where("order_id", "==", ambiguous)));
    expect(movements.size).withContext("sin movimientos de inventario por suposición").toBe(0);
    // Resolución supervisada tras conteo físico, idempotente.
    await returns.resolveUnverifiedReturn(held, "restock_after_count");
    await returns.resolveUnverifiedReturn(held, "restock_after_count");
    const counted = await getDocs(query(collection(FIRESTORE, "inventory_movements"), where("return_id", "==", held.return_id)));
    expect(counted.size).toBe(1);
    await expectInvariants(frodam);
  });
});
