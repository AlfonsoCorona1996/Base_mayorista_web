import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService } from "./inventory.service";
import { ORDERS_SNAPSHOT_SOURCE, OrdersService, OrdersSnapshotEvent, OrdersSnapshotSource } from "./orders.service";
import { BusinessId } from "./rbac.constants";
import { SupplierOperationsService } from "./supplier-operations.service";

interface FakeListener {
  businessIds: BusinessId[];
  next: (event: OrdersSnapshotEvent) => void;
  error: (error: unknown) => void;
  unsubscribed: boolean;
}

class FakeOrdersSource implements OrdersSnapshotSource {
  listeners: FakeListener[] = [];

  listen(businessIds: BusinessId[], next: FakeListener["next"], error: FakeListener["error"]) {
    const listener: FakeListener = { businessIds, next, error, unsubscribed: false };
    this.listeners.push(listener);
    return () => {
      listener.unsubscribed = true;
    };
  }

  get active(): FakeListener[] {
    return this.listeners.filter((listener) => !listener.unsubscribed);
  }
}

function orderDoc(id: string, businessId: BusinessId = "bm") {
  const data = {
    order_id: id,
    business_id: businessId,
    customer_id: "c-ana",
    status: "borrador",
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: `2026-10-0${id.length % 9 || 1}T10:00:00.000Z`,
    items: [],
    packages: [],
  };
  return { id, data: () => data };
}

function snapshot(ids: string[], fromCache: boolean, changedDocs = ids.length): OrdersSnapshotEvent {
  return { docs: ids.map((id) => orderDoc(id)), fromCache, changedDocs };
}

describe("OrdersService - listener de pedidos: errores, caché y reintentos", () => {
  let service: OrdersService;
  let source: FakeOrdersSource;

  beforeEach(() => {
    source = new FakeOrdersSource();
    spyOn(console, "error");
    TestBed.configureTestingModule({
      providers: [
        OrdersService,
        { provide: ORDERS_SNAPSHOT_SOURCE, useValue: source },
        {
          provide: BusinessScopeService,
          useValue: { availableBusinessIds: signal<BusinessId[]>(["bm"]), activeBusinessIds: signal<BusinessId[]>(["bm"]) },
        },
        { provide: SupplierOperationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: UserAdminApiService, useValue: {} },
      ],
    });
    service = TestBed.inject(OrdersService);
  });

  it("E. un error antes del primer snapshot no se presenta como un listado vacío exitoso", async () => {
    const load = service.loadFromFirestore();
    expect(service.syncState()).toBe("loading");

    source.listeners[0].error({ code: "permission-denied" });
    await expectAsync(load).toBeResolved();

    expect(service.loadError()).not.toBeNull();
    expect(service.syncState()).toBe("error");
    expect(service.loading()).toBeFalse();
  });

  it("E. un error posterior conserva los pedidos ya recibidos", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].next(snapshot(["P-1", "P-22"], false));
    await load;

    source.listeners[0].error({ code: "unavailable" });
    expect(service.syncState()).toBe("error");
    expect(service.list().map((order) => order.order_id).sort()).toEqual(["P-1", "P-22"]);
  });

  it("F. llamadas concurrentes comparten el listener y esperan el primer snapshot", async () => {
    let secondDone = false;
    const first = service.loadFromFirestore();
    const second = service.loadFromFirestore().then(() => (secondDone = true));

    expect(source.listeners.length).toBe(1);
    await Promise.resolve();
    expect(secondDone).withContext("no debe resolver antes de tener datos").toBeFalse();

    source.listeners[0].next(snapshot(["P-1"], false));
    await Promise.all([first, second]);
    expect(secondDone).toBeTrue();

    await service.loadFromFirestore();
    expect(source.listeners.length).toBe(1);
  });

  it("F. reintentar tras un error abre exactamente un listener nuevo", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].error({ code: "unavailable" });
    await load;

    void service.loadFromFirestore();
    void service.loadFromFirestore();
    void service.loadFromFirestore();

    expect(source.listeners.length).toBe(2);
    expect(source.active.length).toBe(1);
    expect(service.loadError()).toBeNull();
    expect(service.syncState()).toBe("loading");
  });

  it("J. un primer snapshot de caché no se confunde con la confirmación del servidor", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].next(snapshot(["P-1"], true));
    await load;

    expect(service.loading()).toBeFalse();
    expect(service.syncState()).toBe("cache");

    const rowsBefore = service.list();
    // Confirmación del servidor sin cambios de datos: solo cambia la metadata.
    source.listeners[0].next(snapshot(["P-1"], false, 0));
    expect(service.syncState()).toBe("server");
    expect(service.list()).withContext("no se re-normaliza todo por un cambio de metadata").toBe(rowsBefore);
  });

  it("J. un snapshot vacío de caché no equivale a 'sin pedidos' confirmado", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].next(snapshot([], true, 0));
    await load;

    expect(service.list()).toEqual([]);
    expect(service.syncState()).toBe("cache");

    source.listeners[0].next(snapshot(["P-1"], false, 1));
    expect(service.syncState()).toBe("server");
    expect(service.list().length).toBe(1);
  });

  it("H. los callbacks de un listener reemplazado no pisan los datos nuevos", async () => {
    const first = service.loadFromFirestore();
    source.listeners[0].next(snapshot(["P-OLD"], false));
    await first;

    service.stopListening();
    const second = service.loadFromFirestore();
    source.listeners[1].next(snapshot(["P-NEW"], false));
    await second;

    source.listeners[0].next(snapshot(["P-OLD", "P-OLD2"], false));
    source.listeners[0].error({ code: "unavailable" });

    expect(service.list().map((order) => order.order_id)).toEqual(["P-NEW"]);
    expect(service.loadError()).toBeNull();
    expect(service.syncState()).toBe("server");
  });

  it("4. tras la confirmación del servidor siguen aplicándose altas, cambios y bajas", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].next(snapshot(["P-1"], true));
    await load;
    source.listeners[0].next(snapshot(["P-1"], false, 0));

    source.listeners[0].next(snapshot(["P-1", "P-22"], false, 1));
    expect(service.list().map((o) => o.order_id).sort()).toEqual(["P-1", "P-22"]);

    source.listeners[0].next(snapshot(["P-22"], false, 1));
    expect(service.list().map((o) => o.order_id)).toEqual(["P-22"]);
  });

  it("4. una escritura local pendiente (aún en caché) se aplica aunque ya hubo servidor", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].next(snapshot(["P-1"], false));
    await load;

    source.listeners[0].next(snapshot(["P-1", "P-NEW"], true, 1));
    expect(service.list().length).toBe(2);
    expect(service.syncState()).toBe("cache");

    // Confirmación de esa escritura sin cambios de datos: se conserva lo aplicado.
    source.listeners[0].next(snapshot(["P-1", "P-NEW"], false, 0));
    expect(service.list().length).toBe(2);
    expect(service.syncState()).toBe("server");
  });

  it("los cambios de datos en tiempo real siguen actualizando el listado", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].next(snapshot(["P-1"], false));
    await load;
    source.listeners[0].next(snapshot(["P-1", "P-22"], false, 1));
    expect(service.list().length).toBe(2);
  });
});
