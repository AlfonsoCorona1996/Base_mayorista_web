import { Injectable, inject } from "@angular/core";
import { lastValueFrom } from "rxjs";
import { UserAdminApiService } from "../../../services/user-admin-api.service";

export type WaSendMode = "auto" | "template_only" | "free_only";

export type WaTemplateRegistryItem = {
  id: string;
  templateName: string;
  language: string;
  status: string | null;
  category: string | null;
  qualityScore: string | null;
  useCases: string[];
  syncedAt: string | null;
};

export type WaTemplatePolicy = {
  useCase: string;
  sendMode: WaSendMode;
  activeTemplateName: string | null;
  activeTemplateLanguage: string;
  fallbackTemplateName: string | null;
  fallbackTemplateLanguage: string;
  notes: string | null;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: { uid?: string | null; email?: string | null } | null;
};

export type WaSendAttempt = {
  attemptId: string;
  useCase: string;
  state: string;
  customerId: string | null;
  waId: string | null;
  orderId: string | null;
  messageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastMetaStatus: string | null;
  lastMetaStatusAt: string | null;
  error: { code?: unknown; details?: string | null } | null;
  decision: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  statusHistory: Array<Record<string, unknown>>;
};

@Injectable({ providedIn: "root" })
export class WaTemplateAdminApi {
  private readonly api = inject(UserAdminApiService);

  async listTemplates(useCase?: string | null): Promise<WaTemplateRegistryItem[]> {
    const query = useCase ? `?useCase=${encodeURIComponent(useCase)}` : "";
    const response = await lastValueFrom(this.api.get<unknown>(`/api/wa/templates${query}`));
    const root = this.asRecord(response);
    const items = root?.["items"];
    const rows = Array.isArray(items) ? items : [];
    return rows
      .map((row, index) => this.normalizeTemplate(row, `template-${index + 1}`))
      .filter((row): row is WaTemplateRegistryItem => row !== null);
  }

  async syncTemplates(pageLimit = 10): Promise<{ ok: boolean; upserted: number; syncedAt: string | null }> {
    const response = await lastValueFrom(
      this.api.post<unknown>("/api/wa/templates/sync-meta", {
        pageLimit,
      }),
    );
    const root = this.asRecord(response);
    return {
      ok: root?.["ok"] === true,
      upserted: Number.isFinite(Number(root?.["upserted"])) ? Number(root?.["upserted"]) : 0,
      syncedAt: this.asString(root?.["syncedAt"]),
    };
  }

  async getTemplatePolicy(useCase: string): Promise<WaTemplatePolicy | null> {
    const safeUseCase = String(useCase || "").trim();
    if (!safeUseCase) return null;
    const response = await lastValueFrom(
      this.api.get<unknown>(`/api/wa/template-policies/${encodeURIComponent(safeUseCase)}`),
    );
    const root = this.asRecord(response);
    return this.normalizePolicy(root?.["policy"], safeUseCase);
  }

  async listTemplatePolicies(): Promise<WaTemplatePolicy[]> {
    const response = await lastValueFrom(this.api.get<unknown>("/api/wa/template-policies"));
    const root = this.asRecord(response);
    const items = root?.["items"];
    const rows = Array.isArray(items) ? items : [];
    return rows
      .map((row, index) => this.normalizePolicy(row, `policy-${index + 1}`))
      .filter((row): row is WaTemplatePolicy => row !== null);
  }

  async updateTemplatePolicy(
    useCase: string,
    payload: {
      sendMode: WaSendMode;
      activeTemplateName: string | null;
      activeTemplateLanguage: string;
      fallbackTemplateName: string | null;
      fallbackTemplateLanguage: string;
      notes?: string | null;
      active?: boolean;
    },
  ): Promise<WaTemplatePolicy | null> {
    const safeUseCase = String(useCase || "").trim();
    if (!safeUseCase) return null;
    const response = await lastValueFrom(
      this.api.put<unknown>(`/api/wa/template-policies/${encodeURIComponent(safeUseCase)}`, payload),
    );
    const root = this.asRecord(response);
    return this.normalizePolicy(root?.["policy"], safeUseCase);
  }

