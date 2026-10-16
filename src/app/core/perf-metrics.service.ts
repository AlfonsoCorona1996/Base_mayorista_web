import { EnvironmentProviders, Injectable, inject, provideEnvironmentInitializer } from "@angular/core";
import { ActivatedRouteSnapshot, NavigationStart, Router, RoutesRecognized } from "@angular/router";
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
 *   tokens, textos de búsqueda ni contenido de pedidos. La ruta se guarda como
 *   patrón de configuración (`main/pedidos/:id`), nunca como URL real.
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

/**
 * Inferencia sobre el origen de un snapshot de pedidos. No es un hecho observado:
 * - initial: primer snapshot del listener (observable).
 * - local_pending: algún documento cambiado trae `hasPendingWrites`; hay una
 *   escritura local sin confirmar en este navegador (puede ser de otra pestaña
 *   que comparte la caché persistente).
 * - pending_resolved: cambió un documento que antes tenía escrituras pendientes y
 *   ya no las tiene. Suele ser la confirmación con `serverTimestamp()` resuelto,
 *   pero no se puede descartar un cambio remoto que llegó a la vez.
 * - unattributed: cambio de datos sin escrituras pendientes. Puede ser otro
 *   usuario, el backend o una transacción de este mismo cliente (las
 *   transacciones no tienen compensación local). No se puede distinguir.
 */
export type OrdersSnapshotInference = "initial" | "local_pending" | "pending_resolved" | "unattributed";

export interface PerfMetricDetails {
  result: PerfResult;
  load_id?: string;
  source?: PerfSource;
  /** Documentos devueltos por la consulta (pedidos: documentos mantenidos tras aplicar el snapshot). */
  docs?: number;
  /** Documentos que quedan tras filtrar al negocio activo. */
  docs_in_scope?: number;
  /** Intento dentro de una carga: p. ej. consulta legacy o acotada por negocio. */
  attempt?: "legacy" | "business_scope";
  /** Código técnico del error (Firebase o HTTP); nunca el mensaje completo. */
  error_code?: string;
  /** Decisión de un guard. */
  outcome?: "allow" | "redirect";

  // --- Snapshots del listener de pedidos. Todos observables salvo `inferred_cause`. ---
  /** Listener que produjo la medición (`orders-N`). */
  listener_id?: string;
  /** Navegación en la que se abrió el listener o empezó la carga. */
  origin_navigation_id?: number | null;
  /** full: primer snapshot; incremental: solo `docChanges()`; resync: reconstrucción por inconsistencia. */
  apply_mode?: "full" | "incremental" | "resync";
  added?: number;
  modified?: number;
  removed?: number;
  /** `data()` del SDK sobre los documentos procesados. */
  convert_ms?: number;
  /** `normalize()` de la app sobre los documentos procesados. */
  normalize_ms?: number;
  /** Mantenimiento del índice por `order_id`. */
  index_ms?: number;
  /** Mantenimiento del orden de presentación. */
  sort_ms?: number;
  /** Publicación de signals (marca consumidores; no incluye el render de Angular). */
  publish_ms?: number;
  /** `metadata.fromCache` del snapshot. */
  from_cache?: boolean;
  /** `metadata.hasPendingWrites` del snapshot. */
  has_pending_writes?: boolean;
  /** Documentos cambiados con `metadata.hasPendingWrites`. */
  pending_docs?: number;
  /** Documentos procesados cuyo `updated_at` está pendiente (escritura local con `serverTimestamp()`). */
  updated_at_pending?: number;
  /** Documentos procesados sin `updated_at` y sin escrituras pendientes. */
  updated_at_missing?: number;
  /** `document.visibilityState === "visible"` al medir. */
  visible?: boolean;
  /** Medición síncrona de 50 ms o más: bloqueó el hilo principal como tarea larga. */
  long_task?: boolean;
  /** Inferencia, no hecho observado. Ver `OrdersSnapshotInference`. */
  inferred_cause?: OrdersSnapshotInference;
}

