import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { DatePipe, NgClass } from "@angular/common";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { AuthzService } from "../../core/authz.service";
import {
  RouteRunDoc,
  RouteRunStopBusinessSummary,
  RouteRunStopDoc,
  RouteRunsService,
  StopStatus,
} from "../../services/route-runs.service";
import { BusinessId } from "../../core/rbac.constants";
import { OrdersService } from "../../core/orders.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-salida-detalle-page",
  imports: [RouterLink, DatePipe, NgClass],
  templateUrl: "./salida-detalle.page.html",
  styleUrl: "./salida-detalle.page.css",
})
export default class SalidaDetallePage {
  private route = inject(ActivatedRoute);
  private routeRuns = inject(RouteRunsService);
  private authz = inject(AuthzService);
  private router = inject(Router);
  private orders = inject(OrdersService);

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

  setupOpen = signal(true);
  markingStopId = signal<string | null>(null);

  // Progreso de paradas
  deliveredCount = computed(() => this.stops().filter(s => s.stop_status === "delivered" || s.stop_status === "partial").length);
  failedCount    = computed(() => this.stops().filter(s => s.stop_status === "failed").length);
  pendingCount   = computed(() => this.stops().filter(s => s.stop_status === "pending").length);

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
      const [run, stops] = await Promise.all([this.routeRuns.getRun(runId), this.routeRuns.listStops(runId), this.orders.loadFromFirestore()]);
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

  async markStop(stopId: string, status: StopStatus): Promise<void> {
    const run = this.run();
    if (!run || this.markingStopId()) return;
    const stop = this.stops().find((row) => row.stop_id === stopId);
    this.markingStopId.set(stopId);
    this.error.set(null);
    try {
      await this.routeRuns.markStop(run.runId, stopId, status);
      if (stop && (status === "delivered" || status === "partial")) {
        const orderStatus = status === "delivered" ? "delivered" : "delivered_partial";
        for (const orderId of stop.order_ids.length ? stop.order_ids : [stop.order_id]) {
          await this.orders.updateStatus(orderId, orderStatus);
        }
      }
      this.stops.update(rows => rows.map(s =>
        s.stop_id === stopId ? { ...s, stop_status: status } : s
      ));
    } catch (err: any) {
      this.error.set(err?.message || "No se pudo actualizar la parada.");
    } finally {
      this.markingStopId.set(null);
    }
  }

  stopStatusLabel(s: StopStatus): string {
    return { pending: "Pendiente", delivered: "Entregado", partial: "Parcial", failed: "No entregado" }[s];
  }

  stopStatusClass(s: StopStatus): string {
    return { pending: "stop-pending", delivered: "stop-delivered", partial: "stop-partial", failed: "stop-failed" }[s];
  }

  money(value: number): string {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(value || 0);
  }

  businessSummaries(stop: RouteRunStopDoc): RouteRunStopBusinessSummary[] {
    const summaries = stop.business_summaries || {};
    return (["bm", "catalogo"] as BusinessId[])
      .map((id) => summaries[id])
      .filter((summary): summary is RouteRunStopBusinessSummary => Boolean(summary));
  }

  businessSummaryClass(summary: RouteRunStopBusinessSummary): string {
    return summary.business_id === "catalogo" ? "business-catalogo" : "business-bm";
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
