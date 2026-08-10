import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { TestBed, fakeAsync, tick } from "@angular/core/testing";
import { AppVersionService } from "./app-version.service";

describe("AppVersionService", () => {
  let service: AppVersionService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AppVersionService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it("combina la version del build web con la version reportada por la API", fakeAsync(() => {
    service.load();

    http.expectOne("/version.json?v=2.1.0").flush(JSON.stringify({
      service: "base-mayorista-admin-web",
      version: "2.1.0",
      commit: "abcdef123456",
      dirty: false,
      built_at: "2026-08-10T12:00:00.000Z",
    }));
    http.expectOne("https://api.base-mayorista.com/health").flush(JSON.stringify({
      service: "base-mayorista-api",
      version: "2.2.0",
      commit: "1234567abcdef",
      dirty: false,
      built_at: null,
    }));
    tick();

    expect(service.summary()).toBe("Web v2.1.0 · API v2.2.0");
    expect(service.shortCommit(service.frontend().commit)).toBe("abcdef1");
    expect(service.shortCommit(service.backend()?.commit)).toBe("1234567");
  }));

  it("identifica un backend anterior que aun responde health sin version", fakeAsync(() => {
    service.load();

    http.expectOne("/version.json?v=2.1.0").flush("not-found", { status: 404, statusText: "Not Found" });
    http.expectOne("https://api.base-mayorista.com/health").flush("ok");
    tick();

    expect(service.backendState()).toBe("unversioned");
    expect(service.summary()).toBe("Web v2.1.0 · API sin versión");
  }));
});
