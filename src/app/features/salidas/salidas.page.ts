import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { AuthzService } from "../../core/authz.service";
import { CustomersService } from "../../core/customers.service";
import { RoutesService } from "../../core/routes.service";
import {
  DispatchOrderRow,
  RouteRunDoc,
  RouteRunStopDoc,
  RouteRunsService,
} from "../../services/route-runs.service";

type DispatchCard = DispatchOrderRow & {
  routeName: string;
  customerName: string;
  processLabel?: string;
  processTone?: "confirmar" | "espera" | "empaque";
  requestedRunChip?: string | null;
};
type ScheduleSheetMode = "programar" | "solicitar" | "cambiar";

type RouteBoardGroup = {
  routeId: string;
  routeName: string;
  programados: Array<{
    run: RouteRunDoc;
    stops: RouteRunStopDoc[];
    scheduledDateLabel: string;
    balanceLabel: string;
  }>;
  solicitudes: DispatchCard[];
  listos: DispatchCard[];
  empacando: DispatchCard[];
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-salidas-page",
  templateUrl: "./salidas.page.html",
  styleUrl: "./salidas.page.css",
})
export default class SalidasPage {
  private routeRuns = inject(RouteRunsService);
  private routes = inject(RoutesService);
  private customers = inject(CustomersService);
  private authz = inject(AuthzService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private openRouteOnLoad: string | null = null;

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  toast = signal<string | null>(null);
  orders = signal<DispatchCard[]>([]);
  runs = signal<RouteRunDoc[]>([]);
  stopsByRunId = signal<Record<string, RouteRunStopDoc[]>>({});
  openRoutes = signal<Record<string, boolean>>({});
  routeSearch = signal("");
  selectedRouteId = signal<string>("all");
  showRouteSuggestions = signal(false);
  private readonly moneyFormatter = new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  });
  private readonly runDateFormatter = new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  canRunCreate = computed(() => this.authz.canCap("cap.runs.create"));
  canRunSchedule = computed(() => this.authz.canCap("cap.runs.schedule"));
  canDispatchRequest = computed(() => this.authz.canCap("cap.dispatch.request"));
  canDispatchCancel = computed(() => this.authz.canCap("cap.dispatch.cancel_request"));
  canDispatchAccept = computed(() => this.authz.canCap("cap.dispatch.accept_request") && this.authz.canCap("cap.runs.add_order"));
  canDispatchReject = computed(() => this.authz.canCap("cap.dispatch.reject_request"));
  canProgramOrder = computed(() => this.canDispatchAccept() && this.canDispatchReject());
  canRequestOrder = computed(() => !this.canProgramOrder() && this.canDispatchRequest() && this.canDispatchCancel());

  scheduleSheetOpen = signal(false);
  scheduleSheetMode = signal<ScheduleSheetMode | null>(null);
  scheduleSheetOrder = signal<DispatchCard | null>(null);
  scheduleSheetRuns = signal<RouteRunDoc[]>([]);
  scheduleSheetRunId = signal("");

  groups = computed<RouteBoardGroup[]>(() => {
    const runs = this.runs();
    const stopsByRunId = this.stopsByRunId();
    const orders = this.orders();
    const routeMap = new Map<string, RouteBoardGroup>();

    const ensureGroup = (routeId: string, routeName: string) => {
      const key = routeId || "sin_ruta";
      const existing = routeMap.get(key);
      if (existing) return existing;
      const created: RouteBoardGroup = {
        routeId: key,
        routeName: routeName || "Sin ruta",
        programados: [],
        solicitudes: [],
        listos: [],
        empacando: [],
      };
      routeMap.set(key, created);
      return created;
    };

    for (const run of runs) {
      const group = ensureGroup(run.route_id, run.route_name_snapshot);
      group.programados.push({
        run,
        stops: stopsByRunId[run.runId] || [],
        scheduledDateLabel: this.runDate(run.scheduled_at),
        balanceLabel: this.money(run.counts.balance_total),
      });
    }

    for (const row of orders) {
      const group = ensureGroup(row.route_id || "sin_ruta", row.routeName);
      if (row.route_run_id) continue;

      const requestStatus = row.dispatch_request.status || "none";
      const isReady = row.status === "ready_for_route" || (row.packing.status === "done" && row.status !== "assigned_to_run");
      const process = this.resolvePackingProcess(row);

      if (requestStatus === "requested") {
        group.solicitudes.push(row);
      } else if (isReady) {
        group.listos.push(row);
      } else if (process) {
        group.empacando.push({
          ...row,
          processLabel: process.label,
          processTone: process.tone,
        });
      }
    }

    for (const group of routeMap.values()) {
      group.programados.sort((a, b) => (a.run.scheduled_at < b.run.scheduled_at ? -1 : 1));
    }

    return [...routeMap.values()]
      .filter((row) => row.programados.length > 0 || row.solicitudes.length > 0 || row.listos.length > 0 || row.empacando.length > 0)
      .sort((a, b) => a.routeName.localeCompare(b.routeName));
  });
  routeOptions = computed(() => this.groups().map((group) => ({ routeId: group.routeId, routeName: group.routeName })));
  filteredRouteOptions = computed(() => {
    const query = this.routeSearch().trim().toLocaleLowerCase();
    if (!query) return [];
    return this.routeOptions().filter((route) => route.routeName.toLocaleLowerCase().includes(query));
  });
  visibleGroups = computed<RouteBoardGroup[]>(() => {
    const query = this.routeSearch().trim().toLocaleLowerCase();
    if (query) {
      return this.groups().filter((group) => group.routeName.toLocaleLowerCase().includes(query));
    }
    const selectedRouteId = this.selectedRouteId();
    if (selectedRouteId === "all") return this.groups();
    return this.groups().filter((group) => group.routeId === selectedRouteId);
  });

  constructor() {
    const routeId = String(this.route.snapshot.queryParamMap.get("routeId") || "").trim();
    const shouldOpenRoute = this.route.snapshot.queryParamMap.get("openRoute") === "1";
    if (routeId && routeId !== "all") {
      this.selectedRouteId.set(routeId);
      if (shouldOpenRoute) this.openRouteOnLoad = routeId;
    }
    this.refresh().catch(() => null);
  }

  async refresh() {
    this.loading.set(true);
    this.error.set(null);
    this.toast.set(null);
    try {
      await this.authz.refresh();
      await Promise.all([this.routes.loadFromFirestore().catch(() => null), this.customers.loadFromFirestore().catch(() => null)]);

      const [ordersRaw, runsRaw] = await Promise.all([this.routeRuns.listDispatchOrders(), this.routeRuns.listRuns()]);
      const activeRuns = runsRaw.filter((run) => run.status === "draft" || run.status === "scheduled");
      const runStopsPairs = await Promise.all(
        activeRuns.map(async (run) => [run.runId, await this.routeRuns.listStops(run.runId)] as const),
      );
      this.stopsByRunId.set(Object.fromEntries(runStopsPairs));

      const cards = ordersRaw.map((row) => ({
        ...row,
        routeName: this.routeName(row.route_id),
        customerName: this.customerName(row.customer_id),
        requestedRunChip: this.requestedRunChip(row),
      }));
      this.orders.set(cards);
      this.runs.set(activeRuns);
      if (this.selectedRouteId() !== "all" && !this.groups().some((row) => row.routeId === this.selectedRouteId())) {
        this.selectedRouteId.set("all");
      }
      this.openRoutes.set(
        this.groups().reduce(
          (acc, row) => ({ ...acc, [row.routeId]: acc[row.routeId] ?? false }),
          this.openRoutes(),
        ),
      );
      if (this.openRouteOnLoad) {
        const targetRoute = this.openRouteOnLoad;
        if (this.groups().some((row) => row.routeId === targetRoute)) {
          this.openRoutes.update((current) => ({
            ...current,
            [targetRoute]: true,
          }));
        }
        this.openRouteOnLoad = null;
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar salidas.");
    } finally {
      this.loading.set(false);
    }
  }

  toggleRoute(routeId: string) {
    this.openRoutes.update((current) => ({
      ...current,
      [routeId]: !current[routeId],
    }));
  }

  isRouteOpen(routeId: string): boolean {
    return this.openRoutes()[routeId] === true;
  }

  onRouteSearch(value: string) {
    this.routeSearch.set(value);
    this.selectedRouteId.set("all");
    this.showRouteSuggestions.set(value.trim().length > 0);
  }

  onRouteInputFocus() {
    this.showRouteSuggestions.set(this.routeSearch().trim().length > 0);
  }

  onRouteInputBlur() {
    window.setTimeout(() => this.showRouteSuggestions.set(false), 120);
  }

  selectRoute(event: MouseEvent, routeId: string, routeName: string) {
    event.preventDefault();
    this.routeSearch.set(routeName);
    this.selectedRouteId.set(routeId);
    this.showRouteSuggestions.set(false);
  }

  async requestDispatch(row: DispatchCard) {
    const actor = this.currentActor();
    if (!actor) return;
    this.saving.set(true);
    try {
      await this.routeRuns.requestDispatch(row.order_id, actor);
      this.toast.set("Solicitud enviada.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo solicitar salida.");
    } finally {
      this.saving.set(false);
    }
  }

  async acceptDispatch(row: DispatchCard) {
    const actor = this.currentActor();
    if (!actor) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const runId = await this.routeRuns.acceptDispatchRequest({
        order: row,
        routeName: row.routeName,
        customerName: row.customerName,
        actor,
      });
      this.toast.set("Pedido agregado a salida.");
      await this.refresh();
      await this.router.navigateByUrl(`/main/salidas/${runId}`);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo aceptar la solicitud.");
    } finally {
      this.saving.set(false);
    }
  }

  async rejectDispatch(row: DispatchCard) {
    const actor = this.currentActor();
    if (!actor) return;
    this.saving.set(true);
    try {
      await this.routeRuns.rejectDispatchRequest(row.order_id, actor);
      this.toast.set("Solicitud rechazada.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo rechazar la solicitud.");
    } finally {
      this.saving.set(false);
    }
  }

  async createRun(group: RouteBoardGroup) {
    const actor = this.currentActor();
    if (!actor) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const runId = await this.routeRuns.createDraftRun(group.routeId, group.routeName, actor);
      this.toast.set("Salida programada en borrador.");
      await this.refresh();
      await this.router.navigateByUrl(`/main/salidas/${runId}`);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo programar salida.");
    } finally {
      this.saving.set(false);
    }
  }

  goRun(runId: string) {
    this.router.navigateByUrl(`/main/salidas/${runId}`);
  }

  goOrder(orderId: string, routeId?: string) {
    this.router.navigate(["/main/pedidos", orderId], {
      state: {
        from: "salidas",
        routeId: routeId || null,
      },
    });
  }

  openScheduleSheet(row: DispatchCard, mode: ScheduleSheetMode, event?: MouseEvent) {
    event?.stopPropagation();
    const runs = this.upcomingRunsForRoute(row.route_id);
    if (runs.length === 0) {
      this.error.set("No hay salidas programadas para esta ruta desde hoy en adelante.");
      return;
    }
    this.error.set(null);
    this.scheduleSheetOrder.set(row);
    this.scheduleSheetMode.set(mode);
    this.scheduleSheetRuns.set(runs);
    this.scheduleSheetRunId.set(runs[0].runId);
    this.scheduleSheetOpen.set(true);
  }

  closeScheduleSheet() {
    this.scheduleSheetOpen.set(false);
    this.scheduleSheetMode.set(null);
    this.scheduleSheetOrder.set(null);
    this.scheduleSheetRuns.set([]);
    this.scheduleSheetRunId.set("");
  }

  onScheduleRunChange(value: string) {
    this.scheduleSheetRunId.set(value || "");
  }

  scheduleActionLabel(): string {
    switch (this.scheduleSheetMode()) {
      case "programar":
        return "Programar";
      case "solicitar":
        return "Solicitar salida";
      case "cambiar":
        return "Cambiar salida";
      default:
        return "Guardar";
    }
  }

  scheduleRunLabel(run: RouteRunDoc): string {
    const driver = run.driver?.name ? ` · ${run.driver?.name}` : "";
    return `${this.runDate(run.scheduled_at)}${driver}`;
  }

  requestedRunChip(row: Pick<DispatchOrderRow, "dispatch_request">): string | null {
    const parsed = this.parseDispatchTarget(row.dispatch_request.note);
    if (!parsed?.scheduledAt) return null;
    return this.runDate(parsed.scheduledAt);
  }

  async confirmScheduleSheet() {
    const row = this.scheduleSheetOrder();
    const mode = this.scheduleSheetMode();
    const runId = this.scheduleSheetRunId();
    if (!row || !mode || !runId) return;
    const run = this.scheduleSheetRuns().find((entry) => entry.runId === runId);
    if (!run) {
      this.error.set("Selecciona una salida valida.");
      return;
    }
    const actor = this.currentActor();
    if (!actor) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      if (mode === "programar") {
        const assignedRunId = await this.routeRuns.acceptDispatchRequest({
          order: row,
          routeName: row.routeName,
          customerName: row.customerName,
          actor,
          runId: run.runId,
          scheduledDate: new Date(run.scheduled_at),
        });
        this.toast.set("Pedido programado en salida.");
        this.closeScheduleSheet();
        await this.refresh();
        await this.router.navigateByUrl(`/main/salidas/${assignedRunId}`);
        return;
      }

      await this.routeRuns.requestDispatch(row.order_id, actor, this.buildDispatchTargetNote(run));
      this.toast.set(mode === "cambiar" ? "Solicitud actualizada." : "Solicitud enviada.");
      this.closeScheduleSheet();
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la programacion.");
    } finally {
      this.saving.set(false);
    }
  }

  async cancelDispatchFromCard(row: DispatchCard, event?: MouseEvent) {
    event?.stopPropagation();
    const actor = this.currentActor();
    if (!actor) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.routeRuns.cancelDispatchRequest(row.order_id, actor);
      this.toast.set("Solicitud cancelada.");
      await this.refresh();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cancelar la solicitud.");
    } finally {
      this.saving.set(false);
    }
  }

  routeName(routeId: string | null): string {
    if (!routeId || routeId === "sin_ruta") return "Sin ruta";
    return this.routes.getById(routeId)?.name || routeId;
  }

  customerName(customerId: string): string {
    const row = this.customers.getById(customerId);
    if (!row) return customerId || "Cliente";
    return `${row.first_name} ${row.last_name}`.trim() || customerId;
  }

  money(value: number): string {
    return this.moneyFormatter.format(value || 0);
  }

  runDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return this.runDateFormatter.format(date);
  }

  private upcomingRunsForRoute(routeId: string | null): RouteRunDoc[] {
    if (!routeId) return [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.runs()
      .filter((run) => run.route_id === routeId && new Date(run.scheduled_at).getTime() >= start.getTime())
      .sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1));
  }

  private buildDispatchTargetNote(run: RouteRunDoc): string {
    return `RUN_TARGET:${run.runId}|${run.scheduled_at}`;
  }

  private parseDispatchTarget(note: string | null | undefined): { runId: string; scheduledAt: string } | null {
    if (!note || !note.startsWith("RUN_TARGET:")) return null;
    const payload = note.replace("RUN_TARGET:", "");
    const [runId, scheduledAt] = payload.split("|");
    if (!runId || !scheduledAt) return null;
    return { runId, scheduledAt };
  }

  private resolvePackingProcess(row: DispatchCard): { label: string; tone: "confirmar" | "espera" | "empaque" } | null {
    const status = (row.status || "").toLowerCase();
    const porConfirmar = ["borrador", "confirmando_proveedor", "reservado_inventario", "solicitado_proveedor"];
    const enTransito = ["supplier_processing", "inbound_in_transit", "en_transito"];
    const enEmpaque = ["recibido_qa", "packing", "empaque"];

    if (porConfirmar.includes(status)) {
      return { label: "Levantando pedido", tone: "confirmar" };
    }
    if (enTransito.includes(status)) {
      return { label: "En espera de mercancia", tone: "espera" };
    }
    if (enEmpaque.includes(status) || row.packing.status === "in_progress") {
      return { label: "Empacando", tone: "empaque" };
    }
    return null;
  }

  private currentActor(): { uid: string; name: string } | null {
    const user = this.authz.currentUserSig();
    if (!user) {
      this.error.set("No hay usuario activo.");
      return null;
    }
    return {
      uid: user.uid,
      name: user.displayName || user.email || "Usuario",
    };
  }
}
