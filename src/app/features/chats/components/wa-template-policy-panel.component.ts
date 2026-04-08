import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import {
  WaSendAttempt,
  WaSendMode,
  WaTemplateAdminApi,
  WaTemplatePolicy,
  WaTemplateRegistryItem,
} from "../data/wa-template-admin.api";

type TemplateOption = {
  key: string;
  name: string;
  language: string;
  label: string;
  status: string | null;
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-wa-template-policy-panel",
  imports: [FormsModule],
  templateUrl: "./wa-template-policy-panel.component.html",
  styleUrl: "./wa-template-policy-panel.component.css",
})
export class WaTemplatePolicyPanelComponent {
  private readonly api = inject(WaTemplateAdminApi);
  private readonly useCase = "sales_note";

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly syncing = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  readonly policy = signal<WaTemplatePolicy | null>(null);
  readonly templates = signal<WaTemplateRegistryItem[]>([]);

  readonly sendMode = signal<WaSendMode>("auto");
  readonly active = signal(true);
  readonly activeTemplateKey = signal("");
  readonly fallbackTemplateKey = signal("");
  readonly notes = signal("");

  readonly attemptIdInput = signal("");
  readonly attemptLoading = signal(false);
  readonly attemptError = signal<string | null>(null);
  readonly attempt = signal<WaSendAttempt | null>(null);

  readonly templateOptions = computed<TemplateOption[]>(() => {
    const rows = this.templates();
    return rows
      .map((item) => ({
        key: this.serializeTemplateKey(item.templateName, item.language),
        name: item.templateName,
        language: item.language,
        label: `${item.templateName} (${item.language})`,
        status: item.status,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
  });

  readonly hasUnsavedChanges = computed(() => {
    const current = this.policy();
    if (!current) return false;
    return (
      this.sendMode() !== current.sendMode ||
      this.active() !== current.active ||
      this.activeTemplateKey() !==
        this.serializeTemplateKey(current.activeTemplateName, current.activeTemplateLanguage) ||
      this.fallbackTemplateKey() !==
        this.serializeTemplateKey(current.fallbackTemplateName, current.fallbackTemplateLanguage) ||
      this.notes().trim() !== (current.notes || "")
    );
  });

  readonly attemptJson = computed(() => {
    const current = this.attempt();
    if (!current) return "";
    try {
      return JSON.stringify(current, null, 2);
    } catch {
      return "";
    }
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const [policy, templates] = await Promise.all([
        this.api.getTemplatePolicy(this.useCase),
        this.api.listTemplates(),
      ]);
      this.templates.set(templates);
      this.applyPolicy(policy);
    } catch (error: unknown) {
      this.error.set(this.readErrorMessage(error, "No se pudo cargar la configuracion de plantillas."));
    } finally {
      this.loading.set(false);
    }
  }

  async syncTemplates(): Promise<void> {
    this.syncing.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const result = await this.api.syncTemplates(10);
      const templates = await this.api.listTemplates();
      this.templates.set(templates);
      this.success.set(
        `Plantillas sincronizadas. upserted=${result.upserted} syncedAt=${result.syncedAt || "n/a"}`,
      );
    } catch (error: unknown) {
      this.error.set(this.readErrorMessage(error, "No se pudo sincronizar plantillas desde Meta."));
    } finally {
      this.syncing.set(false);
    }
  }

  async savePolicy(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const activeTemplate = this.parseTemplateKey(this.activeTemplateKey());
      const fallbackTemplate = this.parseTemplateKey(this.fallbackTemplateKey());

      const updated = await this.api.updateTemplatePolicy(this.useCase, {
        sendMode: this.sendMode(),
        active: this.active(),
        activeTemplateName: activeTemplate?.name || null,
        activeTemplateLanguage: activeTemplate?.language || "es_MX",
        fallbackTemplateName: fallbackTemplate?.name || null,
        fallbackTemplateLanguage: fallbackTemplate?.language || "es_MX",
        notes: this.notes().trim() || null,
      });

      this.applyPolicy(updated);
      this.success.set("Politica guardada.");
    } catch (error: unknown) {
      this.error.set(this.readErrorMessage(error, "No se pudo guardar la politica de envio."));
    } finally {
      this.saving.set(false);
    }
  }

  async fetchAttempt(): Promise<void> {
    const attemptId = this.attemptIdInput().trim();
    if (!attemptId) {
      this.attemptError.set("Escribe un attempt_id.");
      this.attempt.set(null);
      return;
    }
    this.attemptLoading.set(true);
    this.attemptError.set(null);
    this.attempt.set(null);
    try {
      const attempt = await this.api.getSendAttempt(attemptId);
      if (!attempt) {
        this.attemptError.set("No existe un intento con ese id.");
        return;
      }
      this.attempt.set(attempt);
    } catch (error: unknown) {
      this.attemptError.set(this.readErrorMessage(error, "No se pudo consultar el intento."));
    } finally {
      this.attemptLoading.set(false);
    }
  }

  setSendMode(value: unknown): void {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "template_only" || raw === "free_only") {
      this.sendMode.set(raw);
      return;
    }
    this.sendMode.set("auto");
  }

