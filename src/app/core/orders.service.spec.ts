import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService } from "./inventory.service";
import { ORDERS_SNAPSHOT_SOURCE, OrdersService } from "./orders.service";
import { FakeOrderDoc, FakeOrdersSource } from "./orders-snapshot.fake";
import { BusinessId } from "./rbac.constants";
import { SupplierOperationsService } from "./supplier-operations.service";

function orderDoc(id: string, businessId: BusinessId = "bm", pending = false): FakeOrderDoc {
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
  return { id, data, pending };
}

/** Resultado completo de la consulta; el simulador calcula `docChanges()` como Firestore. */
function docs(ids: string[]): FakeOrderDoc[] {
  return ids.map((id) => orderDoc(id));
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
    source.listeners[0].emit(docs(["P-1", "P-22"]));
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

    source.listeners[0].emit(docs(["P-1"]));
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
    source.listeners[0].emit(docs(["P-1"]), { fromCache: true });
    await load;

    expect(service.loading()).toBeFalse();
    expect(service.syncState()).toBe("cache");

    const rowsBefore = service.list();
    // Confirmación del servidor sin cambios de datos: solo cambia la metadata.
    source.listeners[0].emit(docs(["P-1"]));
    expect(service.syncState()).toBe("server");
    expect(service.list()).withContext("no se re-normaliza todo por un cambio de metadata").toBe(rowsBefore);
  });

  it("J. un snapshot vacío de caché no equivale a 'sin pedidos' confirmado", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].emit([], { fromCache: true });
    await load;

    expect(service.list()).toEqual([]);
    expect(service.syncState()).toBe("cache");

    source.listeners[0].emit(docs(["P-1"]));
    expect(service.syncState()).toBe("server");
    expect(service.list().length).toBe(1);
  });

  it("H. los callbacks de un listener reemplazado no pisan los datos nuevos", async () => {
    const first = service.loadFromFirestore();
    source.listeners[0].emit(docs(["P-OLD"]));
    await first;

    service.stopListening();
    const second = service.loadFromFirestore();
    source.listeners[1].emit(docs(["P-NEW"]));
    await second;

    source.listeners[0].emit(docs(["P-OLD", "P-OLD2"]));
    source.listeners[0].error({ code: "unavailable" });

    expect(service.list().map((order) => order.order_id)).toEqual(["P-NEW"]);
    expect(service.loadError()).toBeNull();
    expect(service.syncState()).toBe("server");
  });

  it("4. tras la confirmación del servidor siguen aplicándose altas, cambios y bajas", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].emit(docs(["P-1"]), { fromCache: true });
    await load;
    source.listeners[0].emit(docs(["P-1"]));

    source.listeners[0].emit(docs(["P-1", "P-22"]));
    expect(service.list().map((o) => o.order_id).sort()).toEqual(["P-1", "P-22"]);

    source.listeners[0].emit(docs(["P-22"]));
    expect(service.list().map((o) => o.order_id)).toEqual(["P-22"]);
  });

  it("4. una escritura local pendiente (aún en caché) se aplica aunque ya hubo servidor", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].emit(docs(["P-1"]));
    await load;

    source.listeners[0].emit([orderDoc("P-1"), orderDoc("P-NEW", "bm", true)], { fromCache: true });
    expect(service.list().length).toBe(2);
    expect(service.syncState()).toBe("cache");

    // Confirmación de esa escritura sin cambios de datos: se conserva lo aplicado.
    source.listeners[0].emit(docs(["P-1", "P-NEW"]));
    expect(service.list().length).toBe(2);
    expect(service.syncState()).toBe("server");
  });

  it("los cambios de datos en tiempo real siguen actualizando el listado", async () => {
    const load = service.loadFromFirestore();
    source.listeners[0].emit(docs(["P-1"]));
    await load;
    source.listeners[0].emit(docs(["P-1", "P-22"]));
    expect(service.list().length).toBe(2);
  });
});
