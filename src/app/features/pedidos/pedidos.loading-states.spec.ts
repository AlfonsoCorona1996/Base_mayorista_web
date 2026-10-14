import { signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router, convertToParamMap } from "@angular/router";
import PedidosPage from "./pedidos";
import { SalesNoteRenderService } from "./sales-note-render.service";
import { AuthzService } from "../../core/authz.service";
import { BusinessScopeService } from "../../core/business-scope.service";
import { CustomerFollowupsService } from "../../core/customer-followups.service";
import { CUSTOMERS_DATA_SOURCE, CustomersDataSource, RawQueryResult } from "../../core/customers.service";
import { InventoryService } from "../../core/inventory.service";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { Order, OrdersService, OrdersSyncState } from "../../core/orders.service";
import { BusinessId } from "../../core/rbac.constants";
import { RoutesService } from "../../core/routes.service";
import { ShipmentsService } from "../../core/shipments.service";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function customersResult(): RawQueryResult {
  const docs = [
    { customer_id: "c-ana", business_id: "bm", first_name: "Ana", last_name: "Lopez", whatsapp: "5551", active: true },
    { customer_id: "c-bety", business_id: "bm", first_name: "Bety", last_name: "Ruiz", whatsapp: "5552", active: true },
  ];
  return { fromCache: false, docs: docs.map((data) => ({ id: data.customer_id, data: () => data })) };
}

