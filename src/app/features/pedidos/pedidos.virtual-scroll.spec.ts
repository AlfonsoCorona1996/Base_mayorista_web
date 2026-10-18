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
import { Order, OrderStatus, OrdersService, OrdersSyncState } from "../../core/orders.service";
import { BusinessId } from "../../core/rbac.constants";
import { RoutesService } from "../../core/routes.service";
import { ShipmentsService } from "../../core/shipments.service";
import { CUSTOMER_PICKER_SHEET_MEDIA } from "./customer-picker/customer-picker.component";

/**
 * R4: la virtualización solo decide qué se monta. Estas pruebas fallan si se
 * monta todo, si "seleccionar todo" solo toma lo montado o si se pierden
 * selecciones al desplazarse.
 */
const STATUSES: OrderStatus[] = ["borrador", "empaque", "entregado", "pago_pendiente", "pagado", "cancelado"];

function makeOrder(index: number, customerId: string): Order {
  const price = 100 + (index % 9) * 10;
  return {
    order_id: `P-${String(index).padStart(4, "0")}`,
    business_id: "bm",
    customer_id: customerId,
    route_id: "r-norte",
    status: STATUSES[index % STATUSES.length],
    planned_packages: null,
    open_incidents_count: 0,
    has_high_incident: false,
    last_incident_at: null,
    last_event_at: null,
    created_at: "2026-10-01T15:00:00.000Z",
    updated_at: new Date(Date.UTC(2026, 9, 16, 12) - index * 60_000).toISOString(),
    items: [{ item_id: `i-${index}`, title: `Producto ${index}`, quantity: 1, price_clienta: price, price_public: price + 20, price_cost: 40, state: "empaque", source: "manual", confirmation_state: "confirmed" }],
    packages: [],
    timeline: [],
    notes: "",
    packing: { status: "in_progress", packages_count: 0, completed_at: null },
    dispatch_request: { status: "none", requested_at: null, requested_by: null, note: null },
    route_run_id: null,
    customer_payment_status: index % 2 ? "pending" : "collected",
    totals: { total_amount: price, paid_amount: index % 2 ? 0 : price, balance_due: index % 2 ? price : 0 },
  };
}

/** 538 pedidos: los primeros 120 son de Ana; el resto, de Bety. */
const ORDERS = Array.from({ length: 538 }, (_, index) => makeOrder(index, index < 120 ? "c-ana" : "c-bety"));

