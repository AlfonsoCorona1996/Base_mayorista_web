import { WritableSignal, signal } from "@angular/core";
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
import { calculateOrderFinancials } from "../../core/order-financials";
import { Order, OrderStatus, OrdersService, OrdersSyncState } from "../../core/orders.service";
import { BusinessId } from "../../core/rbac.constants";
import { RoutePlan, RoutesService } from "../../core/routes.service";
import { Shipment, ShipmentsService } from "../../core/shipments.service";

/**
 * R3: la pantalla memoiza por identidad del pedido lo que calcula para cada fila o
 * tarjeta. Estas pruebas verifican que los resultados son los mismos que sin caché y
 * que cada dependencia externa (pedido, embarques, clientas, rutas, negocio y día)
 * invalida lo que debe.
 */
const STATUSES: OrderStatus[] = ["borrador", "confirmando_proveedor", "empaque", "ready_for_route", "en_ruta", "entregado", "pago_pendiente", "pagado", "cancelado"];

function makeOrder(index: number, overrides: Partial<Order> = {}): Order {
  const price = 100 + index * 7;
  const quantity = 1 + (index % 3);
  const paid = index % 4 === 0 ? price * quantity : index % 4 === 1 ? 50 : 0;
  return {
    order_id: `P-${String(index).padStart(3, "0")}`,
    business_id: index % 5 === 0 ? "catalogo" : "bm",
    customer_id: index % 2 ? "c-ana" : "c-bety",
    route_id: index % 3 ? "r-norte" : null,
    status: STATUSES[index % STATUSES.length],
    planned_packages: index % 2 ? 1 : null,
    open_incidents_count: index % 7 === 0 ? 1 : 0,
    has_high_incident: false,
    last_incident_at: null,
    last_event_at: null,
    created_at: `2026-10-${String((index % 9) + 1).padStart(2, "0")}T15:00:00.000Z`,
    updated_at: `2026-10-${String((index % 9) + 10).padStart(2, "0")}T15:00:00.000Z`,
    items: [{ item_id: `i-${index}`, title: `Producto ${index}`, quantity, price_clienta: price, price_public: price + 20, price_cost: 40, state: "empaque", source: "manual", confirmation_state: "confirmed" }],
    packages: index % 2 ? [{ package_id: `pk-${index}`, label: "Caja 1", sequence: 1, total_packages: 1, state: "closed", amount_due: null, item_ids: [`i-${index}`], created_at: "2026-10-01T00:00:00.000Z" }] : [],
    timeline: [],
    notes: "",
    packing: { status: "in_progress", packages_count: 0, completed_at: null },
    dispatch_request: { status: "none", requested_at: null, requested_by: null, note: null },
    route_run_id: null,
    customer_payment_status: paid <= 0 ? "pending" : paid >= price * quantity ? "collected" : "partial",
    totals: { total_amount: price * quantity, paid_amount: paid, balance_due: Math.max(0, price * quantity - paid) },
    ...overrides,
  };
}

function shipment(orderId: string, overrides: Partial<Shipment> = {}): Shipment {
  return {
    shipment_id: `s-${orderId}`, status: "sent", origin_location: "gdl", destination_location: "durango", title: "Embarque",
    created_at: "2026-10-12T10:00:00.000Z", updated_at: "2026-10-12T10:00:00.000Z",
    items: [{ order_id: orderId } as Shipment["items"][number]], business_summaries: [],
    ...overrides,
  };
}