  setActive(value: unknown): void {
    this.active.set(Boolean(value));
  }

  setActiveTemplateKey(value: unknown): void {
    this.activeTemplateKey.set(String(value || "").trim());
  }

  setFallbackTemplateKey(value: unknown): void {
    this.fallbackTemplateKey.set(String(value || "").trim());
  }

  setNotes(value: unknown): void {
    this.notes.set(String(value || ""));
  }

  setAttemptIdInput(value: unknown): void {
    this.attemptIdInput.set(String(value || "").trim());
  }

  trackTemplate(_index: number, template: TemplateOption): string {
    return template.key;
  }

  private applyPolicy(policy: WaTemplatePolicy | null): void {
    const normalized: WaTemplatePolicy = policy || {
      useCase: this.useCase,
      sendMode: "auto",
      activeTemplateName: null,
      activeTemplateLanguage: "es_MX",
      fallbackTemplateName: null,
      fallbackTemplateLanguage: "es_MX",
      notes: null,
      active: false,
      createdAt: null,
      updatedAt: null,
      updatedBy: null,
    };

    this.policy.set(normalized);
    this.sendMode.set(normalized.sendMode);
    this.active.set(normalized.active);
    this.activeTemplateKey.set(
      this.serializeTemplateKey(normalized.activeTemplateName, normalized.activeTemplateLanguage),
    );
    this.fallbackTemplateKey.set(
      this.serializeTemplateKey(
        normalized.fallbackTemplateName,
        normalized.fallbackTemplateLanguage,
      ),
    );
    this.notes.set(normalized.notes || "");
  }

  private serializeTemplateKey(name: string | null, language: string | null): string {
    const templateName = String(name || "").trim();
    const templateLanguage = String(language || "").trim();
    if (!templateName || !templateLanguage) return "";
    return `${templateName}::${templateLanguage}`;
  }

  private parseTemplateKey(key: string): { name: string; language: string } | null {
    const raw = String(key || "").trim();
    if (!raw) return null;
    const [name, language] = raw.split("::");
    if (!name || !language) return null;
    return {
      name: name.trim(),
      language: language.trim(),
    };
  }

  private readErrorMessage(error: unknown, fallback: string): string {
    const http = error instanceof HttpErrorResponse ? error : null;
    const payload =
      (http?.error && typeof http.error === "object"
        ? (http.error as Record<string, unknown>)
        : null) || null;
    const backendMessage = payload?.["message"];
    if (typeof backendMessage === "string" && backendMessage.trim()) {
      return backendMessage.trim();
    }
    const generic = (error as { message?: string } | null)?.message;
    if (typeof generic === "string" && generic.trim()) {
      return generic.trim();
    }
    return fallback;
  }
}
