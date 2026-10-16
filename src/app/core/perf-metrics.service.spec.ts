import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { PerfMetricsService, firebaseErrorCode, providePerfNavigationTracking, roundMs } from "./perf-metrics.service";

@Component({ template: "" })
class EmptyPage {}

describe("PerfMetricsService", () => {
  const storageKey = "bm.perf-metrics";

  afterEach(() => {
    window.localStorage.removeItem(storageKey);
    delete (window as unknown as { bmPerf?: unknown }).bmPerf;
  });

  it("está apagado por defecto: no guarda ni escribe en consola", () => {
    const info = spyOn(console, "info");
    const perf = TestBed.inject(PerfMetricsService);
    perf.record("customers_query_ms", perf.now(), { result: "success", docs: 3 });

    expect(perf.isEnabled()).toBeFalse();
    expect(perf.entries()).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("activado por configuración local, registra duración, versión y conteos", () => {
    window.localStorage.setItem(storageKey, "1");
    const info = spyOn(console, "info");
    const perf = TestBed.inject(PerfMetricsService);
    const startedAt = perf.now() - 25;
    perf.record("customers_publish_ms", startedAt, { result: "success", load_id: "customers-1", source: "server", docs: 3 });

    const [entry] = perf.entries();
    expect(perf.isEnabled()).toBeTrue();
    expect(entry.metric).toBe("customers_publish_ms");
    expect(entry.ms).toBeGreaterThanOrEqual(25);
    expect(entry.app_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(entry.docs).toBe(3);
    expect(info).toHaveBeenCalledTimes(1);
    expect((window as unknown as { bmPerf?: unknown }).bmPerf).toBeDefined();
  });

  it("de un error solo conserva el código, nunca el mensaje", () => {
    expect(firebaseErrorCode({ code: "permission-denied", message: "Clienta Ana 5551234" })).toBe("permission-denied");
    expect(firebaseErrorCode({ status: 503, message: "detalle" })).toBe("http-503");
    expect(firebaseErrorCode(new Error("Ana Lopez no encontrada"))).toBe("unknown");
    expect(firebaseErrorCode({ code: "texto libre con espacios y datos" })).toBe("unknown");
  });

  describe("R1: atribución por navegación", () => {
    beforeEach(() => {
      window.localStorage.setItem(storageKey, "1");
      spyOn(console, "info");
    });

    it("cada medición lleva navigation_id, patrón de ruta y tiempo relativo a esa navegación", () => {
      const perf = TestBed.inject(PerfMetricsService);
      perf.record("routes_query_ms", perf.now(), { result: "success" });
      perf.navigationStarted(1);
      perf.routeRecognized(1, "main/pedidos");
      perf.record("orders_first_snapshot_ms", perf.now() - 10, { result: "success" });
      perf.navigationStarted(2);
      perf.routeRecognized(2, "main/catalogo");
      perf.record("orders_normalization_ms", perf.now(), { result: "success", origin_navigation_id: 1 });

      const [before, first, second] = perf.entries();
      expect(before.navigation_id).toBeNull();
      expect(before.route).toBeNull();
      expect(before.nav_ms).toBeNull();
      expect(first.navigation_id).toBe(1);
      expect(first.route).toBe("main/pedidos");
      expect(first.nav_ms).toBeGreaterThanOrEqual(0);
      expect(second.navigation_id).toBe(2);
      expect(second.route).toBe("main/catalogo");
      expect(second.origin_navigation_id).withContext("evento de un listener abierto en otra pantalla").toBe(1);

      const groups = perf.byNavigation();
      expect(groups.map((group) => group.navigation_id)).toEqual([1, 2]);
      expect(groups[1].metrics["orders_normalization_ms"].count).toBe(1);
    });

    it("con el Router real registra el patrón de la ruta, nunca los IDs de la URL", async () => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: "main", children: [{ path: "pedidos", component: EmptyPage }, { path: "pedidos/:id", component: EmptyPage }] }]),
          providePerfNavigationTracking(),
        ],
      });
      const perf = TestBed.inject(PerfMetricsService);
      await TestBed.inject(Router).navigateByUrl("/main/pedidos/P-251014-ABCDEF?customer_id=c-ana");
      perf.record("orders_first_snapshot_ms", perf.now(), { result: "success" });

      const [entry] = perf.entries();
      expect(entry.navigation_id).toBe(1);
      expect(entry.route).toBe("main/pedidos/:id");
      expect(JSON.stringify(perf.entries())).not.toContain("P-251014");
      expect(JSON.stringify(perf.byNavigation())).not.toContain("c-ana");
    });

    it("conserva como máximo 200 mediciones y 50 navegaciones", () => {
      const perf = TestBed.inject(PerfMetricsService);
      for (let id = 1; id <= 60; id++) perf.navigationStarted(id);
      for (let index = 0; index < 250; index++) perf.record("routes_query_ms", perf.now(), { result: "success" });

      expect(perf.entries().length).toBe(200);
      expect(perf.byNavigation().length).toBe(50);
      expect(perf.byNavigation()[0].navigation_id).toBe(11);
    });

    it("mide en décimas de milisegundo", () => {
      expect(roundMs(0.14)).toBe(0.1);
      expect(roundMs(12.36)).toBe(12.4);
    });
  });

  it("apagado, el seguimiento de navegación no se suscribe al Router", async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: "pedidos", component: EmptyPage }]), providePerfNavigationTracking()],
    });
    const perf = TestBed.inject(PerfMetricsService);
    await TestBed.inject(Router).navigateByUrl("/pedidos");
    expect(perf.currentNavigationId()).toBeNull();
    expect(perf.byNavigation()).toEqual([]);
  });
});
