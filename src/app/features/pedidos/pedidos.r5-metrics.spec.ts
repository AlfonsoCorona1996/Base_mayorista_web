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
import { Order, OrdersService, OrdersSyncState } from "../../core/orders.service";
import { PerfMetricsService } from "../../core/perf-metrics.service";
import { BusinessId } from "../../core/rbac.constants";
import { RoutesService } from "../../core/routes.service";
import { ShipmentsService } from "../../core/shipments.service";
import { CUSTOMER_PICKER_SHEET_MEDIA } from "./customer-picker/customer-picker.component";

/**
 * R5: «primera lista» = pedidos reales en pantalla; «lista útil» = además nombres de clientas y
 * buscador. Se registran una vez por visita y la lista útil no se adelanta a las clientas.
 */
function makeOrder(index: number): Order {
  return {
    order_id: `P-${String(index).padStart(4, "0")}`, business_id: "bm", customer_id: "c-ana", route_id: null, status: "borrador",
    planned_packages: null, open_incidents_count: 0, has_high_incident: false, last_incident_at: null, last_event_at: null,
    created_at: "2026-10-01T15:00:00.000Z", updated_at: new Date(Date.UTC(2026, 9, 16, 12) - index * 60_000).toISOString(),
    items: [], packages: [], timeline: [], notes: "",
    packing: { status: "in_progress", packages_count: 0, completed_at: null },
    dispatch_request: { status: "none", requested_at: null, requested_by: null, note: null },
    route_run_id: null, totals: { total_amount: 0, paid_amount: 0, balance_due: 0 },
  };
}

describe("PedidosPage - métricas de primera lista (R5)", () => {
  let fixture: ComponentFixture<PedidosPage>;
  let orderRows: WritableSignal<Order[]>;
  let syncState: WritableSignal<OrdersSyncState>;
  let releaseCustomers: (result: RawQueryResult) => void;

  beforeEach(async () => {
    window.localStorage.setItem("bm.perf-metrics", "1");
    window.localStorage.removeItem("pedidos.ui-state.v1");
    spyOn(console, "info");
    orderRows = signal<Order[]>([]);
    syncState = signal<OrdersSyncState>("loading");
    const source = jasmine.createSpyObj<CustomersDataSource>("CustomersDataSource", ["fetchAllCustomers", "fetchCustomersByBusiness", "fetchCreditMovements"]);
    const pending = new Promise<RawQueryResult>((resolve) => (releaseCustomers = resolve));
    source.fetchAllCustomers.and.returnValue(pending);
    source.fetchCustomersByBusiness.and.returnValue(pending);
    source.fetchCreditMovements.and.returnValue(new Promise<RawQueryResult>(() => undefined));

    await TestBed.configureTestingModule({
      imports: [PedidosPage],
      providers: [
        { provide: CUSTOMERS_DATA_SOURCE, useValue: source },
        { provide: CUSTOMER_PICKER_SHEET_MEDIA, useValue: "not all" },
        {
          provide: BusinessScopeService,
          useValue: {
            availableBusinessIds: signal<BusinessId[]>(["bm"]), activeBusinessIds: signal<BusinessId[]>(["bm"]), scope: signal("bm"), isBothMode: () => false,
            writeBusinessId: () => "bm", canAccessBusiness: () => true, businessClass: () => "business-bm", businessShortLabel: () => "BM", businessLabel: () => "Base Mayorista",
          },
        },
        { provide: OrdersService, useValue: { list: orderRows, loading: signal(false), loadError: signal<string | null>(null), syncState, loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: RoutesService, useValue: { routes: signal([]), getById: () => null, loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: InventoryService, useValue: { items: signal([]) } },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: SalesNoteRenderService, useValue: {} },
        { provide: CustomerFollowupsService, useValue: { loadFromFirestore: jasmine.createSpy().and.resolveTo() } },
        { provide: ShipmentsService, useValue: { activeShipments: signal([]), watch: jasmine.createSpy("watch") } },
        { provide: AuthzService, useValue: { canCap: () => true } },
        { provide: Router, useValue: { getCurrentNavigation: () => null, navigate: jasmine.createSpy(), navigateByUrl: jasmine.createSpy(), createUrlTree: jasmine.createSpy() } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PedidosPage);
  });

  afterEach(() => {
    fixture?.destroy();
    window.localStorage.removeItem("bm.perf-metrics");
    window.localStorage.removeItem("pedidos.ui-state.v1");
  });

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  };
  const entries = (metric: string) => TestBed.inject(PerfMetricsService).entries().filter((entry) => entry.metric === metric);

  it("registra la primera lista al pintar pedidos y la lista útil solo cuando hay clientas", async () => {
    await settle();
    expect(entries("pedidos_first_list_ms").length).withContext("sin pedidos no hay primera lista").toBe(0);

    syncState.set("cache");
    orderRows.set(Array.from({ length: 30 }, (_, index) => makeOrder(index)));
    await settle();
    const first = entries("pedidos_first_list_ms");
    expect(first.length).toBe(1);
    expect(first[0].source).toBe("cache");
    expect(first[0].docs).toBe(30);
    expect(entries("pedidos_useful_ms").length).withContext("las clientas siguen pendientes").toBe(0);

    releaseCustomers({ fromCache: false, docs: [{ id: "c-ana", data: () => ({ customer_id: "c-ana", business_id: "bm", first_name: "Ana", last_name: "López", active: true }) }] });
    syncState.set("server");
    await settle();
    expect(entries("pedidos_useful_ms").length).toBe(1);

    orderRows.update((rows) => [makeOrder(99), ...rows]);
    await settle();
    expect(entries("pedidos_first_list_ms").length).withContext("una sola vez por visita").toBe(1);
    expect(entries("pedidos_useful_ms").length).toBe(1);
  });

  it("la bitácora PDF y el ZIP de notas se generan igual con pdf-lib y JSZip cargados bajo demanda", async () => {
    type ExportApi = {
      buildRouteBitacoraPdf(routeName: string, orders: Order[], config: { includeProductCount: boolean; includeProductDetail: boolean; includeProductPrices: boolean; includeCustomerContact: boolean }): Promise<Blob>;
      downloadSalesNotesBundle(files: { fileName: string; blob: Blob }[], zipLabel: string): Promise<void>;
      downloadBlob(blob: Blob, fileName: string): void;
    };
    await settle();
    const api = fixture.componentInstance as unknown as ExportApi;
    const header = async (blob: Blob, length: number) => new TextDecoder().decode(new Uint8Array(await blob.slice(0, length).arrayBuffer()));

    const pdf = await api.buildRouteBitacoraPdf("Ruta Norte", [makeOrder(1), makeOrder(2)], {
      includeProductCount: true, includeProductDetail: true, includeProductPrices: true, includeCustomerContact: true,
    });
    expect(pdf.type).toBe("application/pdf");
    expect(await header(pdf, 5)).toBe("%PDF-");

    const download = spyOn(api, "downloadBlob");
    await api.downloadSalesNotesBundle([{ fileName: "nota-1.pdf", blob: pdf }, { fileName: "nota-2.pdf", blob: pdf }], "notas-tabla");
    expect(download).toHaveBeenCalledTimes(1);
    const [zip, fileName] = download.calls.mostRecent().args;
    expect(fileName).toMatch(/\.zip$/);
    expect(await header(zip, 2)).withContext("firma de un archivo ZIP").toBe("PK");
  });
});
