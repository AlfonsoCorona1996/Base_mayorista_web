import { Injectable } from "@angular/core";
import packageMetadata from "../../../package.json";
import { environment } from "../../environments/environment";

/**
 * Mediciones de carga del navegador (Angular + SDK de Firestore).
 *
 * - Apagadas por defecto: no registran nada ni escriben en consola.
 * - Se activan con `environment.perfMetrics`, con `?perf=1` en la URL
 *   (queda guardado en localStorage) o con `localStorage["bm.perf-metrics"] = "1"`.
 *   `?perf=0` las vuelve a apagar.
 * - Solo viven en memoria del navegador: no hay red, no hay Firestore, no hay
 *   servicios externos. Se leen desde la consola con `bmPerf.print()`.
 * - Solo admiten campos numéricos y códigos cerrados: nunca nombres, teléfonos,
 *   tokens, textos de búsqueda ni contenido de pedidos.
 *
 * Importante: el listado de pedidos no pasa por el backend Node. Estas cifras
 * describen el navegador; los tiempos internos del backend se miden aparte.
 */
export type PerfMetricName =
  | "auth_guard_ms"
  | "session_bootstrap_ms"
  | "orders_first_snapshot_ms"
  | "orders_server_snapshot_ms"
  | "orders_normalization_ms"
  | "customers_query_ms"
  | "customer_credit_query_ms"
  | "customers_publish_ms"
  | "customer_search_ready_ms"
  | "routes_query_ms"
  | "followups_query_ms";

export type PerfResult = "success" | "error";

/**
 * cache/server: origen informado por Firestore (`metadata.fromCache`).
 * memory: el dato ya estaba en un servicio de la app. shared: se reutilizó una
 * petición en curso. network: petición HTTP propia (bootstrap de sesión).
 */
export type PerfSource = "cache" | "server" | "memory" | "shared" | "network";

export interface PerfMetricDetails {
  result: PerfResult;
  load_id?: string;
  source?: PerfSource;
  /** Documentos devueltos por la consulta. */
  docs?: number;
  /** Documentos que quedan tras filtrar al negocio activo. */
  docs_in_scope?: number;
  /** Intento dentro de una carga: p. ej. consulta legacy o acotada por negocio. */
  attempt?: "legacy" | "business_scope";
  /** Código técnico del error (Firebase o HTTP); nunca el mensaje completo. */
  error_code?: string;
  /** Decisión de un guard. */
  outcome?: "allow" | "redirect";
}

export interface PerfMetricEntry extends PerfMetricDetails {
  metric: PerfMetricName;
  ms: number;
  /** Milisegundos desde el inicio de la navegación del documento al terminar la medición. */
  at_ms: number;
  app_version: string;
}

interface PerfConsoleApi {
  entries(): PerfMetricEntry[];
  summary(): Record<string, { count: number; last_ms: number; median_ms: number; max_ms: number; errors: number }>;
  print(): void;
  clear(): void;
}

const STORAGE_KEY = "bm.perf-metrics";
const MAX_ENTRIES = 200;

@Injectable({ providedIn: "root" })
export class PerfMetricsService {
  private readonly enabled = resolvePerfEnabled();
  private readonly buffer: PerfMetricEntry[] = [];
  private loadSequence = 0;

  constructor() {
    if (this.enabled) this.exposeConsoleApi();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** Identificador corto para correlacionar las mediciones de una misma carga. */
  newLoadId(prefix: string): string {
    this.loadSequence += 1;
    return `${prefix}-${this.loadSequence}`;
  }

  /** Registra la duración desde `startedAt` (valor devuelto por `now()`). */
  record(metric: PerfMetricName, startedAt: number, details: PerfMetricDetails): void {
    if (!this.enabled) return;
    const end = this.now();
    this.push({
      metric,
      ms: Math.max(0, Math.round(end - startedAt)),
      at_ms: Math.round(end),
      app_version: packageMetadata.version,
      ...details,
    });
  }

  entries(): PerfMetricEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }

  private push(entry: PerfMetricEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_ENTRIES) this.buffer.splice(0, this.buffer.length - MAX_ENTRIES);
    console.info(`[perf] ${entry.metric} ${entry.ms}ms`, entry);
  }

  private summary(): ReturnType<PerfConsoleApi["summary"]> {
    const byMetric = new Map<string, PerfMetricEntry[]>();
    for (const entry of this.buffer) {
      const list = byMetric.get(entry.metric) ?? [];
      list.push(entry);
      byMetric.set(entry.metric, list);
    }
    const result: ReturnType<PerfConsoleApi["summary"]> = {};
    for (const [metric, list] of byMetric) {
      const sorted = list.map((entry) => entry.ms).sort((a, b) => a - b);
      result[metric] = {
        count: list.length,
        last_ms: list[list.length - 1].ms,
        median_ms: sorted[Math.floor((sorted.length - 1) / 2)],
        max_ms: sorted[sorted.length - 1],
        errors: list.filter((entry) => entry.result === "error").length,
      };
    }
    return result;
  }

  private exposeConsoleApi(): void {
    if (typeof window === "undefined") return;
    const api: PerfConsoleApi = {
      entries: () => this.entries(),
      summary: () => this.summary(),
      print: () => {
        console.table(this.entries());
        console.table(this.summary());
      },
      clear: () => this.clear(),
    };
    (window as unknown as { bmPerf?: PerfConsoleApi }).bmPerf = api;
  }
}

/**
 * Extrae solo el código técnico de un error (`permission-denied`, `unavailable`,
 * status HTTP). El mensaje se descarta porque puede incluir datos del documento.
 */
export function firebaseErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9/_-]{1,64}$/i.test(code)) return code;
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return `http-${status}`;
  }
  return "unknown";
}

function resolvePerfEnabled(): boolean {
  const configured = (environment as { perfMetrics?: boolean }).perfMetrics === true;
  if (typeof window === "undefined") return configured;
  try {
    const flag = new URLSearchParams(window.location.search).get("perf");
    if (flag === "1") window.localStorage.setItem(STORAGE_KEY, "1");
    if (flag === "0") window.localStorage.removeItem(STORAGE_KEY);
    return configured || window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return configured;
  }
}
