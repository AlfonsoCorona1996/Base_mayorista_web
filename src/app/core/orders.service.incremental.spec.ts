import { WritableSignal, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService } from "./inventory.service";
import { compareOrdersForList } from "./orders-snapshot-index";
import { FakeOrderDoc, FakeOrdersListener, FakeOrdersSource, fakeTimestamp } from "./orders-snapshot.fake";
import { ORDERS_SNAPSHOT_SOURCE, Order, OrdersService } from "./orders.service";
import { PerfMetricEntry, PerfMetricsService } from "./perf-metrics.service";
import { BusinessId } from "./rbac.constants";
import { SupplierOperationsService } from "./supplier-operations.service";

const T0 = "2026-10-15T12:00:00.000Z";

function orderData(index: number, updatedAt: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const total = 100 + index * 10;
  return {
    business_id: index % 3 === 0 ? "catalogo" : "bm",
    customer_id: `c-${index % 7}`,
    route_id: index % 2 ? "r-1" : null,
    status: ["borrador", "empaque", "entregado", "pagado", "delivered"][index % 5],
    created_at: fakeTimestamp(`2026-09-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`),
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    items: [{ item_id: `i-${index}`, title: "Producto", quantity: 1 + (index % 3), price_clienta: total, state: "borrador", source: "manual" }],
    packages: [{ package_id: `pk-${index}`, label: "Caja 1", sequence: 1, total_packages: 1, status: "closed", amount_due: null, item_ids: [] }],
    timeline: [],
    totals: { total_amount: total, paid_amount: index % 4 === 0 ? total : 0, balance_due: index % 4 === 0 ? 0 : total },
    ...extra,
  };
}

function orderId(index: number): string {
  return `P-261015-${String(index).padStart(4, "0")}`;
}

function serverTime(minute: number): ReturnType<typeof fakeTimestamp> {
  return fakeTimestamp(new Date(Date.UTC(2026, 9, 15, 9, 0) + minute * 60_000).toISOString());
}

/** Estado de la colección en "Firestore". Cada `emit` entrega el resultado completo de la consulta. */
class World {
  readonly docs = new Map<string, FakeOrderDoc>();

  set(id: string, data: Record<string, unknown>, pending = false): void {
    this.docs.set(id, { id, data, pending });
  }

  patch(id: string, patch: Record<string, unknown>, pending = false): void {
    const current = this.docs.get(id);
    if (!current) throw new Error(`no existe ${id}`);
    this.set(id, { ...current.data, ...patch }, pending);
  }

  confirm(id: string, patch: Record<string, unknown> = {}): void {
    this.patch(id, patch, false);
  }

  remove(id: string): void {
    this.docs.delete(id);
  }

  emit(listener: FakeOrdersListener, fromCache = false) {
    return listener.emit([...this.docs.values()], { fromCache });
  }
}

