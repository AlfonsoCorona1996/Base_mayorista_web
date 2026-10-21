import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService } from "./inventory.service";
import { FakeOrdersSource, fakeTimestamp } from "./orders-snapshot.fake";
import { ORDERS_SNAPSHOT_SOURCE, OrdersService } from "./orders.service";
import { PerfMetricsService } from "./perf-metrics.service";
import { BusinessId } from "./rbac.constants";
import { SupplierOperationsService } from "./supplier-operations.service";

/** R5: `docs` del primer snapshot y de la confirmación del servidor informa los documentos reales. */
describe("OrdersService - métricas de documentos (R5)", () => {
  afterEach(() => window.localStorage.removeItem("bm.perf-metrics"));

  it("orders_first_snapshot_ms y orders_server_snapshot_ms informan el número de pedidos", async () => {
    window.localStorage.setItem("bm.perf-metrics", "1");
    spyOn(console, "info");
    const source = new FakeOrdersSource();
    TestBed.configureTestingModule({
      providers: [
        OrdersService,
        { provide: ORDERS_SNAPSHOT_SOURCE, useValue: source },
        { provide: BusinessScopeService, useValue: { availableBusinessIds: signal<BusinessId[]>(["bm"]), activeBusinessIds: signal<BusinessId[]>(["bm"]) } },
        { provide: SupplierOperationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: UserAdminApiService, useValue: {} },
      ],
    });
    const service = TestBed.inject(OrdersService);
    const perf = TestBed.inject(PerfMetricsService);
    const docs = Array.from({ length: 7 }, (_, index) => ({
      id: `P-${index}`,
      data: { business_id: "bm", customer_id: "c-1", status: "borrador", items: [], updated_at: fakeTimestamp(`2026-10-1${index}T10:00:00.000Z`) },
      pending: false,
    }));
    const load = service.loadFromFirestore();
    const listener = source.listeners[0];
    listener.emit(docs, { fromCache: true });
    await load;
    listener.emit(docs, { fromCache: false });

    const first = perf.entries().find((entry) => entry.metric === "orders_first_snapshot_ms");
    const server = perf.entries().find((entry) => entry.metric === "orders_server_snapshot_ms");
    expect(first?.docs).withContext("antes siempre era 0 (aridad de docs())").toBe(7);
    expect(first?.source).toBe("cache");
    expect(server?.docs).toBe(7);
  });
});
