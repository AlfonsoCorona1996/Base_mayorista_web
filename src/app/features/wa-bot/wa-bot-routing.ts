import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { lastValueFrom } from "rxjs";
import { UserAdminApiService } from "../../services/user-admin-api.service";

type WaBotMode = "registration" | "customer_ai" | "blocked";

interface WaBotSettings {
  default_mode: WaBotMode;
}

interface WaBotPolicy {
  wa_id: string;
  mode: WaBotMode;
  active: boolean;
  label: string | null;
  notes: string | null;
  source: string | null;
  updated_at?: any;
}

@Component({
  standalone: true,
  selector: "app-wa-bot-routing",
  imports: [FormsModule],
  templateUrl: "./wa-bot-routing.html",
  styleUrl: "./wa-bot-routing.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export default class WaBotRoutingPage {
  private api = inject(UserAdminApiService);

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  includeInactive = signal(true);
  settings = signal<WaBotSettings>({ default_mode: "blocked" });
  rows = signal<WaBotPolicy[]>([]);

  draftWaId = signal("");
  draftMode = signal<WaBotMode>("registration");
  draftLabel = signal("");
  draftNotes = signal("");
  draftActive = signal(true);

  modeOptions: Array<{ value: WaBotMode; label: string; helper: string }> = [
    {
      value: "registration",
      label: "Registro producto",
      helper: "Usa el flujo actual de recepción y normalización de producto.",
    },
    {
      value: "customer_ai",
      label: "Atención clienta",
      helper: "No entra a registro; queda para conversación de clienta.",
    },
    {
      value: "blocked",
      label: "Bloqueado",
      helper: "Ignora mensajes entrantes de este número.",
    },
  ];

  activeRows = computed(() => this.rows().filter((row) => row.active));
  inactiveRows = computed(() => this.rows().filter((row) => !row.active));

  constructor() {
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await Promise.all([this.loadSettings(), this.loadRows()]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar la configuración del bot.");
    } finally {
      this.loading.set(false);
    }
  }

  async toggleIncludeInactive(next: boolean): Promise<void> {
    this.includeInactive.set(next);
    await this.loadRows();
  }

  async saveSettings(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await lastValueFrom(
        this.api.put<{ ok: boolean; settings: WaBotSettings }>("/api/wa/bot/settings", {
          default_mode: this.settings().default_mode,
        })
      );
      this.success.set("Configuración general actualizada.");
    } catch (error: any) {
      this.error.set(error?.error?.message || error?.message || "No se pudo guardar la configuración.");
    } finally {
      this.saving.set(false);
    }
  }

  onDefaultModeChange(nextMode: WaBotMode): void {
    this.settings.update((current) => ({
      ...current,
      default_mode: nextMode,
    }));
  }

  async saveDraft(): Promise<void> {
    const normalizedWaId = this.normalizeWaId(this.draftWaId());
    if (!normalizedWaId) {
      this.error.set("Ingresa un número de WhatsApp válido.");
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.savePolicy({
        wa_id: normalizedWaId,
        mode: this.draftMode(),
        active: this.draftActive(),
        label: this.draftLabel().trim() || null,
        notes: this.draftNotes().trim() || null,
        source: "manual",
      });
      this.draftWaId.set("");
      this.draftLabel.set("");
      this.draftNotes.set("");
      this.draftMode.set("registration");
      this.draftActive.set(true);
      this.success.set("Número guardado correctamente.");
      await this.loadRows();
    } catch (error: any) {
      this.error.set(error?.error?.message || error?.message || "No se pudo guardar el número.");
    } finally {
      this.saving.set(false);
    }
  }

  async updateMode(row: WaBotPolicy, mode: WaBotMode): Promise<void> {
    if (row.mode === mode) return;
    await this.updateRow(row, { mode });
  }

  async toggleRowActive(row: WaBotPolicy, active: boolean): Promise<void> {
    if (row.active === active) return;
    await this.updateRow(row, { active });
  }

  async deactivateRow(row: WaBotPolicy): Promise<void> {
    if (!row.active) return;
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await lastValueFrom(this.api.post<{ ok: boolean }>(`/api/wa/bot/numbers/${encodeURIComponent(row.wa_id)}/deactivate`, {}));
      this.success.set("Número desactivado.");
      await this.loadRows();
    } catch (error: any) {
      this.error.set(error?.error?.message || error?.message || "No se pudo desactivar el número.");
    } finally {
      this.saving.set(false);
    }
  }

  private async updateRow(
    row: WaBotPolicy,
    patch: Partial<Pick<WaBotPolicy, "mode" | "active" | "label" | "notes">>
  ): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.savePolicy({
        wa_id: row.wa_id,
        mode: patch.mode ?? row.mode,
        active: patch.active ?? row.active,
        label: patch.label ?? row.label ?? null,
        notes: patch.notes ?? row.notes ?? null,
        source: row.source || "manual",
      });
      this.success.set("Número actualizado.");
      await this.loadRows();
    } catch (error: any) {
      this.error.set(error?.error?.message || error?.message || "No se pudo actualizar el número.");
    } finally {
      this.saving.set(false);
    }
  }

  private async loadSettings(): Promise<void> {
    const response = await lastValueFrom(
      this.api.get<{ settings: WaBotSettings }>("/api/wa/bot/settings")
    );
    this.settings.set(response.settings || { default_mode: "blocked" });
  }

  private async loadRows(): Promise<void> {
    const response = await lastValueFrom(
      this.api.get<{ items: WaBotPolicy[] }>(
        `/api/wa/bot/numbers?includeInactive=${this.includeInactive() ? "true" : "false"}`
      )
    );
    const rows = Array.isArray(response.items) ? response.items : [];
    this.rows.set(
      rows.sort((a, b) => String(a.wa_id || "").localeCompare(String(b.wa_id || "")))
    );
  }

  private async savePolicy(payload: {
    wa_id: string;
    mode: WaBotMode;
    active: boolean;
    label: string | null;
    notes: string | null;
    source: string;
  }): Promise<void> {
    await lastValueFrom(
      this.api.put<{ ok: boolean; policy: WaBotPolicy }>(
        `/api/wa/bot/numbers/${encodeURIComponent(payload.wa_id)}`,
        payload
      )
    );
  }

  private normalizeWaId(input: string): string {
    return String(input || "").replace(/\D/g, "");
  }
}
