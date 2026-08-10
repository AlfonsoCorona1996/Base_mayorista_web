import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";
import { lastValueFrom } from "rxjs";
import {
  Unsubscribe,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { CatalogProductImportRow } from "./catalog-products.service";

export type CatalogImportJobStatus = "uploaded" | "queued_validation" | "parsing" | "needs_mapping" | "validated" | "queued" | "committing" | "running" | "completed" | "failed";
export type CatalogImportMode = "full" | "partial";
export type CatalogImportRollbackStatus = "none" | "running" | "completed" | "failed";
export type CatalogImportRowStatus = "created" | "updated" | "unchanged" | "rejected" | "failed" | "skipped";

export interface CatalogImportJob {
  job_id: string;
  business_id: BusinessId;
  file_name: string;
  status: CatalogImportJobStatus;
  import_mode: CatalogImportMode;
  source_sheet_name: string | null;
  header_row_index: number | null;
  mapping_snapshot: Record<string, unknown> | null;
  total_rows: number;
  valid_rows: number;
  rejected_rows: number;
  processed_rows: number;
  created_products: number;
  updated_products: number;
  unchanged_rows: number;
  failed_rows: number;
  not_in_file_count: number;
  percent: number;
  error: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  price_cost_discount_pct: number | null;
  price_clienta_markup_pct: number | null;
  created_by: string | null;
  created_by_name: string | null;
  rollback_status: CatalogImportRollbackStatus;
  rolled_back_at?: unknown;
  rolled_back_by: string | null;
  rollback_error: string | null;
  created_at?: unknown;
  updated_at?: unknown;
  completed_at?: unknown;
}

export interface CreateCatalogImportJobInput {
  business_id: BusinessId;
  file_name: string;
  import_mode: CatalogImportMode;
  source_sheet_name?: string | null;
  header_row_index?: number | null;
  mapping_snapshot?: Record<string, unknown> | null;
  total_rows: number;
  valid_rows: number;
  rejected_rows: number;
  supplier_id: string;
  supplier_name: string;
  price_cost_discount_pct: number;
  price_clienta_markup_pct: number;
}

export interface CreateCatalogImportJobResult {
  ok?: boolean;
  job: CatalogImportJob;
}

export interface CatalogImportProfileV2 {
  profile_id?: string;
  version: 2;
  business_id?: BusinessId;
  supplier_id: string;
  name?: string | null;
  mapping: Record<string, unknown>;
  identity_rules?: Record<string, unknown>;
  price_rules: Record<string, unknown>;
}

export interface CatalogImportValidationResult {
  ok?: boolean;
  job: CatalogImportJob;
  summary?: {
    total_rows: number;
    valid_rows: number;
    rejected_rows: number;
    conflict_rows?: number;
  };
}

export interface CatalogImportCommitResult {
  ok?: boolean;
  job: CatalogImportJob;
}

export interface CatalogImportProfilesResult {
  ok?: boolean;
  profiles: CatalogImportProfileV2[];
}

export interface UploadCatalogImportChunkResult {
  ok?: boolean;
  job: CatalogImportJob;
}

export interface CatalogImportAuditRow {
  row_id: string;
  job_id: string | null;
  business_id: BusinessId;
  supplier_id: string | null;
  supplier_name: string | null;
  product_id: string | null;
  sku: string | null;
  row_number: number;
  status: CatalogImportRowStatus;
  issue: string | null;
  changed_fields: string[];
  before_snapshot: Record<string, unknown> | null;
  after_snapshot: Record<string, unknown> | null;
  price_before: Record<string, unknown> | null;
  price_after: Record<string, unknown> | null;
  created_at?: unknown;
}

export interface CatalogImportRowsResult {
  ok?: boolean;
  rows: CatalogImportAuditRow[];
  total?: number;
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface CatalogImportRollbackResult {
  ok?: boolean;
  job: CatalogImportJob;
  restored?: number;
  deactivated?: number;
}

@Injectable({ providedIn: "root" })
export class CatalogImportJobsService {
  private colRef = collection(FIRESTORE, "catalog_import_jobs");
  private businessScope = inject(BusinessScopeService);
  private api = inject(UserAdminApiService);
  private destroyRef = inject(DestroyRef);
  private unsubscribe: Unsubscribe | null = null;
  private watchKey = "";

  readonly jobs = signal<CatalogImportJob[]>([]);
  /** "needs_mapping"/"failed"/"completed" no cuentan como activos: no hay nada
   * corriendo ni un porcentaje que mostrar, requieren accion del usuario o ya
   * terminaron. Todo lo demas (incluida "validated", en espera de confirmar
   * el commit) sigue siendo parte de la cola visible. */
  readonly activeJobs = computed(() =>
    this.jobs().filter((job) => !["completed", "failed", "needs_mapping"].includes(job.status)),
  );
  readonly latestActiveJob = computed(() => this.activeJobs()[0] || null);
  readonly completedJobs = computed(() => this.jobs().filter((job) => job.status === "completed"));

  /** Job que el usuario cerro manualmente en el toast global; vive aqui (no en
   * el componente del layout) para sobrevivir si ese componente se recrea.
   * Solo oculta el toast para ESE job puntual: en cuanto cambia a otro job
   * activo (una importacion nueva), el toast vuelve a aparecer. */
  private readonly dismissedJobIdSig = signal<string | null>(null);
  readonly visibleToastJob = computed(() => {
    const job = this.latestActiveJob();
    if (!job || job.job_id === this.dismissedJobIdSig()) return null;
    return job;
  });

  dismissToast(jobId: string): void {
    this.dismissedJobIdSig.set(jobId);
  }

  /** Cuánto puede pasar sin que el backend escriba ningún avance antes de
   * considerar que un job "parece atorado". El backend ya deja un rastro cada
   * pocos cientos de filas/documentos en cada fase (validar, aplicar,
   * activar el catálogo nuevo) — si no hay ni un solo cambio en varios
   * minutos, algo se detuvo del lado del servidor (p. ej. se cayó) y hoy no
   * hay ninguna otra señal que lo avise: la pantalla solo refleja el último
   * dato que Firestore recibió, nunca "el servidor sigue vivo". */
  private static readonly STALE_MS = 3 * 60_000;
  private static readonly PROCESSING_STATUSES: CatalogImportJobStatus[] = ["queued_validation", "parsing", "queued", "committing", "running"];
  private readonly nowSig = signal(Date.now());

  constructor() {
    const staleCheckTimer = setInterval(() => this.nowSig.set(Date.now()), 20_000);
    this.destroyRef.onDestroy(() => clearInterval(staleCheckTimer));
  }

  /** true si el job debería estar avanzando (fase activa) pero no hay ningún
   * cambio hace más de STALE_MS — la señal de "puede estar atorado" que le
   * faltaba a la UI. */
  isStale(job: CatalogImportJob): boolean {
    if (!CatalogImportJobsService.PROCESSING_STATUSES.includes(job.status)) return false;
    const lastChangeMs = this.toMillis(job.updated_at || job.created_at);
    if (!lastChangeMs) return false;
    return this.nowSig() - lastChangeMs > CatalogImportJobsService.STALE_MS;
  }

  /** Normaliza un job crudo que vino embebido en un error (p. ej. `existing_job`
   * de un 409 DUPLICATE_ACTIVE_IMPORT), sin pasar por Firestore. */
  jobFromRaw(data: Record<string, unknown> | null | undefined): CatalogImportJob | null {
    if (!data || typeof data !== "object") return null;
    return this.normalizeJob(String((data as { job_id?: unknown })["job_id"] || ""), data);
  }

  /** Etiqueta compartida entre el toast global (main-layout) y el historial
   * del wizard de importacion, para no tener dos textos distintos por estado. */
  /** Texto simple, sin vocabulario técnico — quien usa la app no sabe qué es
   * un "job" ni un "lease"; solo necesita saber qué está pasando ahora mismo
   * y si tiene que hacer algo. Único lugar que define estos textos, usado
   * tanto por el toast global como por el card de cada importación. */
  jobStatusLabel(job: CatalogImportJob): string {
    if (job.rollback_status === "completed") return "Revertida";
    if (job.rollback_status === "running") return "Revirtiendo";
    if (job.status === "completed") return "Completada";
    if (job.status === "needs_mapping") return "No encontramos filas válidas — revisa el archivo";
    if (this.isStale(job)) return "Parece atorado — sin avance hace varios minutos";
    if (job.status === "validated") return "Listo para aplicar";
    if (job.status === "queued_validation") return "En espera de revisión";
    if (job.status === "parsing") return "Revisando tu archivo...";
    if (job.status === "queued") return "En espera para aplicarse";
    if (job.status === "committing" || job.status === "running") return "Aplicando los cambios...";
    if (job.status === "failed") return "No se pudo completar";
    return "En proceso";
  }

  jobStatusClass(job: CatalogImportJob): string {
    if (job.rollback_status === "completed") return "muted";
    if (job.status === "completed") return "ok";
    if (this.isStale(job)) return "danger";
    if (job.status === "failed" || job.rollback_status === "failed") return "danger";
    return "info";
  }

  watch(): void {
    const allowed = this.businessScope.availableBusinessIds();
    const key = allowed.join("|");
    if (this.unsubscribe && this.watchKey === key) return;
    this.stop();
    this.watchKey = key;
    this.unsubscribe = onSnapshot(
      query(
        this.colRef,
        where("business_id", "in", allowed),
        orderBy("updated_at", "desc"),
        limit(100),
      ),
      (snap) => {
        const rows = snap.docs
          .map((entry) => this.normalizeJob(entry.id, entry.data() as Record<string, unknown>))
          .sort((a, b) => this.toMillis(b.updated_at || b.created_at) - this.toMillis(a.updated_at || a.created_at));
        this.jobs.set(rows);
      },
      () => {
        this.jobs.set([]);
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watchKey = "";
  }

  async createJob(input: CreateCatalogImportJobInput): Promise<CatalogImportJob> {
    const result = await lastValueFrom(
      this.api.post<CreateCatalogImportJobResult>("/api/admin/catalog-imports", {
        ...input,
        business_id: normalizeBusinessId(input.business_id),
      }),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  async uploadChunk(jobId: string, rows: CatalogProductImportRow[], chunkIndex: number, finalChunk: boolean): Promise<CatalogImportJob> {
    const result = await lastValueFrom(
      this.api.post<UploadCatalogImportChunkResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/chunks`, {
        rows,
        chunk_index: chunkIndex,
        final_chunk: finalChunk,
      }),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  async uploadSourceFile(jobId: string, file: File): Promise<CatalogImportJob> {
    const form = new FormData();
    form.append("file", file, file.name);
    const result = await lastValueFrom(
      this.api.post<CreateCatalogImportJobResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/file`, form),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  /** Perfil v2 del job; el wizard confirma exclusivamente el staging validado por backend. */
  async saveJobProfile(jobId: string, profile: CatalogImportProfileV2): Promise<CatalogImportJob> {
    const result = await lastValueFrom(
      this.api.put<CreateCatalogImportJobResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/profile`, { profile }),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  async validate(jobId: string): Promise<CatalogImportValidationResult> {
    const result = await lastValueFrom(
      this.api.post<CatalogImportValidationResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/validate`, {}),
    );
    return { ...result, job: this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>) };
  }

  async commit(jobId: string): Promise<CatalogImportJob> {
    const result = await lastValueFrom(
      this.api.post<CatalogImportCommitResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/commit`, {}),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  async cancel(jobId: string): Promise<CatalogImportJob> {
    const result = await lastValueFrom(
      this.api.post<CatalogImportCommitResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/cancel`, {}),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  async loadProfiles(supplierId?: string): Promise<CatalogImportProfileV2[]> {
    const query = new URLSearchParams({ business_id: "catalogo" });
    if (supplierId) query.set("supplier_id", supplierId);
    const result = await lastValueFrom(this.api.get<CatalogImportProfilesResult>(`/api/admin/catalog-import-profiles?${query.toString()}`));
    return Array.isArray(result.profiles) ? result.profiles : [];
  }

  async createProfile(profile: CatalogImportProfileV2): Promise<CatalogImportProfileV2> {
    const result = await lastValueFrom(
      this.api.post<{ ok?: boolean; profile: CatalogImportProfileV2 }>("/api/admin/catalog-import-profiles", {
        business_id: profile.business_id || "catalogo",
        profile,
      }),
    );
    return result.profile;
  }

  async getProfile(profileId: string): Promise<CatalogImportProfileV2> {
    const result = await lastValueFrom(
      this.api.get<{ ok?: boolean; profile: CatalogImportProfileV2 }>(`/api/admin/catalog-import-profiles/${encodeURIComponent(profileId)}`),
    );
    return result.profile;
  }

  async updateProfile(profileId: string, profile: CatalogImportProfileV2): Promise<CatalogImportProfileV2> {
    const result = await lastValueFrom(
      this.api.put<{ ok?: boolean; profile: CatalogImportProfileV2 }>(
        `/api/admin/catalog-import-profiles/${encodeURIComponent(profileId)}`,
        { profile },
      ),
    );
    return result.profile;
  }

  async archiveProfile(profileId: string): Promise<void> {
    await lastValueFrom(
      this.api.delete<{ ok?: boolean }>(`/api/admin/catalog-import-profiles/${encodeURIComponent(profileId)}`),
    );
  }

  async loadRows(jobId: string, maxRows: number | null = null): Promise<CatalogImportAuditRow[]> {
    const rows: CatalogImportAuditRow[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const remaining = maxRows === null ? 1000 : Math.max(0, maxRows - rows.length);
      if (remaining === 0) break;
      const query = new URLSearchParams({ limit: String(Math.min(1000, remaining)) });
      if (cursor) query.set("cursor", cursor);
      const result = await lastValueFrom(
        this.api.get<CatalogImportRowsResult>(
          `/api/admin/catalog-imports/${encodeURIComponent(jobId)}/rows?${query.toString()}`,
        ),
      );
      const page = Array.isArray(result.rows)
        ? result.rows.map((row) => this.normalizeAuditRow(row as unknown as Record<string, unknown>))
        : [];
      rows.push(...page);

      const nextCursor = typeof result.next_cursor === "string" && result.next_cursor.trim()
        ? result.next_cursor
        : null;
      if (!result.has_more || !nextCursor || seenCursors.has(nextCursor) || page.length === 0) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (maxRows === null || rows.length < maxRows);

    return maxRows === null ? rows : rows.slice(0, maxRows);
  }

  async rollback(jobId: string): Promise<CatalogImportJob> {
    const result = await lastValueFrom(
      this.api.post<CatalogImportRollbackResult>(`/api/admin/catalog-imports/${encodeURIComponent(jobId)}/rollback`, {}),
    );
    return this.normalizeJob(result.job?.job_id, result.job as unknown as Record<string, unknown>);
  }

  private normalizeJob(fallbackId: string | undefined, data: Record<string, unknown>): CatalogImportJob {
    const status = String(data["status"] || "queued") as CatalogImportJobStatus;
    const total = this.safeNumber(data["total_rows"]);
    const valid = this.safeNumber(data["valid_rows"]);
    const processed = this.safeNumber(data["processed_rows"]);
    const progressBase = valid > 0 ? valid : total;
    const percent = status === "completed"
      ? 100
      : progressBase > 0
        ? Math.min(100, Math.round((processed / progressBase) * 100))
        : this.safeNumber(data["percent"]);
    return {
      job_id: String(data["job_id"] || fallbackId || ""),
      business_id: normalizeBusinessId(data["business_id"]),
      file_name: String(data["file_name"] || "catalogo.xlsx"),
      status: ["uploaded", "queued_validation", "parsing", "needs_mapping", "validated", "queued", "committing", "running", "completed", "failed"].includes(status) ? status : "queued",
      import_mode: data["import_mode"] === "partial" ? "partial" : "full",
      source_sheet_name: this.nullableText(data["source_sheet_name"]),
      header_row_index: data["header_row_index"] === null || data["header_row_index"] === undefined ? null : this.safeNumber(data["header_row_index"]),
      mapping_snapshot: data["mapping_snapshot"] && typeof data["mapping_snapshot"] === "object" ? data["mapping_snapshot"] as Record<string, unknown> : null,
      total_rows: total,
      valid_rows: valid,
      rejected_rows: this.safeNumber(data["rejected_rows"]),
      processed_rows: processed,
      created_products: this.safeNumber(data["created_products"]),
      updated_products: this.safeNumber(data["updated_products"]),
      unchanged_rows: this.safeNumber(data["unchanged_rows"]),
      failed_rows: this.safeNumber(data["failed_rows"]),
      not_in_file_count: this.safeNumber(data["not_in_file_count"]),
      percent,
      error: typeof data["error"] === "string" && data["error"].trim() ? String(data["error"]) : null,
      supplier_id: this.nullableText(data["supplier_id"]),
      supplier_name: this.nullableText(data["supplier_name"]),
      price_cost_discount_pct: this.safeNullablePercent(data["price_cost_discount_pct"]),
      price_clienta_markup_pct: this.safeNullablePercent(data["price_clienta_markup_pct"]),
      created_by: this.nullableText(data["created_by"]),
      created_by_name: this.nullableText(data["created_by_name"]),
      rollback_status: this.normalizeRollbackStatus(data["rollback_status"]),
      rolled_back_at: data["rolled_back_at"] ?? null,
      rolled_back_by: this.nullableText(data["rolled_back_by"]),
      rollback_error: this.nullableText(data["rollback_error"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
      completed_at: data["completed_at"] ?? null,
    };
  }

  private normalizeAuditRow(data: Record<string, unknown>): CatalogImportAuditRow {
    const status = String(data["status"] || "skipped") as CatalogImportRowStatus;
    return {
      row_id: String(data["row_id"] || ""),
      job_id: this.nullableText(data["job_id"]),
      business_id: normalizeBusinessId(data["business_id"]),
      supplier_id: this.nullableText(data["supplier_id"]),
      supplier_name: this.nullableText(data["supplier_name"]),
      product_id: this.nullableText(data["product_id"]),
      sku: this.nullableText(data["sku"]),
      row_number: this.safeNumber(data["row_number"]),
      status: ["created", "updated", "unchanged", "rejected", "failed", "skipped"].includes(status) ? status : "skipped",
      issue: this.nullableText(data["issue"]),
      changed_fields: Array.isArray(data["changed_fields"]) ? data["changed_fields"].map((value) => String(value)) : [],
      before_snapshot: data["before_snapshot"] && typeof data["before_snapshot"] === "object" ? data["before_snapshot"] as Record<string, unknown> : null,
      after_snapshot: data["after_snapshot"] && typeof data["after_snapshot"] === "object" ? data["after_snapshot"] as Record<string, unknown> : null,
      price_before: data["price_before"] && typeof data["price_before"] === "object" ? data["price_before"] as Record<string, unknown> : null,
      price_after: data["price_after"] && typeof data["price_after"] === "object" ? data["price_after"] as Record<string, unknown> : null,
      created_at: data["created_at"] ?? null,
    };
  }

  private safeNumber(value: unknown): number {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.trunc(number));
  }

  private safeNullablePercent(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Number(number.toFixed(2))));
  }

  private normalizeRollbackStatus(value: unknown): CatalogImportRollbackStatus {
    const text = String(value || "none");
    return text === "running" || text === "completed" || text === "failed" ? text : "none";
  }

  private nullableText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  private toMillis(value: unknown): number {
    if (!value) return 0;
    if (typeof value === "object" && value !== null && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      return (value as { toMillis: () => number }).toMillis();
    }
    if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
      return (value as { toDate: () => Date }).toDate().getTime();
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  }
}