describe("PedidosPage - virtualización de tabla y tarjetas (R4)", () => {
  let fixture: ComponentFixture<PedidosPage>;
  let component: PedidosPage;
  let orderRows: WritableSignal<Order[]>;
  let style: HTMLStyleElement;

  beforeEach(async () => {
    window.localStorage.removeItem("pedidos.ui-state.v1");
    // Viewport de tabla pequeño y fijo para que la prueba no dependa del tamaño del iframe de Karma.
    style = document.createElement("style");
    style.textContent = ".orders-page .table-scroll { max-block-size: 320px !important; height: 320px; }";
    document.head.appendChild(style);
    orderRows = signal<Order[]>([]);
    const customers: RawQueryResult = {
      fromCache: false,
      docs: [
        { customer_id: "c-ana", business_id: "bm", first_name: "Ana", last_name: "Lopez", whatsapp: "5551", active: true },
        { customer_id: "c-bety", business_id: "bm", first_name: "Bety", last_name: "Ruiz", whatsapp: "5552", active: true },
      ].map((data) => ({ id: data.customer_id, data: () => data })),
    };
    const source = jasmine.createSpyObj<CustomersDataSource>("CustomersDataSource", ["fetchAllCustomers", "fetchCustomersByBusiness", "fetchCreditMovements"]);
    source.fetchAllCustomers.and.resolveTo(customers);
    source.fetchCustomersByBusiness.and.resolveTo(customers);
    source.fetchCreditMovements.and.returnValue(new Promise<RawQueryResult>(() => undefined));
    const available = signal<BusinessId[]>(["bm"]);

    await TestBed.configureTestingModule({
      imports: [PedidosPage],
      providers: [
        { provide: CUSTOMERS_DATA_SOURCE, useValue: source },
        { provide: CUSTOMER_PICKER_SHEET_MEDIA, useValue: "not all" },
        {
          provide: BusinessScopeService,
          useValue: {
            availableBusinessIds: available, activeBusinessIds: signal<BusinessId[]>(["bm"]), scope: signal("bm"), isBothMode: () => false,
            writeBusinessId: () => "bm", canAccessBusiness: () => true, businessClass: () => "business-bm", businessShortLabel: () => "BM", businessLabel: () => "Base Mayorista",
          },
        },
        {
          provide: OrdersService,
          useValue: { list: orderRows, loading: signal(false), loadError: signal<string | null>(null), syncState: signal<OrdersSyncState>("server"), loadFromFirestore: jasmine.createSpy().and.resolveTo() },
        },
        { provide: RoutesService, useValue: { routes: signal([{ route_id: "r-norte", name: "Ruta Norte" }]), getById: () => ({ route_id: "r-norte", name: "Ruta Norte" }), loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: InventoryService, useValue: { items: signal([]) } },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: SalesNoteRenderService, useValue: {} },
        { provide: CustomerFollowupsService, useValue: { loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: ShipmentsService, useValue: { activeShipments: signal([]), watch: jasmine.createSpy("watch") } },
        { provide: AuthzService, useValue: { canCap: () => true } },
        { provide: Router, useValue: { getCurrentNavigation: () => null, navigate: jasmine.createSpy("navigate"), navigateByUrl: jasmine.createSpy(), createUrlTree: jasmine.createSpy() } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PedidosPage);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
    style.remove();
    window.localStorage.removeItem("pedidos.ui-state.v1");
  });

  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  /** Varios ciclos de render + frame: la virtualización mide y ajusta en el frame siguiente. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await frame();
    }
    fixture.detectChanges();
  }
  const root = () => fixture.nativeElement as HTMLElement;
  const mountedRows = () => Array.from(root().querySelectorAll<HTMLTableRowElement>("tr.trow"));
  const scroller = () => root().querySelector<HTMLElement>(".table-scroll")!;

  async function showTable(): Promise<void> {
    orderRows.set(ORDERS);
    component.viewMode.set("table");
    await settle();
  }

  it("tabla: con 538 pedidos solo monta las filas cercanas al área visible", async () => {
    await showTable();
    expect(component.tableRows().length).toBe(538);
    expect(mountedRows().length).toBeGreaterThan(0);
    expect(mountedRows().length).withContext("si se monta todo, la virtualización no está activa").toBeLessThan(60);
    expect(root().querySelector(".orders-table")!.getAttribute("aria-rowcount")).toBe("539");
    expect(mountedRows()[0].getAttribute("aria-rowindex")).toBe("2");
  });

  it("ejemplo obligatorio: un filtro de 120 resultados con ~25 montados; seleccionar todo selecciona los 120", async () => {
    await showTable();
    component.search.set("ana lopez");
    await settle();
    expect(component.tableRows().length).toBe(120);
    expect(mountedRows().length).toBeLessThan(120);

    component.tableSelectionMode.set(true);
    await settle();
    root().querySelector<HTMLInputElement>(".th-select-checkbox")!.click();
    await settle();

    expect(component.tableSelectedCount()).toBe(120);
    expect(component.tableSelectedRows().map((order) => order.customer_id).every((id) => id === "c-ana")).toBeTrue();
    // Las acciones masivas (y las exportaciones que salen de ellas) reciben los 120.
    expect(component.tableSelectedRows().length).toBe(120);
  });

  it("las selecciones se conservan al desplazarse y las filas nuevas aparecen marcadas", async () => {
    await showTable();
    component.tableSelectionMode.set(true);
    await settle();
    root().querySelector<HTMLInputElement>(".th-select-checkbox")!.click();
    await settle();
    expect(component.tableSelectedCount()).toBe(538);

    scroller().scrollTop = scroller().scrollHeight;
    await settle();
    const last = mountedRows().at(-1)!;
    expect(last.getAttribute("data-vid")).toBe("P-0537");
    expect(mountedRows().every((row) => row.querySelector<HTMLInputElement>(".td-select-checkbox")!.checked)).toBeTrue();

    last.querySelector<HTMLInputElement>(".td-select-checkbox")!.click();
    await settle();
    scroller().scrollTop = 0;
    await settle();
    expect(mountedRows()[0].getAttribute("data-vid")).toBe("P-0000");
    scroller().scrollTop = scroller().scrollHeight;
    await settle();
    expect(root().querySelector<HTMLInputElement>('tr[data-vid="P-0537"] .td-select-checkbox')!.checked).toBeFalse();
    expect(component.tableSelectedCount()).toBe(537);
  });

  it("un pedido fuera del área visible no provoca trabajo de plantilla al cambiar", async () => {
    await showTable();
    const build = spyOn(component as unknown as { buildTableOrderStatusPills(order: Order): unknown }, "buildTableOrderStatusPills").and.callThrough();
    orderRows.update((rows) => rows.map((order) => (order.order_id === "P-0400" ? { ...order, status: "pagado" as const } : order)));
    await settle();
    expect(build).not.toHaveBeenCalled();
    expect(component.tableRows().find((order) => order.order_id === "P-0400")!.status).toBe("pagado");
  });

  it("cambiar el orden vuelve la tabla al inicio", async () => {
    await showTable();
    scroller().scrollTop = 4000;
    await settle();
    expect(scroller().scrollTop).toBeGreaterThan(0);
    component.toggleTableSort("total");
    await settle();
    expect(scroller().scrollTop).toBe(0);
    expect(mountedRows()[0].getAttribute("data-vid")).toBe(component.tableRows()[0].order_id);
  });

  it("tarjetas: monta una ventana; contadores y filtros siguen usando la lista completa", async () => {
    orderRows.set(ORDERS);
    component.viewMode.set("cards");
    component.setIntentFilter("cerrados");
    await settle();
    const filtered = component.filtered().length;
    expect(filtered).toBeGreaterThan(100);
    const cards = root().querySelectorAll("article.order-card").length;
    expect(cards).toBeGreaterThan(0);
    expect(cards).withContext("si se monta todo, la virtualización no está activa").toBeLessThan(filtered);
    expect(component.intentCounts().cerrados).toBe(filtered);
  });
});