function draftOrder(orderId: string, customerId: string): Order {
  const now = "2026-10-14T10:00:00.000Z";
  return {
    order_id: orderId,
    business_id: "bm",
    customer_id: customerId,
    route_id: null,
    status: "borrador",
    planned_packages: null,
    open_incidents_count: 0,
    has_high_incident: false,
    last_incident_at: null,
    last_event_at: null,
    created_at: now,
    updated_at: now,
    items: [],
    packages: [],
    timeline: [],
    notes: "",
    packing: { status: "in_progress", packages_count: 0, completed_at: null },
    dispatch_request: { status: "none", requested_at: null, requested_by: null, note: null },
    route_run_id: null,
    totals: { total_amount: 0, paid_amount: 0, balance_due: 0 },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

describe("PedidosPage - disponibilidad de clientas y pedidos", () => {
  let fixture: ComponentFixture<PedidosPage>;
  let component: PedidosPage;
  let customerQueries: Deferred<RawQueryResult>[];
  let scopedQueries: Deferred<RawQueryResult>[];
  let source: jasmine.SpyObj<CustomersDataSource>;
  let orderRows: ReturnType<typeof signal<Order[]>>;
  let ordersLoading: ReturnType<typeof signal<boolean>>;
  let ordersError: ReturnType<typeof signal<string | null>>;
  let ordersSync: ReturnType<typeof signal<OrdersSyncState>>;
  let ordersLoad: jasmine.Spy;
  let shipmentsWatch: jasmine.Spy;

  beforeEach(async () => {
    window.localStorage.removeItem("pedidos.ui-state.v1");
    customerQueries = [];
    scopedQueries = [];
    source = jasmine.createSpyObj<CustomersDataSource>("CustomersDataSource", [
      "fetchAllCustomers",
      "fetchCustomersByBusiness",
      "fetchCreditMovements",
    ]);
    source.fetchAllCustomers.and.callFake(() => push(customerQueries));
    source.fetchCustomersByBusiness.and.callFake(() => push(scopedQueries));
    source.fetchCreditMovements.and.callFake(() => new Promise<RawQueryResult>(() => undefined));

    orderRows = signal<Order[]>([]);
    ordersLoading = signal(true);
    ordersError = signal<string | null>(null);
    ordersSync = signal<OrdersSyncState>("loading");
    ordersLoad = jasmine.createSpy("loadFromFirestore").and.resolveTo();
    shipmentsWatch = jasmine.createSpy("watch");
    const available = signal<BusinessId[]>(["bm"]);

    await TestBed.configureTestingModule({
      imports: [PedidosPage],
      providers: [
        { provide: CUSTOMERS_DATA_SOURCE, useValue: source },
        {
          provide: BusinessScopeService,
          useValue: {
            availableBusinessIds: available,
            activeBusinessIds: signal<BusinessId[]>(["bm"]),
            scope: signal("bm"),
            isBothMode: () => false,
            writeBusinessId: () => "bm",
            canAccessBusiness: (id: BusinessId) => available().includes(id),
            businessClass: () => "business-bm",
            businessShortLabel: () => "BM",
            businessLabel: () => "Base Mayorista",
          },
        },
        {
          provide: OrdersService,
          useValue: {
            list: orderRows,
            loading: ordersLoading,
            loadError: ordersError,
            syncState: ordersSync,
            loadFromFirestore: ordersLoad,
          },
        },
        { provide: RoutesService, useValue: { routes: signal([]), getById: () => null, loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: InventoryService, useValue: { items: signal([]) } },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: SalesNoteRenderService, useValue: {} },
        { provide: CustomerFollowupsService, useValue: { loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: ShipmentsService, useValue: { activeShipments: signal([]), watch: shipmentsWatch } },
        { provide: AuthzService, useValue: { canCap: () => true } },
        {
          provide: Router,
          useValue: {
            getCurrentNavigation: () => null,
            navigate: jasmine.createSpy("navigate"),
            navigateByUrl: jasmine.createSpy("navigateByUrl"),
            createUrlTree: jasmine.createSpy("createUrlTree"),
          },
        },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PedidosPage);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
    window.localStorage.removeItem("pedidos.ui-state.v1");
  });

  function push(list: Deferred<RawQueryResult>[]): Promise<RawQueryResult> {
    const next = deferred<RawQueryResult>();
    list.push(next);
    return next.promise;
  }

  async function render(): Promise<void> {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent || "";
  }

  function typeCustomer(term: string): void {
    component.customerQuery.set(term);
    component.showCustomerList.set(true);
  }

  function retryButtons(): HTMLButtonElement[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(".load-alert-action"));
  }

  it("C. con clientas pendientes no muestra un falso 'No existe una clienta'", async () => {
    fixture.detectChanges();
    typeCustomer("Ana");
    await render();

    expect(text()).toContain("Cargando clientas…");
    expect(text()).not.toContain("No existe una clienta con ese nombre.");
    expect(component.customerSearchState()).toBe("loading");
  });

  it("A. el buscador y los nombres funcionan sin esperar el historial de saldo a favor", async () => {
    orderRows.set([draftOrder("P-1", "c-ana")]);
    ordersLoading.set(false);
    ordersSync.set("server");
    component.viewMode.set("table");
    fixture.detectChanges();
    await render();
    expect(text()).toContain("Cargando clienta…");

    customerQueries[0].resolve(customersResult());
    typeCustomer("Ana");
    await render();

    expect(source.fetchCreditMovements).not.toHaveBeenCalled();
    expect(component.customerSuggestions().map((c) => c.customer_id)).toEqual(["c-ana"]);
    expect(text()).toContain("Ana Lopez");
    expect(text()).not.toContain("Cargando clienta…");
  });

  it("A. sin coincidencias reales, con datos cargados, sí muestra 'No existe'", async () => {
    fixture.detectChanges();
    customerQueries[0].resolve(customersResult());
    typeCustomer("Zulema");
    await render();

    expect(component.customerSearchState()).toBe("no-results");
    expect(text()).toContain("No existe una clienta con ese nombre.");
  });

  it("D. si fallan las clientas aparece el error con reintento, y reintentar no duplica lecturas", async () => {
    fixture.detectChanges();
    customerQueries[0].reject({ code: "permission-denied" });
    await settle();
    scopedQueries[0].reject({ code: "permission-denied" });
    typeCustomer("Ana");
    await render();

    expect(component.customerSearchState()).toBe("error");
    expect(text()).toContain("No se pudieron cargar las clientas.");
    expect(text()).not.toContain("No existe una clienta con ese nombre.");
    const retry = retryButtons();
    expect(retry.length).toBe(1);

    retry[0].click();
    component.retryCustomers();
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(2);

    customerQueries[1].resolve(customersResult());
    await render();
    expect(component.customerSearchState()).toBe("results");
    expect(retryButtons().length).toBe(0);
  });

  it("E. si fallan los pedidos se muestra el error y no un listado vacío exitoso", async () => {
    component.viewMode.set("table");
    ordersLoading.set(false);
    ordersError.set("No se pudieron cargar todos los pedidos. Actualiza para reintentar.");
    ordersSync.set("error");
    fixture.detectChanges();
    await render();

    expect(component.ordersListState()).toBe("error");
    expect(text()).toContain("No se pudieron cargar los pedidos.");
    expect(text()).not.toContain("No hay resultados con los filtros activos.");
    expect(text()).not.toContain("Sin resultados para este rango");
    expect(text()).not.toContain("0 resultados");
    expect(text()).toContain("Resultados no disponibles");

    const retry = retryButtons();
    expect(retry.length).toBe(1);
    retry[0].click();
    expect(ordersLoad).toHaveBeenCalledTimes(2);
  });

  it("E. en la vista de tarjetas tampoco muestra 'Sin resultados' durante un error", async () => {
    component.viewMode.set("cards");
    ordersLoading.set(false);
    ordersError.set("fallo");
    ordersSync.set("error");
    fixture.detectChanges();
    await render();

    expect(text()).not.toContain("Crea tu primer pedido o ajusta los filtros.");
  });

  it("J. con un snapshot de caché vacío muestra sincronización, no 'sin pedidos'", async () => {
    component.viewMode.set("table");
    ordersLoading.set(false);
    ordersSync.set("cache");
    fixture.detectChanges();
    await render();

    expect(text()).toContain("Sincronizando pedidos con el servidor…");
    expect(text()).not.toContain("No hay resultados con los filtros activos.");
    expect(text()).not.toContain("0 resultados");

    ordersSync.set("server");
    await render();
    expect(text()).toContain("No hay resultados con los filtros activos.");
    expect(text()).toContain("0 resultados");
  });

  it("no abre el listener de embarques si se sale de la pantalla antes de terminar la carga", async () => {
    fixture.detectChanges();
    fixture.destroy();
    customerQueries[0].resolve(customersResult());
    await settle();
    await settle();
    expect(shipmentsWatch).not.toHaveBeenCalled();
  });

  it("abre embarques al terminar la carga inicial", async () => {
    fixture.detectChanges();
    customerQueries[0].resolve(customersResult());
    await settle();
    await settle();
    expect(shipmentsWatch).toHaveBeenCalledTimes(1);
  });
});
