import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { TrackingPortalService } from "./tracking-portal.service";

describe("TrackingPortalService", () => {
  let service: TrackingPortalService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(TrackingPortalService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it("consulta el portal público sin enviar credenciales administrativas", () => {
    service.loadDashboard("v2.token-secreto").subscribe();

    const request = http.expectOne((candidate) =>
      candidate.url.endsWith("/api/track/v2.token-secreto"),
    );
    expect(request.request.method).toBe("GET");
    expect(request.request.headers.has("Authorization")).toBeFalse();
    request.flush({});
  });

  it("pagina el historial en bloques de diez con cursor opaco", () => {
    service.loadHistory("token", "cursor+opaco=").subscribe();

    const request = http.expectOne((candidate) => candidate.url.endsWith("/api/track/token/history"));
    expect(request.request.params.get("cursor")).toBe("cursor+opaco=");
    expect(request.request.params.get("limit")).toBe("10");
    request.flush({ items: [], next_cursor: null });
  });

  it("codifica el identificador al abrir un pedido fuera de la lista", () => {
    service.loadOrder("token", "pedido/con espacios").subscribe();

    const request = http.expectOne((candidate) =>
      candidate.url.endsWith("/api/track/token/orders/pedido%2Fcon%20espacios"),
    );
    expect(request.request.method).toBe("GET");
    request.flush({});
  });
});