export interface PerfMetricEntry extends PerfMetricDetails {
  metric: PerfMetricName;
  ms: number;
  /** Milisegundos desde el inicio de la navegación del documento al terminar la medición. */
  at_ms: number;
  /** `id` de `NavigationStart` del Router activo al terminar; null antes de la primera navegación. */
  navigation_id: number | null;
  /** Patrón de la ruta de esa navegación (`main/pedidos/:id`); nunca la URL real. */
  route: string | null;
  /** Milisegundos desde el `NavigationStart` de esa navegación. */
  nav_ms: number | null;
  app_version: string;
}

export interface PerfLongTaskSummary {
  count: number;
  total_ms: number;
  max_ms: number;
}

export interface PerfNavigationSummary {
  navigation_id: number;
  route: string | null;
  metrics: Record<string, { count: number; median_ms: number; max_ms: number; total_ms: number }>;
  /** Tareas largas del navegador (Chromium); null si el navegador no las informa. */
  long_tasks: PerfLongTaskSummary | null;
}

interface PerfConsoleApi {
  entries(): PerfMetricEntry[];
  summary(): Record<string, { count: number; last_ms: number; median_ms: number; max_ms: number; errors: number }>;
  byNavigation(): PerfNavigationSummary[];
  print(): void;
  clear(): void;
}

interface NavigationRecord {
  id: number;
  route: string | null;
  started_at: number;
  long_tasks: PerfLongTaskSummary;
}

const STORAGE_KEY = "bm.perf-metrics";
const MAX_ENTRIES = 200;
const MAX_NAVIGATIONS = 50;
export const LONG_TASK_MS = 50;

@Injectable({ providedIn: "root" })
export class PerfMetricsService {
  private readonly enabled = resolvePerfEnabled();
  private readonly buffer: PerfMetricEntry[] = [];
  private readonly navigations: NavigationRecord[] = [];
  private loadSequence = 0;
  private longTasksSupported = false;

