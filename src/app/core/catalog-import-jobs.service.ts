import { Injectable, computed, inject, signal } from "@angular/core";
import { lastValueFrom } from "rxjs";
import {
  Unsubscribe,
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { CatalogProductImportRow } from "./catalog-products.service";

export type CatalogImportJobStatus = "queued" | "running" | "completed" | "failed";

export interface CatalogImportJob {
  job_id: string;
  business_id: BusinessId;
  file_name: string;
  status: CatalogImportJobStatus;
  total_rows: number;
  valid_rows: number;
  rejected_rows: number;
  processed_rows: number;
  percent: number;
  error: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  price_cost_discount_pct: number | null;
  price_clienta_markup_pct: number | null;
  created_at?: unknown;
  updated_at?: unknown;
  completed_at?: unknown;
}

export interface CreateCatalogImportJobInput {
  business_id: BusinessId;
  file_name: string;
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

export interface UploadCatalogImportChunkResult {
  ok?: boolean;
  job: CatalogImportJob;
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
    this.jobs().filter((job) => job.status === "queued" || job.status === "running"),
  );
  readonly latestActiveJob = computed(() => this.activeJobs()[0] || null);

  watch(): void {
    const allowed = this.businessScope.availableBusinessIds();
    const key = allowed.join("|");
    if (this.unsubscribe && this.watchKey === key) return;
    this.stop();
    this.watchKey = key;
    this.unsubscribe = onSnapshot(
      query(this.colRef, where("business_id", "in", allowed)),
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
      status: status === "running" || status === "completed" || status === "failed" ? status : "queued",
      total_rows: total,
      valid_rows: valid,
      rejected_rows: this.safeNumber(data["rejected_rows"]),
      processed_rows: processed,
      percent,
      error: typeof data["error"] === "string" && data["error"].trim() ? String(data["error"]) : null,
      supplier_id: this.nullableText(data["supplier_id"]),
      supplier_name: this.nullableText(data["supplier_name"]),
      price_cost_discount_pct: this.safeNullablePercent(data["price_cost_discount_pct"]),
      price_clienta_markup_pct: this.safeNullablePercent(data["price_clienta_markup_pct"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
      completed_at: data["completed_at"] ?? null,
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