  async getSendAttempt(attemptId: string): Promise<WaSendAttempt | null> {
    const safeAttemptId = String(attemptId || "").trim();
    if (!safeAttemptId) return null;
    const response = await lastValueFrom(
      this.api.get<unknown>(`/api/wa/send-attempts/${encodeURIComponent(safeAttemptId)}`),
    );
    const root = this.asRecord(response);
    return this.normalizeAttempt(root?.["attempt"]);
  }

  private normalizeTemplate(raw: unknown, fallbackId: string): WaTemplateRegistryItem | null {
    const record = this.asRecord(raw);
    if (!record) return null;

    const id = this.asString(record["id"]) || fallbackId;
    const templateName = this.asString(record["templateName"]);
    const language = this.asString(record["language"]);
    if (!templateName || !language) return null;

    const useCasesRaw = record["useCases"];
    return {
      id,
      templateName,
      language,
      status: this.asString(record["status"]),
      category: this.asString(record["category"]),
      qualityScore: this.asString(record["qualityScore"]),
      useCases: Array.isArray(useCasesRaw)
        ? useCasesRaw
            .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
            .filter((entry) => Boolean(entry))
        : [],
      syncedAt: this.asString(record["syncedAt"]),
    };
  }

  private normalizePolicy(raw: unknown, fallbackUseCase: string): WaTemplatePolicy | null {
    const record = this.asRecord(raw);
    if (!record) return null;

    const sendModeRaw = this.asString(record["sendMode"]) || "auto";
    const sendMode: WaSendMode =
      sendModeRaw === "template_only" || sendModeRaw === "free_only" ? sendModeRaw : "auto";

    return {
      useCase: this.asString(record["useCase"]) || fallbackUseCase,
      sendMode,
      activeTemplateName: this.asString(record["activeTemplateName"]),
      activeTemplateLanguage: this.asString(record["activeTemplateLanguage"]) || "es_MX",
      fallbackTemplateName: this.asString(record["fallbackTemplateName"]),
      fallbackTemplateLanguage: this.asString(record["fallbackTemplateLanguage"]) || "es_MX",
      notes: this.asString(record["notes"]),
      active: record["active"] !== false,
      createdAt: this.asString(record["createdAt"]),
      updatedAt: this.asString(record["updatedAt"]),
      updatedBy: this.normalizeUpdatedBy(record["updatedBy"]),
    };
  }

  private normalizeAttempt(raw: unknown): WaSendAttempt | null {
    const record = this.asRecord(raw);
    if (!record) return null;
    const attemptId = this.asString(record["attemptId"]);
    const useCase = this.asString(record["useCase"]);
    const state = this.asString(record["state"]);
    if (!attemptId || !useCase || !state) return null;

    const statusHistoryRaw = record["statusHistory"];

    return {
      attemptId,
      useCase,
      state,
      customerId: this.asString(record["customerId"]),
      waId: this.asString(record["waId"]),
      orderId: this.asString(record["orderId"]),
      messageId: this.asString(record["messageId"]),
      createdAt: this.asString(record["createdAt"]),
      updatedAt: this.asString(record["updatedAt"]),
      lastMetaStatus: this.asString(record["lastMetaStatus"]),
      lastMetaStatusAt: this.asString(record["lastMetaStatusAt"]),
      error: this.normalizeAttemptError(record["error"]),
      decision: this.asRecord(record["decision"]),
      result: this.asRecord(record["result"]),
      statusHistory: Array.isArray(statusHistoryRaw)
        ? statusHistoryRaw.filter((entry) => Boolean(this.asRecord(entry))) as Array<Record<string, unknown>>
        : [],
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length ? normalized : null;
  }

  private normalizeUpdatedBy(value: unknown): { uid?: string | null; email?: string | null } | null {
    const record = this.asRecord(value);
    if (!record) return null;
    return {
      uid: this.asString(record["uid"]),
      email: this.asString(record["email"]),
    };
  }

  private normalizeAttemptError(value: unknown): { code?: unknown; details?: string | null } | null {
    const record = this.asRecord(value);
    if (!record) return null;
    return {
      code: record["code"],
      details: this.asString(record["details"]),
    };
  }
}