  constructor() {
    if (this.enabled) {
      this.exposeConsoleApi();
      this.observeLongTasks();
    }
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

  /** Navegación del Router en curso o la última completada; null si aún no hubo ninguna. */
  currentNavigationId(): number | null {
    return this.currentNavigation()?.id ?? null;
  }

  /** Lo llama el inicializador de `providePerfNavigationTracking` en cada `NavigationStart`. */
  navigationStarted(id: number): void {
    if (!this.enabled) return;
    this.navigations.push({ id, route: null, started_at: this.now(), long_tasks: { count: 0, total_ms: 0, max_ms: 0 } });
    if (this.navigations.length > MAX_NAVIGATIONS) this.navigations.splice(0, this.navigations.length - MAX_NAVIGATIONS);
  }

  /** Patrón de ruta reconocido para la navegación `id` (ver `routePattern`). */
  routeRecognized(id: number, route: string): void {
    const navigation = this.navigations.find((entry) => entry.id === id);
    if (navigation) navigation.route = route;
  }

  /** Registra la duración desde `startedAt` (valor devuelto por `now()`). */
  record(metric: PerfMetricName, startedAt: number, details: PerfMetricDetails): void {
    if (!this.enabled) return;
    const end = this.now();
    const navigation = this.currentNavigation();
    this.push({
      metric,
      ms: roundMs(Math.max(0, end - startedAt)),
      at_ms: Math.round(end),
      navigation_id: navigation?.id ?? null,
      route: navigation?.route ?? null,
      nav_ms: navigation ? Math.round(end - navigation.started_at) : null,
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

  /** Agrupa las mediciones en memoria por navegación, con las tareas largas observadas en cada una. */
  byNavigation(): PerfNavigationSummary[] {
    const ids = new Set<number>(this.navigations.map((navigation) => navigation.id));
    for (const entry of this.buffer) if (entry.navigation_id !== null) ids.add(entry.navigation_id);
    return [...ids].sort((a, b) => a - b).map((id) => {
      const navigation = this.navigations.find((entry) => entry.id === id);
      const entries = this.buffer.filter((entry) => entry.navigation_id === id);
      const metrics: PerfNavigationSummary["metrics"] = {};
      for (const [metric, list] of groupByMetric(entries)) {
        const sorted = list.map((entry) => entry.ms).sort((a, b) => a - b);
        metrics[metric] = {
          count: list.length,
          median_ms: sorted[Math.floor((sorted.length - 1) / 2)],
          max_ms: sorted[sorted.length - 1],
          total_ms: roundMs(sorted.reduce((sum, value) => sum + value, 0)),
        };
      }
      return {
        navigation_id: id,
        route: navigation?.route ?? entries.find((entry) => entry.route)?.route ?? null,
        metrics,
        long_tasks: this.longTasksSupported && navigation ? { ...navigation.long_tasks } : null,
      };
    });
  }

  private currentNavigation(): NavigationRecord | undefined {
    return this.navigations[this.navigations.length - 1];
  }

  private push(entry: PerfMetricEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_ENTRIES) this.buffer.splice(0, this.buffer.length - MAX_ENTRIES);
    console.info(`[perf] ${entry.metric} ${entry.ms}ms`, entry);
  }

  private summary(): ReturnType<PerfConsoleApi["summary"]> {
    const result: ReturnType<PerfConsoleApi["summary"]> = {};
    for (const [metric, list] of groupByMetric(this.buffer)) {
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

  /**
   * Tareas largas (>50 ms) que informa el navegador, sumadas por navegación.
   * Solo Chromium/Android Chrome implementan `longtask`; en Safari y Firefox queda en null.
   */
  private observeLongTasks(): void {
    if (typeof PerformanceObserver === "undefined") return;
    if (!(PerformanceObserver.supportedEntryTypes ?? []).includes("longtask")) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const task of list.getEntries()) {
          const navigation = [...this.navigations].reverse().find((entry) => entry.started_at <= task.startTime)
            ?? this.navigations[0];
          if (!navigation) continue;
          navigation.long_tasks.count += 1;
          navigation.long_tasks.total_ms = roundMs(navigation.long_tasks.total_ms + task.duration);
          navigation.long_tasks.max_ms = Math.max(navigation.long_tasks.max_ms, roundMs(task.duration));
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      this.longTasksSupported = true;
    } catch {
      this.longTasksSupported = false;
    }
  }

  private exposeConsoleApi(): void {
    if (typeof window === "undefined") return;
    const api: PerfConsoleApi = {
      entries: () => this.entries(),
      summary: () => this.summary(),
      byNavigation: () => this.byNavigation(),
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
 * Asocia cada medición con la navegación del Router en la que ocurrió. Solo se
 * suscribe si las métricas están activas; apagadas, no hay costo.
 */
export function providePerfNavigationTracking(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    const perf = inject(PerfMetricsService);
    if (!perf.isEnabled()) return;
    inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) perf.navigationStarted(event.id);
      else if (event instanceof RoutesRecognized) perf.routeRecognized(event.id, routePattern(event.state.root));
    });
  });
}

/**
 * Patrón de la ruta reconocida (`main/pedidos/:id`), construido con
 * `routeConfig.path`. Nunca usa la URL real: no registra IDs de clientas ni pedidos.
 */
export function routePattern(root: ActivatedRouteSnapshot): string {
  const parts: string[] = [];
  let node: ActivatedRouteSnapshot | null = root;
  while (node) {
    const path = node.routeConfig?.path;
    if (path) parts.push(path);
    node = node.firstChild;
  }
  return parts.join("/") || "/";
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

/** Décimas de milisegundo: las actualizaciones incrementales suelen durar menos de 1 ms. */
export function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function groupByMetric(entries: PerfMetricEntry[]): Map<string, PerfMetricEntry[]> {
  const byMetric = new Map<string, PerfMetricEntry[]>();
  for (const entry of entries) {
    const list = byMetric.get(entry.metric) ?? [];
    list.push(entry);
    byMetric.set(entry.metric, list);
  }
  return byMetric;
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
