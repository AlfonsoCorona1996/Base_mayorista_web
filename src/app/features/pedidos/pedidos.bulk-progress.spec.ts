import { signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router, convertToParamMap } from "@angular/router";
import PedidosPage from "./pedidos";
import { AuthzService } from "../../core/authz.service";
import { BusinessScopeService } from "../../core/business-scope.service";
import { CustomersService } from "../../core/customers.service";
import { CustomerFollowupsService } from "../../core/customer-followups.service";
import { InventoryService } from "../../core/inventory.service";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { Order, OrdersService } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { ShipmentsService } from "../../core/shipments.service";
import { RouteRunsService } from "../../services/route-runs.service";
import { SalesNoteRenderService, SalesNoteRenderRow } from "./sales-note-render.service";

type BulkInternals = {
  buildSalesNoteImage(order: Order, rows: SalesNoteRenderRow[]): Promise<Blob>;
  buildRouteBitacoraPdf(): Promise<Blob>;
  createCollectionReminderFromNote(): Promise<boolean>;
  downloadSalesNotesBundle(): Promise<void>;
  downloadBlob(): void;
  sleep(): Promise<void>;
  shipmentItemsForOrder(): unknown[];
};

// Una misma fecha mantiene estable el orden de selección en todos los equipos.
const orderTimestamp = new Date().toISOString();

