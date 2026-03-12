import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { DatePipe } from "@angular/common";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { AuthzService } from "../../core/authz.service";
import { RouteRunDoc, RouteRunStopDoc, RouteRunsService } from "../../services/route-runs.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-salida-detalle-page",
  imports: [RouterLink, DatePipe],
  templateUrl: "./salida-detalle.page.html",
  styleUrl: "./salida-detalle.page.css",
})
export default class SalidaDetallePage {
  private route = inject(ActivatedRoute);
  private routeRuns = inject(RouteRunsService);
  private authz = inject(AuthzService);
  private router = inject(Router);

  runId = signal("");
  run = signal<RouteRunDoc | null>(null);
  stops = signal<RouteRunStopDoc[]>([]);
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  toast = signal<string | null>(null);
  scheduleInput = signal("");
  driverUid = signal("");
  driverName = signal("");

  canSchedule = computed(() => this.authz.canCap("cap.runs.schedule"));
  canAssignDriver = computed(() => this.authz.canCap("cap.runs.assign_driver"));
  canStart = computed(() => this.authz.canCap("cap.runs.start"));
  canComplete = computed(() => this.authz.canCap("cap.runs.complete"));
  canCancel = computed(() => this.authz.canCap("cap.runs.cancel"));

  constructor() {
    this.runId.set(this.route.snapshot.paramMap.get("runId") || "");
    this.refresh().catch(() => null);
  }

  async refresh() {
    const runId = this.runId();
    if (!runId) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.authz.refresh();
      const [run, stops] = await Promise.all([this.routeRuns.getRun(runId), this.routeRuns.listStops(runId)]);
      this.run.set(run);
      this.stops.set(stops);
      if (run) {
        this.scheduleInput.set(this.toDateInput(run.scheduled_at));
        this.driverUid.set(run.driver?.uid || "");
        this.driverName.set(run.driver?.name || "");
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar la salida.");
    } finally {
      this.loading.set(false);
    }
  }

  async saveSchedule() {
    const run = this.run();
    if (!run || !this.canSchedule()) return;
    const value = this.scheduleInput().trim();
    if (!value) return;
    const date = this.fromDateInput(value);
    if (Number.isNaN(date.getTime())) return;

    this.saving.set(true);
    try {
      await this.routeRuns.updateRunSchedule(run.runId, date);
      this.toast.set("Horario actualizado.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar horario.");
    } finally {
      this.saving.set(false);
    }
  }

  async saveDriver() {
    const run = this.run();
    if (!run || !this.canAssignDriver()) return;
    this.saving.set(true);
    try {
      const uid = this.driverUid().trim();
      const name = this.driverName().trim();
      await this.routeRuns.assignRunDriver(run.runId, uid && name ? { uid, name } : null);
      this.toast.set("Repartidor actualizado.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo asignar repartidor.");
    } finally {
      this.saving.set(false);
    }
  }

  async startRun() {
    const run = this.run();
    if (!run || !this.canStart()) return;
    this.saving.set(true);
    try {
      await this.routeRuns.updateRunStatus(run.runId, "in_transit");
      this.toast.set("Salida iniciada.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo iniciar la salida.");
    } finally {
      this.saving.set(false);
    }
  }

  async completeRun() {
    const run = this.run();
    if (!run || !this.canComplete()) return;
    this.saving.set(true);
    try {
      await this.routeRuns.updateRunStatus(run.runId, "completed");
      this.toast.set("Salida completada.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo completar la salida.");
    } finally {
      this.saving.set(false);
    }
  }

  canCancelRun(run: RouteRunDoc | null): boolean {
    if (!run) return false;
    return run.status === "draft" || run.status === "scheduled";
  }

  async cancelRun() {
    const run = this.run();
    if (!run || !this.canCancel() || !this.canCancelRun(run)) return;
    const confirmed = window.confirm("Esta accion cancelara la salida programada. Deseas continuar?");
    if (!confirmed) return;
    this.saving.set(true);
    try {
      await this.routeRuns.updateRunStatus(run.runId, "cancelled");
      this.toast.set("Salida cancelada.");
      await this.refresh();
      await this.router.navigateByUrl("/main/salidas");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cancelar la salida.");
    } finally {
      this.saving.set(false);
    }
  }

  async copyDeliveryList() {
    const text = this.stops()
      .map((row) => `${row.order_number} · ${row.customer_name} · ${row.packages_count} paq · ${this.money(row.balance_due)}`)
      .join("\n");
    await navigator.clipboard.writeText(text || "Sin entregas.");
    this.toast.set("Lista copiada.");
  }

  async copyAddresses() {
    const text = this.stops()
      .map((row) => {
        const address = row.address_snapshot ? JSON.stringify(row.address_snapshot) : "Sin direccion";
        return `${row.customer_name}: ${address}`;
      })
      .join("\n");
    await navigator.clipboard.writeText(text || "Sin direcciones.");
    this.toast.set("Direcciones copiadas.");
  }

  money(value: number): string {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(value || 0);
  }

  statusLabel(status: string): string {
    if (status === "draft") return "Borrador";
    if (status === "scheduled") return "Programada";
    if (status === "in_transit") return "En transito";
    if (status === "completed") return "Completada";
    return "Cancelada";
  }

  private toDateInput(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private fromDateInput(value: string): Date {
    const [yearRaw, monthRaw, dayRaw] = value.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      return new Date(NaN);
    }
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }
}