/** Mulberry32: secuencia pseudoaleatoria reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("OrdersService - snapshots incrementales (R2)", () => {
  let service: OrdersService;
  let source: FakeOrdersSource;
  let available: WritableSignal<BusinessId[]>;
  let active: WritableSignal<BusinessId[]>;
  let world: World;

  function setup(options: { perf?: boolean } = {}): void {
    if (options.perf) window.localStorage.setItem("bm.perf-metrics", "1");
    source = new FakeOrdersSource();
    available = signal<BusinessId[]>(["bm", "catalogo"]);
    active = signal<BusinessId[]>(["bm", "catalogo"]);
    world = new World();
    spyOn(console, "error");
    spyOn(console, "info");
    TestBed.configureTestingModule({
      providers: [
        OrdersService,
        { provide: ORDERS_SNAPSHOT_SOURCE, useValue: source },
        { provide: BusinessScopeService, useValue: { availableBusinessIds: available, activeBusinessIds: active } },
        { provide: SupplierOperationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: UserAdminApiService, useValue: {} },
      ],
    });
    service = TestBed.inject(OrdersService);
  }

  /** Normalización completa de referencia: la de antes (todos los documentos) con el mismo valor provisional. */
  function fullNormalization(fallbackIso = T0): Order[] {
    return [...world.docs.values()]
      .map((doc) => service["normalize"](doc.id, structuredCloneData(doc.data), fallbackIso))
      .sort(compareOrdersForList);
  }

  async function start(count: number, fromCache = false): Promise<FakeOrdersListener> {
    for (let index = 0; index < count; index++) world.set(orderId(index), orderData(index, serverTime(index)));
    const load = service.loadFromFirestore();
    const listener = source.listeners[source.listeners.length - 1];
    world.emit(listener, fromCache);
    await load;
    listener.resetDataCalls();
    return listener;
  }

  function byId(id: string): Order {
    const order = service.list().find((entry) => entry.order_id === id);
    if (!order) throw new Error(`no está ${id}`);
    return order;
  }

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(T0));
  });

  afterEach(() => {
    jasmine.clock().uninstall();
    window.localStorage.removeItem("bm.perf-metrics");
    delete (window as unknown as { bmPerf?: unknown }).bmPerf;
  });

  it("primer snapshot: construye el estado completo, normalizado y ordenado", async () => {
    setup();
    for (let index = 0; index < 12; index++) world.set(orderId(index), orderData(index, serverTime(index)));
    const load = service.loadFromFirestore();
    world.emit(source.listeners[0]);
    await load;

    expect(source.listeners[0].dataCalls).withContext("un data() por documento").toBe(12);
    expect(service.list()).toEqual(fullNormalization());
    expect(service.list()[0].order_id).toBe(orderId(11));
    expect(byId(orderId(4)).status).withContext("traduce estados legados como antes").toBe("entregado");
    expect(byId(orderId(1)).packages[0].state).toBe("closed");
  });

  it("alta de pedido: convierte solo el documento nuevo y conserva los demás objetos", async () => {
    setup();
    const listener = await start(20);
    const before = new Map(service.list().map((order) => [order.order_id, order]));

    world.set(orderId(99), orderData(99, serverTime(500)));
    world.emit(listener);

    expect(listener.dataCalls).toBe(1);
    expect(service.list()[0].order_id).toBe(orderId(99));
    expect(service.list().length).toBe(21);
    for (const order of service.list().slice(1)) expect(order).toBe(before.get(order.order_id)!);
    expect(service.list()).toEqual(fullNormalization());
  });

  it("cambio de pedido: reemplaza solo el modificado, con sus totales y estado nuevos", async () => {
    setup();
    const listener = await start(20);
    const untouched = byId(orderId(3));

    world.patch(orderId(5), { status: "pagado", totals: { total_amount: 150, paid_amount: 150, balance_due: 0 }, updated_at: serverTime(600) });
    world.emit(listener);

    expect(listener.dataCalls).toBe(1);
    expect(byId(orderId(5)).status).toBe("pagado");
    expect(byId(orderId(5)).totals.balance_due).toBe(0);
    expect(byId(orderId(5)).customer_payment_status).toBe("collected");
    expect(byId(orderId(3))).toBe(untouched);
    expect(service.list()).toEqual(fullNormalization());
  });

  it("eliminación de pedido: lo quita sin convertir ningún documento", async () => {
    setup();
    const listener = await start(20);

    world.remove(orderId(7));
    world.emit(listener);

    expect(listener.dataCalls).toBe(0);
    expect(service.list().some((order) => order.order_id === orderId(7))).toBeFalse();
    expect(service.list()).toEqual(fullNormalization());
  });

  it("varias modificaciones sucesivas (aleatorias, con semilla) equivalen siempre a la normalización completa", async () => {
    setup();
    const listener = await start(60);
    const next = random(20261015);
    let nextIndex = 1000;
    const pick = () => {
      const ids = [...world.docs.keys()];
      return ids[Math.floor(next() * ids.length)];
    };
    // Pocas fechas distintas para forzar empates; a veces ausente o pendiente.
    const updatedAt = () => {
      const roll = next();
      if (roll < 0.1) return undefined;
      if (roll < 0.2) return null;
      return serverTime(Math.floor(next() * 40));
    };

    for (let step = 0; step < 300; step++) {
      const changed = new Set<string>();
      const operations = 1 + Math.floor(next() * 5);
      for (let op = 0; op < operations; op++) {
        const roll = next();
        if (roll < 0.2 || world.docs.size < 5) {
          const id = orderId(nextIndex++);
          world.set(id, orderData(nextIndex, updatedAt()), next() < 0.3);
          changed.add(id);
        } else if (roll < 0.3) {
          const id = pick();
          world.remove(id);
          changed.delete(id);
        } else if (roll < 0.4) {
          // Solo metadata: misma información, cambia la marca de pendiente.
          const id = pick();
          const doc = world.docs.get(id)!;
          world.set(id, doc.data, !doc.pending);
        } else {
          const id = pick();
          const value = updatedAt();
          world.patch(id, {
            status: ["empaque", "pagado", "entregado", "cancelado"][Math.floor(next() * 4)],
            totals: { total_amount: 200, paid_amount: Math.round(next() * 200), balance_due: Math.round(next() * 200) },
            ...(value === undefined ? { updated_at: undefined } : { updated_at: value }),
          }, value === null);
          changed.add(id);
        }
      }
      listener.resetDataCalls();
      world.emit(listener, next() < 0.2);

      expect(service.list()).withContext(`paso ${step}`).toEqual(fullNormalization());
      for (const id of listener.dataCallsById.keys()) {
        expect(changed.has(id)).withContext(`paso ${step}: ${id} no cambió y se convirtió`).toBeTrue();
      }
    }
  });

  it("escritura local pendiente: updated_at provisional estable, que no se re-estampa con snapshots ajenos", async () => {
    setup();
    const listener = await start(10);
    const first = orderId(2);

    // Snapshot local de updateDoc(..., { updated_at: serverTimestamp() }): el campo llega como null.
    world.patch(first, { status: "empaque", updated_at: null }, true);
    world.emit(listener);
    const provisional = byId(first);
    expect(provisional.updated_at).toBe(T0);
    expect(provisional.status).toBe("empaque");
    expect(service.list()[0]).withContext("la escritura local se ve arriba de inmediato").toBe(provisional);

    // Llega otro cambio mientras la confirmación sigue pendiente.
    jasmine.clock().tick(5_000);
    world.patch(orderId(4), { notes: "remoto", updated_at: fakeTimestamp("2026-10-15T12:00:03.000Z") });
    world.emit(listener);

    expect(byId(first)).withContext("el pedido pendiente no se vuelve a convertir").toBe(provisional);
    expect(byId(first).updated_at).toBe(T0);
    expect(service.list().slice(0, 2).map((order) => order.order_id)).toEqual([orderId(4), first]);
  });

  it("confirmación de serverTimestamp: el valor del servidor reemplaza al provisional y reordena", async () => {
    setup();
    const listener = await start(10);
    const id = orderId(1);

    world.patch(id, { updated_at: null }, true);
    world.emit(listener);
    expect(byId(id).updated_at).toBe(T0);

    // Confirmación: Firestore resuelve el timestamp; es un cambio de datos real.
    world.confirm(id, { updated_at: fakeTimestamp("2026-10-15T11:59:59.500Z") });
    world.emit(listener);

    expect(listener.dataCallsById.get(id)).toBe(2);
    expect(listener.dataCalls).toBe(2);
    expect(byId(id).updated_at).toBe("2026-10-15T11:59:59.500Z");
    expect(service.list()[0].order_id).toBe(id);
    expect(service.syncState()).toBe("server");
    expect(service.list()).toEqual(fullNormalization());
  });

  it("ausencia de updated_at: mismo valor provisional en todo el snapshot, desempate por order_id y sin re-estampar", async () => {
    setup();
    world.set(orderId(1), orderData(1, undefined));
    world.set(orderId(2), orderData(2, undefined));
    world.set(orderId(3), orderData(3, serverTime(30)));
    const load = service.loadFromFirestore();
    const listener = source.listeners[0];
    world.emit(listener);
    await load;

    const legacy = [byId(orderId(1)), byId(orderId(2))];
    expect(legacy.map((order) => order.updated_at)).toEqual([T0, T0]);
    expect(service.list().map((order) => order.order_id)).toEqual([orderId(2), orderId(1), orderId(3)]);

    // Una hora después cambia otro pedido: los legados conservan su valor y objeto.
    jasmine.clock().tick(3_600_000);
    world.patch(orderId(3), { updated_at: fakeTimestamp("2026-10-15T12:30:00.000Z") });
    world.emit(listener);

    expect(byId(orderId(1))).toBe(legacy[0]);
    expect(byId(orderId(2)).updated_at).toBe(T0);
    expect(service.list()[0].order_id).toBe(orderId(3));
    // Sin escrituras: el índice no inventa valores que luego se guarden.
    expect(world.docs.get(orderId(1))!.data["updated_at"]).toBeUndefined();
  });

  it("cambios de ordenamiento: coincide con el comparador histórico cuando las fechas son distintas", async () => {
    setup();
    const listener = await start(40);
    const historical = (a: Order, b: Order) => (a.updated_at > b.updated_at ? -1 : 1);
    const next = random(7);

    for (let step = 0; step < 60; step++) {
      world.patch(orderId(Math.floor(next() * 40)), { updated_at: serverTime(100 + step) });
      world.emit(listener);
      const expected = [...service.list()].sort(historical).map((order) => order.order_id);
      expect(service.list().map((order) => order.order_id)).withContext(`paso ${step}`).toEqual(expected);
    }
    expect(service.list()[0].updated_at).toBe(serverTime(159).toDate().toISOString());
  });

  it("negocio activo: filtrar no convierte documentos ni cambia los objetos", async () => {
    setup();
    const listener = await start(12);
    const all = service.list();

    active.set(["bm"]);
    expect(service.list().every((order) => order.business_id === "bm")).toBeTrue();
    expect(service.list().length).toBe(all.filter((order) => order.business_id === "bm").length);

    active.set(["bm", "catalogo"]);
    expect(service.list()).toEqual(all);
    service.list().forEach((order, index) => expect(order).toBe(all[index]));
    expect(listener.dataCalls).toBe(0);
  });

  it("negocios autorizados: al reabrir el listener se reconstruye desde cero con los negocios nuevos", async () => {
    setup();
    available.set(["bm"]);
    active.set(["bm"]);
    await start(6);
    const oldOrder = service.list()[0];

    available.set(["bm", "catalogo"]);
    active.set(["bm", "catalogo"]);
    service.stopListening();
    const reload = service.loadFromFirestore();
    const second = source.listeners[1];
    expect(second.businessIds).toEqual(["bm", "catalogo"]);
    world.set(orderId(50), orderData(51, serverTime(900), { business_id: "catalogo" }));
    world.emit(second);
    await reload;

    expect(second.dataCalls).withContext("estado completo del listener nuevo").toBe(7);
    expect(service.list()).toEqual(fullNormalization());
    expect(service.list().some((order) => order === oldOrder)).toBeFalse();
  });

  it("reconexión de Firestore: metadata sin conversión y luego solo las diferencias acumuladas", async () => {
    setup();
    const listener = await start(15);
    const rows = service.list();

    // Sin red: el SDK reemite los mismos datos marcados como caché.
    world.emit(listener, true);
    expect(service.syncState()).toBe("cache");
    expect(service.list()).toBe(rows);
    expect(listener.dataCalls).toBe(0);

    // Al reconectar llegan juntos los cambios hechos por otros mientras tanto.
    world.patch(orderId(2), { status: "entregado", updated_at: serverTime(700) });
    world.remove(orderId(9));
    world.set(orderId(77), orderData(77, serverTime(701)));
    world.emit(listener);

    expect(service.syncState()).toBe("server");
    expect(listener.dataCalls).toBe(2);
    expect(service.list()).toEqual(fullNormalization());
  });

  it("reemplazo y cierre del listener: el nuevo no hereda el índice anterior y el viejo no publica", async () => {
    setup();
    const first = await start(10);
    service.stopListening();
    expect(first.unsubscribed).toBeTrue();

    const reload = service.loadFromFirestore();
    const second = source.listeners[1];
    second.emit([{ id: orderId(1), data: orderData(1, serverTime(1)) }]);
    await reload;
    expect(service.list().map((order) => order.order_id)).toEqual([orderId(1)]);

    // Un callback tardío del listener cerrado no toca el estado.
    world.patch(orderId(3), { updated_at: serverTime(999) });
    world.emit(first);
    expect(service.list().map((order) => order.order_id)).toEqual([orderId(1)]);

    // El nuevo sigue siendo incremental sobre su propio estado.
    second.resetDataCalls();
    second.emit([{ id: orderId(1), data: orderData(1, serverTime(1)) }, { id: orderId(2), data: orderData(2, serverTime(2)) }]);
    expect(second.dataCalls).toBe(1);
    expect(service.list().length).toBe(2);
  });

  it("snapshot solo de metadata: no convierte documentos ni publica una lista nueva", async () => {
    setup();
    const listener = await start(25, true);
    const rows = service.list();
    expect(service.syncState()).toBe("cache");

    const event = world.emit(listener);
    expect(event.changes.length).toBe(0);
    expect(listener.dataCalls).toBe(0);
    expect(service.list()).toBe(rows);
    expect(service.syncState()).toBe("server");
  });

  it("reutilización: tras muchas modificaciones de un pedido, los demás siguen siendo el mismo objeto", async () => {
    setup();
    const listener = await start(30);
    const before = new Map(service.list().map((order) => [order.order_id, order]));

    for (let step = 0; step < 10; step++) {
      world.patch(orderId(8), { notes: `cambio ${step}`, updated_at: serverTime(300 + step) });
      world.emit(listener);
    }

    expect(listener.dataCalls).toBe(10);
    for (const order of service.list()) {
      if (order.order_id === orderId(8)) expect(order).not.toBe(before.get(order.order_id)!);
      else expect(order).toBe(before.get(order.order_id)!);
    }
  });

  it("compatibilidad: búsquedas, filtros y totales iguales a los de la normalización completa", async () => {
    setup();
    const listener = await start(80);
    const next = random(99);
    for (let step = 0; step < 40; step++) {
      const id = orderId(Math.floor(next() * 80));
      if (!world.docs.has(id)) continue;
      if (next() < 0.15) world.remove(id);
      else world.patch(id, { totals: { total_amount: 300, paid_amount: Math.round(next() * 300), balance_due: Math.round(next() * 300) }, updated_at: serverTime(400 + step) });
      world.emit(listener);
    }
    const reference = fullNormalization();
    const view = (orders: Order[]) => ({
      balance: orders.reduce((sum, order) => sum + order.totals.balance_due, 0),
      paid: orders.reduce((sum, order) => sum + order.totals.paid_amount, 0),
      byStatus: orders.reduce<Record<string, number>>((acc, order) => ({ ...acc, [order.status]: (acc[order.status] ?? 0) + 1 }), {}),
      customer: orders.filter((order) => order.customer_id.includes("c-3")).map((order) => order.order_id),
      route: orders.filter((order) => order.route_id === "r-1").map((order) => order.order_id),
      bm: orders.filter((order) => order.business_id === "bm").map((order) => order.order_id),
      collected: orders.filter((order) => order.customer_payment_status === "collected").length,
    });

    expect(view(service.list())).toEqual(view(reference));
    active.set(["bm"]);
    expect(view(service.list())).toEqual(view(reference.filter((order) => order.business_id === "bm")));
  });

  it("acción masiva sobre 5 pedidos: escrituras locales y confirmaciones convierten un documento por snapshot", async () => {
    setup();
    const listener = await start(40);
    const targets = [10, 11, 12, 13, 14].map(orderId);
    // El servidor estampa la hora actual; el reloj avanza entre escrituras.
    const serverNow = () => fakeTimestamp(new Date().toISOString());
    const emitAndCount = (label: string) => {
      listener.resetDataCalls();
      world.emit(listener);
      expect(listener.dataCalls).withContext(label).toBe(1);
    };

    for (const id of targets) {
      const total = byId(id).totals.total_amount;
      // Transacción de pago: sin compensación local, llega ya confirmada.
      jasmine.clock().tick(1_000);
      world.confirm(id, { totals: { total_amount: total, paid_amount: total, balance_due: 0 }, status: "pagado", updated_at: serverNow() });
      emitAndCount(`${id} transacción`);
      // logEvent: snapshot local con serverTimestamp() pendiente y luego su confirmación.
      jasmine.clock().tick(1_000);
      world.patch(id, { last_event_at: null, updated_at: null }, true);
      emitAndCount(`${id} local`);
      expect(service.list()[0].order_id).toBe(id);
      jasmine.clock().tick(300);
      world.confirm(id, { last_event_at: serverNow(), updated_at: serverNow() });
      emitAndCount(`${id} confirmación`);
    }

    expect(service.list()).toEqual(fullNormalization());
    expect(service.list().slice(0, 5).map((order) => order.order_id)).toEqual([...targets].reverse());
    for (const id of targets) {
      expect(byId(id).totals.balance_due).toBe(0);
      expect(byId(id).customer_payment_status).toBe("collected");
    }
  });

  it("las actualizaciones optimistas se reemplazan con el siguiente snapshot, como antes", async () => {
    setup();
    const listener = await start(10);
    const target = byId(orderId(4));

    service["rows"].update((rows) => rows.map((order) => (order.order_id === target.order_id ? { ...order, status: "pagado" as const } : order)));
    expect(byId(orderId(4)).status).toBe("pagado");

    world.patch(orderId(6), { updated_at: serverTime(950) });
    world.emit(listener);
    expect(byId(orderId(4))).toBe(target);
    expect(service.list()).toEqual(fullNormalization());
  });

  it("si los cambios no cuadran con el tamaño del resultado, reconstruye todo (resync)", async () => {
    setup({ perf: true });
    const listener = await start(5);
    const docs = [...world.docs.values()].map((doc) => ({ id: doc.id, data: () => structuredCloneData(doc.data) }));
    const extra = { id: orderId(60), data: () => orderData(60, serverTime(60)) };

    // Evento inconsistente: el resultado tiene 6 documentos, pero los cambios no incluyen el alta.
    listener.next({
      docs: () => [...docs, extra],
      size: 6,
      fromCache: false,
      hasPendingWrites: false,
      changes: [{ type: "modified", doc: docs[0] }],
    });

    expect(service.list().length).toBe(6);
    const entry = TestBed.inject(PerfMetricsService).entries().filter((e) => e.metric === "orders_normalization_ms").pop()!;
    expect(entry.apply_mode).toBe("resync");
  });

  describe("estados de carga y error de FIX 01", () => {
    it("un error tras cambios incrementales conserva lo publicado; el reintento reconstruye y limpia el error", async () => {
      setup();
      const listener = await start(8, true);
      expect(service.syncState()).toBe("cache");
      world.patch(orderId(2), { status: "empaque", updated_at: serverTime(600) });
      world.emit(listener);
      const published = service.list();

      listener.error({ code: "unavailable" });
      expect(service.syncState()).toBe("error");
      expect(service.loadError()).not.toBeNull();
      expect(service.loading()).toBeFalse();
      expect(service.list()).toBe(published);

      const retry = service.loadFromFirestore();
      expect(service.syncState()).toBe("loading");
      expect(service.loadError()).toBeNull();
      expect(service.list()).withContext("mientras reintenta conserva los pedidos").toBe(published);

      const second = source.listeners[1];
      world.emit(second, true);
      await retry;
      expect(second.dataCalls).toBe(8);
      expect(service.loading()).toBeFalse();
      expect(service.syncState()).toBe("cache");
      world.emit(second);
      expect(service.syncState()).toBe("server");
      expect(service.list()).toEqual(fullNormalization());
    });

    it("un snapshot vacío de caché seguido de altas del servidor no se ve como 'sin pedidos' confirmado", async () => {
      setup();
      const load = service.loadFromFirestore();
      const listener = source.listeners[0];
      listener.emit([], { fromCache: true });
      await load;
      expect(service.syncState()).toBe("cache");
      expect(service.list()).toEqual([]);

      world.set(orderId(1), orderData(1, serverTime(1)));
      world.emit(listener);
      expect(service.syncState()).toBe("server");
      expect(service.list().length).toBe(1);
    });
  });

  describe("métricas R1 del listener", () => {
    function orderEntries(): PerfMetricEntry[] {
      return TestBed.inject(PerfMetricsService).entries().filter((entry) => entry.metric === "orders_normalization_ms");
    }

    it("registran conteos, etapas e inferencia separada de lo observable, sin datos personales", async () => {
      setup({ perf: true });
      world.set(orderId(1), orderData(1, serverTime(1)));
      world.set(orderId(2), orderData(2, undefined));
      world.set(orderId(3), orderData(3, serverTime(3)));
      const load = service.loadFromFirestore();
      const listener = source.listeners[0];
      world.emit(listener, true);
      await load;
      world.emit(listener); // metadata: sin medición

      world.patch(orderId(1), { updated_at: null }, true);
      world.emit(listener);
      world.confirm(orderId(1), { updated_at: serverTime(50) });
      world.emit(listener);
      world.patch(orderId(3), { status: "pagado", updated_at: serverTime(51) });
      world.emit(listener);
      world.remove(orderId(2));
      world.emit(listener);

      const entries = orderEntries();
      expect(entries.map((entry) => entry.inferred_cause)).toEqual(["initial", "local_pending", "pending_resolved", "unattributed", "unattributed"]);
      expect(entries.map((entry) => entry.apply_mode)).toEqual(["full", "incremental", "incremental", "incremental", "incremental"]);
      expect(entries.map((entry) => [entry.added, entry.modified, entry.removed])).toEqual([[3, 0, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1]]);
      expect(entries.map((entry) => entry.docs)).toEqual([3, 3, 3, 3, 2]);
      expect(entries[0].updated_at_missing).toBe(1);
      expect(entries[1].updated_at_pending).toBe(1);
      expect(entries[1].pending_docs).toBe(1);
      expect(entries[1].has_pending_writes).toBeTrue();
      expect(entries[1].from_cache).toBeFalse();
      expect(entries[0].from_cache).toBeTrue();
      for (const entry of entries) {
        expect(entry.listener_id).toBe("orders-1");
        expect(entry.navigation_id).toBeNull();
        for (const key of ["convert_ms", "normalize_ms", "index_ms", "sort_ms", "publish_ms"] as const) {
          expect(typeof entry[key]).toBe("number");
        }
        expect(typeof entry.long_task).toBe("boolean");
      }
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain("P-261015");
      expect(serialized).not.toContain("c-");
    });

    it("apagadas: no registran nada ni calculan la inferencia", async () => {
      setup();
      await start(3);
      expect(TestBed.inject(PerfMetricsService).entries()).toEqual([]);
    });
  });
});

describe("compareOrdersForList", () => {
  it("ordena por updated_at descendente y desempata por order_id descendente", () => {
    const rows = [
      { order_id: "P-1", updated_at: "2026-10-01T00:00:00.000Z" },
      { order_id: "P-3", updated_at: "2026-10-02T00:00:00.000Z" },
      { order_id: "P-2", updated_at: "2026-10-02T00:00:00.000Z" },
      { order_id: "P-4", updated_at: "2026-10-02T00:00:00.000Z" },
    ];
    expect([...rows].sort(compareOrdersForList).map((row) => row.order_id)).toEqual(["P-4", "P-3", "P-2", "P-1"]);
    expect([...rows].reverse().sort(compareOrdersForList).map((row) => row.order_id)).toEqual(["P-4", "P-3", "P-2", "P-1"]);
  });
});

function structuredCloneData(data: Record<string, unknown>): Record<string, unknown> {
  const clone = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
      if (typeof (value as { toDate?: unknown }).toDate === "function") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, clone(inner)]));
    }
    return value;
  };
  return clone(data) as Record<string, unknown>;
}