function order(id: string, items = true): Order {
  return {
    order_id: id, business_id: "bm", customer_id: "ana", route_id: "norte", status: "empaque",
    planned_packages: null, open_incidents_count: 0, has_high_incident: false,
    last_incident_at: null, last_event_at: null, created_at: orderTimestamp, updated_at: orderTimestamp,
    items: items ? [{ item_id: `i-${id}`, title: "Producto", quantity: 1, price_clienta: 100, price_public: 100, price_cost: 40, state: "empaque", source: "manual", confirmation_state: "confirmed" }] : [],
    packages: [], timeline: [], notes: "", packing: { status: "in_progress", packages_count: 0, completed_at: null },
    dispatch_request: { status: "none", requested_at: null, requested_by: null, note: null },
    route_run_id: null, totals: { total_amount: 100, paid_amount: 0, balance_due: 100 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Pedidos: seguimiento de acciones masivas", () => {
  let fixture: ComponentFixture<PedidosPage>;
  let page: PedidosPage;
  let internals: BulkInternals;
  const rows = signal<Order[]>([]);
  const logEvent = jasmine.createSpy("logEvent").and.resolveTo();
  const updateStatus = jasmine.createSpy("updateStatus").and.resolveTo();
  const createShipment = jasmine.createSpy("createShipment").and.resolveTo("shipment-1");

  beforeEach(async () => {
    localStorage.removeItem("pedidos.ui-state.v1");
    rows.set([]);
    logEvent.calls.reset();
    updateStatus.calls.reset();
    updateStatus.and.resolveTo();
    createShipment.calls.reset();
    createShipment.and.resolveTo("shipment-1");
    const customers = [{ customer_id: "ana", first_name: "Ana", last_name: "Martínez", active: true, business_id: "bm" }];
    await TestBed.configureTestingModule({
      imports: [PedidosPage],
      providers: [
        { provide: OrdersService, useValue: { list: rows, loading: signal(false), loadError: signal(null), syncState: signal("server"), loadFromFirestore: async () => undefined, logEvent, updateStatus } },
        { provide: CustomersService, useValue: { customers: signal(customers), customersLoaded: signal(true), customersError: signal(null), customersStatus: signal("ready"), getActive: () => customers, getById: () => customers[0], loadCustomers: async () => undefined } },
        { provide: BusinessScopeService, useValue: { availableBusinessIds: signal(["bm"]), activeBusinessIds: signal(["bm"]), scope: signal("bm"), isBothMode: () => false, writeBusinessId: () => "bm", canAccessBusiness: () => true, businessClass: () => "business-bm", businessShortLabel: () => "BM", businessLabel: () => "Base Mayorista" } },
        { provide: RoutesService, useValue: { routes: signal([]), getById: (id: string) => ({ name: id }), loadFromFirestore: async () => undefined } },
        { provide: InventoryService, useValue: { items: signal([]) } },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: CustomerFollowupsService, useValue: {} },
        { provide: SalesNoteRenderService, useValue: {} },
        { provide: ShipmentsService, useValue: { activeShipments: signal([]), watch: () => undefined, createShipment } },
        { provide: RouteRunsService, useValue: {} },
        { provide: AuthzService, useValue: { canCap: () => true } },
        { provide: Router, useValue: { getCurrentNavigation: () => null, navigate: jasmine.createSpy(), navigateByUrl: jasmine.createSpy(), createUrlTree: jasmine.createSpy() } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PedidosPage);
    page = fixture.componentInstance;
    internals = page as unknown as BulkInternals;
    page.viewMode.set("table");
    page.tableSelectionMode.set(true);
    spyOn(internals, "sleep").and.resolveTo();
    spyOn(internals, "createCollectionReminderFromNote").and.resolveTo(false);
    spyOn(internals, "downloadBlob");
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.removeItem("pedidos.ui-state.v1");
  });

  function select(orders: Order[]) {
    rows.set(orders);
    page.tableSelected.set(Object.fromEntries(orders.map((item) => [item.order_id, true])));
  }

  it("muestra avance real, evita doble envío y conserva errores y omisiones después de terminar", async () => {
    select([order("A"), order("B"), order("C", false)]);
    const first = deferred<Blob>();
    const build = spyOn(internals, "buildSalesNoteImage").and.callFake((item) => item.order_id === "A" ? first.promise : Promise.reject({ code: "unavailable" }));
    const download = spyOn(internals, "downloadSalesNotesBundle").and.resolveTo();
    const running = page.applyTableBulkAction("create_nota");
    expect(page.tableBulkProgressTotal()).toBe(3);
    expect(page.tableBulkActionLoading()).toBeTrue();
    await page.applyTableBulkAction("create_nota");
    expect(build).toHaveBeenCalledTimes(1);
    first.resolve(new Blob(["nota"]));
    await running;
    expect(page.tableBulkProgressCurrent()).toBe(3);
    expect(page.tableBulkSucceeded()).toBe(1);
    expect(page.tableBulkFailed()).toBe(1);
    expect(page.tableBulkSkipped()).toBe(1);
    expect(page.tableBulkTone()).toBe("warning");
    expect(page.tableBulkIssues()[0].reason).toContain("conexión");
    expect(page.tableBulkIssues()[1].reason).toContain("Sin productos");
    expect(page.tableSelected()).toEqual({ B: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(page.tableBulkResultVisible()).toBeTrue();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".bulk-progress")?.parentElement?.classList.contains("table-view")).toBeTrue();
    const detail = host.querySelector<HTMLButtonElement>('[aria-controls="bulk-progress-details"]')!;
    detail.click();
    fixture.detectChanges();
    expect(detail.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".bulk-progress__details")?.textContent).toContain("B · Ana Martínez");
    await page.downloadTableBulkFiles();
    expect(download).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledTimes(1);
    page.closeTableBulkResult();
    fixture.detectChanges();
    expect(host.querySelector(".bulk-progress")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".tfilter-bulk-trigger"));
  });

  it("mantiene el proceso activo durante el ZIP y conserva los archivos si falla la descarga", async () => {
    select([order("A")]);
    spyOn(internals, "buildSalesNoteImage").and.resolveTo(new Blob(["nota"]));
    const bundle = deferred<void>();
    spyOn(internals, "downloadSalesNotesBundle").and.returnValue(bundle.promise);
    const running = page.applyTableBulkAction("create_nota");
    await new Promise((resolve) => setTimeout(resolve));
    expect(page.tableBulkProgressCurrent()).toBe(1);
    expect(page.tableBulkActionLoading()).toBeTrue();
    expect(page.tableBulkCurrentItem()).toContain("descarga");
    bundle.resolve();
    await running;
    expect(page.tableBulkTone()).toBe("success");
    expect(page.tableBulkActionLoading()).toBeFalse();
    (internals.downloadSalesNotesBundle as jasmine.Spy).and.rejectWith(new Error("download"));
    await page.downloadTableBulkFiles();
    expect(page.tableBulkFiles().length).toBe(1);
    expect(page.tableBulkDownloadMessage()).toContain("reintentar");
  });

  it("distingue fallo total de éxito aunque todos los pedidos estén procesados", async () => {
    select([order("A"), order("B")]);
    spyOn(internals, "buildSalesNoteImage").and.rejectWith(new Error("render"));
    await page.applyTableBulkAction("create_nota");
    expect(page.tableBulkProgressPercent()).toBe(100);
    expect(page.tableBulkTone()).toBe("error");
    expect(page.tableBulkSucceeded()).toBe(0);
    expect(page.tableBulkFailed()).toBe(2);
    expect(page.tableBulkFiles()).toEqual([]);
  });

  it("cuenta bitácoras por ruta y permite identificar los pedidos de la ruta fallida", async () => {
    select([order("A"), order("B"), { ...order("C"), route_id: "sur" }]);
    let calls = 0;
    spyOn(internals, "buildRouteBitacoraPdf").and.callFake(async () => {
      if (++calls === 2) throw new Error("pdf");
      return new Blob(["pdf"]);
    });
    await page.confirmBitacoraConfig();
    expect(page.tableBulkUnit()).toBe("rutas");
    expect(page.tableBulkProgressTotal()).toBe(2);
    expect(page.tableBulkProgressCurrent()).toBe(2);
    expect(page.tableBulkFailedOrderIds()).toEqual(["C"]);
    expect(page.tableBulkFiles().length).toBe(1);
    expect(page.tableBulkResultVisible()).toBeTrue();
  });

  it("no inventa avance si falla la creación del embarque antes de procesar pedidos", async () => {
    select([order("A")]);
    spyOn(page, "tableShipmentEligibleRows").and.returnValue(rows());
    spyOn(internals, "shipmentItemsForOrder").and.returnValue([{ order_id: "A" }]);
    createShipment.and.rejectWith({ code: "permission-denied" });
    await page.confirmBulkShipment();
    expect(page.tableBulkProgressCurrent()).toBe(0);
    expect(page.tableBulkProgressPercent()).toBe(0);
    expect(page.tableBulkError()).toContain("permiso");
    expect(page.tableBulkTone()).toBe("error");
    expect(page.tableBulkActionLoading()).toBeFalse();
    expect(page.tableBulkResultVisible()).toBeTrue();
  });

  it("reinicia el resultado anterior y registra cambios de estado, fallos y pedidos no elegibles", async () => {
    select([{ ...order("A"), status: "borrador" }, { ...order("B"), status: "en_transito" }, order("C")]);
    page.tableBulkError.set("Error anterior");
    page.tableBulkResultText.set("Resultado anterior");
    page.tableBulkDetailsOpen.set(true);
    page.tableBulkFiles.set([{ fileName: "anterior.png", blob: new Blob() }]);
    updateStatus.and.callFake(async (id: string) => { if (id === "B") throw new Error("write"); });
    await page.applyTableBulkAction("mark_recibido");
    expect(updateStatus.calls.allArgs()).toEqual([["A", "recibido_qa"], ["B", "recibido_qa"]]);
    expect(page.tableBulkSucceeded()).toBe(1);
    expect(page.tableBulkFailed()).toBe(1);
    expect(page.tableBulkSkipped()).toBe(1);
    expect(page.tableBulkProgressCurrent()).toBe(3);
    expect(page.tableBulkError()).toBeNull();
    expect(page.tableBulkFiles()).toEqual([]);
    expect(page.tableBulkDetailsOpen()).toBeFalse();
    expect(page.tableBulkResultText()).not.toContain("anterior");
    expect(page.tableBulkIssues().find((item) => item.status === "skipped")?.reason).toContain("estado actual");
  });
});
