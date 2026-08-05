import { Injectable, computed, inject, signal } from "@angular/core";
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

export type CatalogImportJobStatus = "uploaded" | "parsing" | "needs_mapping" | "validated" | "queued" | "committing" | "running" | "completed" | "failed";
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
  private unsubscribe: Unsubscribe | null = null;
  private watchKey = "";

  readonly jobs = signal<CatalogImportJob[]>([]);
  readonly activeJobs = computed(() =>
    this.jobs().filter((job) => !["completed", "failed", "needs_mapping", "validated"].includes(job.status)),
  );
  readonly latestActiveJob = computed(() => this.activeJobs()[0] || null);
  readonly completedJobs = computed(() => this.jobs().filter((job) => job.status === "completed"));

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
      status: ["uploaded", "parsing", "needs_mapping", "validated", "queued", "committing", "running", "completed", "failed"].includes(status) ? status : "queued",
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