describe("PedidosPage - cachés por pedido de la plantilla (R3)", () => {
  let fixture: ComponentFixture<PedidosPage>;
  let component: PedidosPage;
  let orderRows: WritableSignal<Order[]>;
  let activeShipments: WritableSignal<Shipment[]>;
  let routeRows: WritableSignal<RoutePlan[]>;
  let activeBusinesses: WritableSignal<BusinessId[]>;
  let resolveCustomers: (() => void) | null;

  beforeEach(async () => {
    window.localStorage.removeItem("pedidos.ui-state.v1");
    orderRows = signal<Order[]>([]);
    activeShipments = signal<Shipment[]>([]);
    routeRows = signal<RoutePlan[]>([{ route_id: "r-norte", name: "Ruta Norte" } as RoutePlan]);
    activeBusinesses = signal<BusinessId[]>(["bm", "catalogo"]);
    resolveCustomers = null;
    const customersResult: RawQueryResult = {
      fromCache: false,
      docs: [
        { customer_id: "c-ana", business_id: "bm", first_name: "Ana", last_name: "Lopez", whatsapp: "5551", active: true },
        { customer_id: "c-bety", business_id: "catalogo", first_name: "Bety", last_name: "Ruiz", whatsapp: "5552", active: true },
      ].map((data) => ({ id: data.customer_id, data: () => data })),
    };
    const source = jasmine.createSpyObj<CustomersDataSource>("CustomersDataSource", ["fetchAllCustomers", "fetchCustomersByBusiness", "fetchCreditMovements"]);
    source.fetchAllCustomers.and.callFake(() => new Promise<RawQueryResult>((resolve) => (resolveCustomers = () => resolve(customersResult))));
    source.fetchCustomersByBusiness.and.resolveTo(customersResult);
    source.fetchCreditMovements.and.returnValue(new Promise<RawQueryResult>(() => undefined));
    const available = signal<BusinessId[]>(["bm", "catalogo"]);

    await TestBed.configureTestingModule({
      imports: [PedidosPage],
      providers: [
        { provide: CUSTOMERS_DATA_SOURCE, useValue: source },
        {
          provide: BusinessScopeService,
          useValue: {
            availableBusinessIds: available,
            activeBusinessIds: activeBusinesses,
            scope: signal("both"),
            isBothMode: () => true,
            writeBusinessId: () => "bm",
            canAccessBusiness: (id: BusinessId) => available().includes(id),
            businessClass: (id: BusinessId) => `business-${id}`,
            businessShortLabel: (id: BusinessId) => (id === "catalogo" ? "CAT" : "BM"),
            businessLabel: () => "Base Mayorista",
          },
        },
        {
          provide: OrdersService,
          useValue: {
            list: orderRows,
            loading: signal(false),
            loadError: signal<string | null>(null),
            syncState: signal<OrdersSyncState>("server"),
            loadFromFirestore: jasmine.createSpy("loadFromFirestore").and.resolveTo(),
          },
        },
        { provide: RoutesService, useValue: { routes: routeRows, getById: (id: string) => routeRows().find((r) => r.route_id === id) ?? null, loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: InventoryService, useValue: { items: signal([]) } },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: SalesNoteRenderService, useValue: {} },
        { provide: CustomerFollowupsService, useValue: { loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: ShipmentsService, useValue: { activeShipments, watch: jasmine.createSpy("watch") } },
        { provide: AuthzService, useValue: { canCap: () => true } },
        { provide: Router, useValue: { getCurrentNavigation: () => null, navigate: jasmine.createSpy("navigate"), navigateByUrl: jasmine.createSpy("navigateByUrl"), createUrlTree: jasmine.createSpy("createUrlTree") } },
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

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

  async function render(): Promise<void> {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function showTable(orders: Order[], loadCustomers = true): Promise<void> {
    orderRows.set(orders);
    component.viewMode.set("table");
    fixture.detectChanges();
    if (loadCustomers) {
      await settle();
      resolveCustomers?.();
    }
    await render();
  }

  function replaceOrder(orderId: string, patch: Partial<Order>): Order {
    let next!: Order;
    orderRows.update((rows) => rows.map((order) => (order.order_id === orderId ? (next = { ...order, ...patch }) : order)));
    return next;
  }

  it("resultados iguales a los cálculos sin caché para pedidos variados", async () => {
    const orders = Array.from({ length: 30 }, (_, index) => makeOrder(index));
    activeShipments.set([shipment("P-003"), shipment("P-003", { shipment_id: "s-old", status: "received", created_at: "2026-10-01T00:00:00.000Z" })]);
    await showTable(orders);

    for (const order of orders) {
      const financials = calculateOrderFinancials(order);
      expect(component.tableOrderClientTotal(order)).withContext(order.order_id).toBe(financials.netAmount);
      const paid = financials.netAmount > 0 && (order.totals.paid_amount >= financials.netAmount - 0.01 || ["pagado", "closed"].includes(order.status));
      expect(component.isTableOrderPaid(order)).withContext(order.order_id).toBe(paid);
      // Llamar dos veces devuelve el mismo resultado (y la misma instancia).
      expect(component.tableOrderStatusPills(order)).toBe(component.tableOrderStatusPills(order));
    }
    // El embarque activo más antiguo del pedido decide la píldora, como antes.
    expect(component.tableOrderStatusPills(orders[3]).map((pill) => pill.label)).toContain("En Durango");
    expect(component.customerName("c-ana")).toBe("Ana Lopez");
    expect(component.customerName("c-inexistente")).toBe("Cliente sin nombre");
    expect(component.routeName("r-norte")).toBe("Ruta Norte");
    expect(component.routeName("r-desconocida")).toBe("r-desconocida");
    expect(component.routeName(null)).toBe("Sin ruta");
    expect(component.formatTableDateShort("fecha inválida")).toBe("--");
    expect(component.formatTableDateShort(orders[0].created_at)).toBe(component.formatTableDateShort(orders[0].created_at));
  });

  it("al cambiar un pedido solo se recalcula esa fila; las demás reutilizan su resultado", async () => {
    const orders = Array.from({ length: 40 }, (_, index) => makeOrder(index));
    await showTable(orders);
    const build = spyOn(component as unknown as { buildTableOrderStatusPills(order: Order): unknown }, "buildTableOrderStatusPills").and.callThrough();

    // Un pedido montado (R4 solo monta las filas cercanas al área visible).
    const mountedId = component.tableVisibleRows()[1].order_id;
    const changed = replaceOrder(mountedId, { status: "pagado", customer_payment_status: "collected", totals: { total_amount: 999, paid_amount: 999, balance_due: 0 } });
    await render();

    expect(build).toHaveBeenCalledTimes(1);
    expect(build.calls.mostRecent().args[0]).toBe(changed);
    expect(component.isTableOrderPaid(changed)).toBe(component.tableOrderClientTotal(changed) > 0);
  });

  it("una actualización del pedido (u optimista) cambia total, estado pagado y píldoras en la tabla", async () => {
    await showTable([makeOrder(2), makeOrder(5)]);
    const before = (fixture.nativeElement as HTMLElement).textContent || "";
    expect(before).toContain("Por cobrar");

    const updated = replaceOrder("P-002", {
      items: [{ ...makeOrder(2).items[0], quantity: 10, price_clienta: 300 }],
      status: "pagado",
      customer_payment_status: "collected",
      totals: { total_amount: 3000, paid_amount: 3000, balance_due: 0 },
    });
    await render();

    const index = component.tableRows().indexOf(updated);
    const row = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLTableRowElement>("tr.trow")[index];
    expect(row.querySelector(".td-total-value")?.textContent).toContain("3,000");
    expect(row.querySelector(".td-total-value")?.classList).toContain("td-total-value--paid");
  });

  it("un embarque activo nuevo cambia la píldora de un pedido que no cambió", async () => {
    const order = makeOrder(1, { status: "empaque", delivery_status: "pending", current_holder_location: "gdl" });
    await showTable([order]);
    expect(component.tableOrderStatusPills(order).map((pill) => pill.label)).not.toContain("Camino a Durango");

    activeShipments.set([shipment(order.order_id)]);
    await render();

    expect(component.tableOrderStatusPills(order).map((pill) => pill.label)).toContain("Camino a Durango");
    expect((fixture.nativeElement as HTMLElement).querySelector("tr.trow")?.textContent).toContain("Camino a Durango");
  });

  it("las clientas que llegan después actualizan nombres y búsqueda sin cambiar los pedidos", async () => {
    const orders = [makeOrder(1), makeOrder(2)];
    component.search.set("ana lopez");
    await showTable(orders, false);
    expect(component.tableRows().length).withContext("sin clientas aún no hay coincidencia por nombre").toBe(0);
    expect(component.customerDisplayName("c-ana")).toBe("Cargando clienta…");

    resolveCustomers?.();
    await render();

    expect(component.tableRows().map((order) => order.order_id)).toEqual(["P-001"]);
    expect(component.customerDisplayName("c-ana")).toBe("Ana Lopez");
    expect((fixture.nativeElement as HTMLElement).querySelector(".tc-name")?.textContent).toContain("Ana Lopez");
    // Búsqueda compacta por ID sin separadores, igual que antes.
    component.search.set("p001");
    await render();
    expect(component.tableRows().map((order) => order.order_id)).toEqual(["P-001"]);
  });

  it("renombrar una ruta y cambiar el negocio activo se reflejan sin cambiar los pedidos", async () => {
    const order = makeOrder(2);
    await showTable([order]);
    expect((fixture.nativeElement as HTMLElement).querySelector(".tc-route")?.textContent).toContain("Ruta Norte");

    routeRows.set([{ route_id: "r-norte", name: "Ruta Norte Nueva" } as RoutePlan]);
    await render();
    expect((fixture.nativeElement as HTMLElement).querySelector(".tc-route")?.textContent).toContain("Ruta Norte Nueva");

    // Bety es del negocio catálogo: al dejar solo BM ya no está entre las clientas visibles.
    expect(component.customerName("c-bety")).toBe("Bety Ruiz");
    activeBusinesses.set(["bm"]);
    await render();
    expect(component.customerName("c-bety")).toBe("Cliente sin nombre");
  });

  it("contadores e intención filtrada iguales a matchesIntent, también tras cambiar un pedido", async () => {
    const orders = Array.from({ length: 45 }, (_, index) => makeOrder(index));
    await showTable(orders);
    const expected = () => {
      const counts: Record<string, number> = {};
      for (const intent of Object.keys(component.intentCounts())) {
        counts[intent] = component.list().filter((order) => component.matchesIntent(order, intent as never)).length;
      }
      return counts;
    };
    expect(component.intentCounts()).toEqual(expected() as never);

    replaceOrder("P-004", { status: "en_ruta" });
    replaceOrder("P-007", { open_incidents_count: 3 });
    expect(component.intentCounts()).toEqual(expected() as never);

    component.setIntentFilter("en_ruta");
    expect(component.filtered().map((order) => order.order_id).sort())
      .toEqual(component.list().filter((order) => order.status === "en_ruta").map((order) => order.order_id).sort());
  });

  it("la intención 'hoy' respeta el cambio de día aunque el pedido no cambie", async () => {
    const day1 = new Date(2026, 9, 15, 12, 0);
    const today = makeOrder(1, { updated_at: new Date(2026, 9, 15, 9, 0).toISOString() });
    await showTable([today, makeOrder(2)]);

    // Reloj simulado solo en tramos síncronos: los computed se evalúan al leerlos.
    jasmine.clock().install();
    try {
      jasmine.clock().mockDate(day1);
      replaceOrder("P-002", { notes: "cambio el día 15" });
      expect(component.intentCounts().hoy).toBe(1);

      jasmine.clock().mockDate(new Date(2026, 9, 16, 12, 0));
      replaceOrder("P-002", { notes: "cambio el día 16" });
      expect(component.intentCounts().hoy).withContext("el pedido del día 15 no cambió, pero ya no es de hoy").toBe(0);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it("el orden por total y por clienta usa los mismos valores que sin caché", async () => {
    const orders = Array.from({ length: 20 }, (_, index) => makeOrder(index));
    await showTable(orders);

    component.toggleTableSort("total");
    const byTotal = component.tableRows().map((order) => calculateOrderFinancials(order).netAmount);
    expect(byTotal).toEqual([...byTotal].sort((a, b) => b - a));

    component.toggleTableSort("customer");
    const names = component.tableRows().map((order) => component.customerName(order.customer_id));
    expect(names).toEqual([...names].sort().reverse());
  });

  it("el filtro de fechas de la tabla usa la fecha local de creación", async () => {
    await showTable(Array.from({ length: 12 }, (_, index) => makeOrder(index)));
    component.tableDateFrom.set("2026-10-03");
    component.tableDateTo.set("2026-10-04");
    await render();
    const expected = component.list().filter((order) => {
      const date = new Date(order.created_at);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return key >= "2026-10-03" && key <= "2026-10-04";
    });
    expect(component.tableRows().length).toBe(expected.length);
    expect(component.tableRows().length).toBeGreaterThan(0);
  });
});
