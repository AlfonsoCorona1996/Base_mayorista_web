import { TestBed } from "@angular/core/testing";
import { PerfMetricsService, firebaseErrorCode } from "./perf-metrics.service";

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
});
