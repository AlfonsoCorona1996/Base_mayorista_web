import { CurrencyPipe, DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { Customer, CustomersService } from "../../core/customers.service";
import { FinanceExpense, FinanceService } from "../../core/finance.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { Order, OrdersService } from "../../core/orders.service";
import { LocalitiesService, Locality } from "../../core/localities.service";
import { RoutePlan, RoutesService } from "../../core/routes.service";
import { DispatchOrderRow, RouteRunDoc, RouteRunsService } from "../../services/route-runs.service";

type RouteFilter = "all" | "active" | "inactive";
type RouteSort = "name" | "localities" | "customers" | "lastRun" | "sales" | "expenses" | "profit" | "balance" | "pending" | "status";
type SortDirection = "asc" | "desc";
type DrawerMode = "create" | "edit";

interface RouteDraft {
  route_id: string;
  name: string;
  notes: string;
  active: boolean;
  estimated_run_expense: number | null;
  estimated_run_expense_notes: string;
  locality_ids: string[];
}

interface RouteMetrics {
  localityCount: number;
  customerCount: number;
  lastRunAt: string | null;
  netSales: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  balanceDue: number;
  pendingOrders: number;
  investmentNeeded: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-rutas",
  imports: [FormsModule, CurrencyPipe, DatePipe],
  templateUrl: "./rutas.html",
  styleUrl: "./rutas.css",
})
export default class RutasPage {
  loading = signal(false);
  saving = signal(false);
  togglingId = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  statusFilter = signal<RouteFilter>("all");
  sortBy = signal<RouteSort>("name");
  sortDirection = signal<SortDirection>("asc");
  drawerOpen = signal(false);
  drawerMode = signal<DrawerMode>("create");
  editingId = signal<string | null>(null);
  filtersSheetOpen = signal(false);
  rowMenuOpenId = signal<string | null>(null);
  selectedLocalityId = signal("");
  newLocalityName = signal("");
  newLocalityNotes = signal("");
  editingLocalityId = signal<string | null>(null);
  localityEditName = signal("");
  localityEditNotes = signal("");
  financeAvailable = signal(true);
  runs = signal<RouteRunDoc[]>([]);
  dispatchOrders = signal<DispatchOrderRow[]>([]);

  draft: RouteDraft = this.emptyDraft();

  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);
  private customersService = inject(CustomersService);
  private ordersService = inject(OrdersService);
  private financeService = inject(FinanceService);
  private routeRuns = inject(RouteRunsService);
  private router = inject(Router);

  allRoutes = computed(() => this.routesService.routes());
  activeRoutes = computed(() => this.allRoutes().filter((route) => route.active));
  inactiveCount = computed(() => this.allRoutes().length - this.activeRoutes().length);
  localities = computed(() => this.localitiesService.localities());
  activeLocalities = computed(() => this.localities().filter((locality) => locality.active));
  customers = computed(() => this.customersService.customers());
  orders = computed(() => this.ordersService.list());
  expenses = computed(() => this.financeService.expenses());

  totalLocalities = computed(() => this.allRoutes().reduce((sum, route) => sum + route.locality_ids.length, 0));
  totalNetSales = computed(() => this.allRoutes().reduce((sum, route) => sum + this.routeMetrics(route).netSales, 0));
  totalExpenses = computed(() => this.allRoutes().reduce((sum, route) => sum + this.routeMetrics(route).expenses, 0));
  totalNetProfit = computed(() => this.allRoutes().reduce((sum, route) => sum + this.routeMetrics(route).netProfit, 0));
  totalBalance = computed(() => this.allRoutes().reduce((sum, route) => sum + this.routeMetrics(route).balanceDue, 0));
  totalPending = computed(() => this.allRoutes().reduce((sum, route) => sum + this.routeMetrics(route).pendingOrders, 0));

  hasActiveFilters = computed(() => Boolean(this.searchTerm().trim()) || this.statusFilter() !== "all" || this.sortBy() !== "name" || this.sortDirection() !== "asc");

  filteredRoutes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();
    const sort = this.sortBy();
    const direction = this.sortDirection();

    return [...this.allRoutes()]
      .filter((route) => {
        const statusOk =
          filter === "all" ||
          (filter === "active" && route.active) ||
          (filter === "inactive" && !route.active);
        if (!statusOk) return false;
        if (!term) return true;
        const localityNames = route.locality_ids.map((id) => this.localityName(id)).join(" ");
        const blob = [route.name, route.route_id, route.notes || "", localityNames].join(" ").toLowerCase();
        return blob.includes(term);
      })
      .sort((a, b) => {
        const result = this.compareRoutes(a, b, sort);
        return (direction === "asc" ? result : -result) || this.compareText(a.name, b.name);
      });
  });

  constructor() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    try {
      await Promise.all([
        this.routesService.loadFromFirestore(),
        this.localitiesService.loadFromFirestore(),
        this.customersService.loadFromFirestore(),
        this.ordersService.loadFromFirestore(),
      ]);

      const financeLoaded = await this.financeService.loadAll().then(() => true).catch(() => false);
      this.financeAvailable.set(financeLoaded);
      const [runs, dispatchOrders] = await Promise.all([
        this.routeRuns.listRuns().catch(() => []),
        this.routeRuns.listDispatchOrders().catch(() => []),
      ]);
      this.runs.set(runs);
      this.dispatchOrders.set(dispatchOrders);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar las rutas");
    } finally {
      this.loading.set(false);
    }
  }

  setSearchTerm(value: string) {
    this.searchTerm.set(value);
  }

  onStatusFilterChange(value: string) {
    const next: RouteFilter = value === "active" || value === "inactive" ? value : "all";
    this.statusFilter.set(next);
  }

  setSortBy(value: string) {
    const next = this.coerceSort(value);
    this.sortBy.set(next);
    this.sortDirection.set(this.defaultSortDirection(next));
  }

  setTableSort(sort: RouteSort) {
    if (this.sortBy() === sort) {
      this.sortDirection.set(this.sortDirection() === "asc" ? "desc" : "asc");
    } else {
      this.sortBy.set(sort);
      this.sortDirection.set(this.defaultSortDirection(sort));
    }
  }

  isSortedBy(sort: RouteSort): boolean {
    return this.sortBy() === sort;
  }

  sortIcon(sort: RouteSort): string {
    if (!this.isSortedBy(sort)) return "unfold_more";
    return this.sortDirection() === "asc" ? "arrow_upward" : "arrow_downward";
  }

  clearFilters() {
    this.searchTerm.set("");
    this.statusFilter.set("all");
    this.sortBy.set("name");
    this.sortDirection.set("asc");
    this.filtersSheetOpen.set(false);
  }

  openCreateDrawer() {
    this.startCreate();
    this.drawerMode.set("create");
    this.drawerOpen.set(true);
  }

  openEditDrawer(route: RoutePlan, event?: Event) {
    event?.stopPropagation();
    this.startEdit(route);
    this.drawerMode.set("edit");
    this.drawerOpen.set(true);
    this.rowMenuOpenId.set(null);
  }

  closeDrawer() {
    if (this.saving()) return;
    this.drawerOpen.set(false);
    this.startCreate();
  }

  startCreate() {
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.selectedLocalityId.set("");
    this.newLocalityName.set("");
    this.newLocalityNotes.set("");
    this.cancelLocalityEdit();
    this.error.set(null);
    this.success.set(null);
  }

  startEdit(route: RoutePlan) {
    this.editingId.set(route.route_id);
    this.draft = {
      route_id: route.route_id,
      name: route.name,
      notes: route.notes || "",
      active: route.active,
      estimated_run_expense: route.estimated_run_expense ?? null,
      estimated_run_expense_notes: route.estimated_run_expense_notes || "",
      locality_ids: [...route.locality_ids],
    };
    this.selectedLocalityId.set("");
    this.newLocalityName.set("");
    this.newLocalityNotes.set("");
    this.cancelLocalityEdit();
    this.error.set(null);
    this.success.set(null);
  }

  async saveRoute() {
    this.error.set(null);
    this.success.set(null);
    const name = this.draft.name.trim();
    if (!name) {
      this.error.set("El nombre de la ruta es obligatorio");
      return;
    }

    const routeId = this.editingId() || this.slugify(name);
    if (!routeId) {
      this.error.set("No se pudo generar el identificador de la ruta");
      return;
    }
    if (!this.editingId() && this.routesService.getById(routeId)) {
      this.error.set("Ya existe una ruta con ese nombre");
      return;
    }

    this.saving.set(true);
    try {
      const existing = this.editingId() ? this.routesService.getById(this.editingId()!) : null;
      await this.moveSelectedLocalitiesToRoute(routeId);
      const payload: RoutePlan = {
        route_id: routeId,
        name,
        notes: this.draft.notes.trim(),
        active: this.draft.active,
        estimated_run_expense: this.toNullableAmount(this.draft.estimated_run_expense),
        estimated_run_expense_notes: this.draft.estimated_run_expense_notes.trim() || null,
        locality_ids: this.uniqueIds(this.draft.locality_ids),
        created_at: existing?.created_at || new Date(),
      };
      await this.routesService.save(payload);
      this.success.set(this.editingId() ? "Ruta actualizada" : "Ruta creada");
      this.drawerOpen.set(false);
      this.startCreate();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la ruta");
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActiveFromMenu(route: RoutePlan, event?: Event) {
    event?.stopPropagation();
    this.rowMenuOpenId.set(null);
    await this.toggleActive(route, !route.active);
  }

  async toggleActive(route: RoutePlan, nextActive: boolean) {
    if (route.active === nextActive) return;
    this.togglingId.set(route.route_id);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.routesService.setActive(route.route_id, nextActive);
      this.success.set(nextActive ? "Ruta activada" : "Ruta desactivada");
      if (this.editingId() === route.route_id) this.draft = { ...this.draft, active: nextActive };
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
    } finally {
      this.togglingId.set(null);
    }
  }

  toggleRowMenu(routeId: string, event?: Event) {
    event?.stopPropagation();
    this.rowMenuOpenId.set(this.rowMenuOpenId() === routeId ? null : routeId);
  }

  openRouteDetail(route: RoutePlan, event?: Event) {
    event?.stopPropagation();
    this.rowMenuOpenId.set(null);
    this.router.navigate(["/main/rutas", route.route_id]);
  }

  addExistingLocality() {
    const localityId = this.selectedLocalityId().trim();
    if (!localityId || this.draft.locality_ids.includes(localityId)) return;
    const owner = this.ownerRouteForLocality(localityId);
    if (owner && owner.route_id !== this.editingId()) {
      const ok = window.confirm(`La localidad esta en "${owner.name}". Deseas moverla a esta ruta al guardar?`);
      if (!ok) return;
    }
    this.draft.locality_ids = [...this.draft.locality_ids, localityId];
    this.selectedLocalityId.set("");
  }

  async createLocalityInDraft() {
    this.error.set(null);
    const name = this.newLocalityName().trim();
    if (!name) {
      this.error.set("Escribe el nombre de la localidad");
      return;
    }
    const localityId = this.uniqueLocalityId(name);
    try {
      await this.localitiesService.save({
        locality_id: localityId,
        name,
        notes: this.newLocalityNotes().trim(),
        active: true,
      });
      this.draft.locality_ids = [...this.draft.locality_ids, localityId];
      this.newLocalityName.set("");
      this.newLocalityNotes.set("");
      this.success.set("Localidad agregada");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo crear la localidad");
    }
  }

  removeLocality(index: number) {
    this.draft.locality_ids = this.draft.locality_ids.filter((_, idx) => idx !== index);
  }

  moveLocality(index: number, direction: number) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= this.draft.locality_ids.length) return;
    const next = [...this.draft.locality_ids];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    this.draft.locality_ids = next;
  }

  startLocalityEdit(localityId: string) {
    const locality = this.localitiesService.getById(localityId);
    if (!locality) return;
    this.editingLocalityId.set(localityId);
    this.localityEditName.set(locality.name);
    this.localityEditNotes.set(locality.notes || "");
  }

  cancelLocalityEdit() {
    this.editingLocalityId.set(null);
    this.localityEditName.set("");
    this.localityEditNotes.set("");
  }

  async saveLocalityEdit() {
    const localityId = this.editingLocalityId();
    const locality = localityId ? this.localitiesService.getById(localityId) : null;
    const name = this.localityEditName().trim();
    if (!locality || !name) return;
    try {
      await this.localitiesService.save({
        ...locality,
        name,
        notes: this.localityEditNotes().trim(),
      });
      this.success.set("Localidad actualizada");
      this.cancelLocalityEdit();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar la localidad");
    }
  }

  async toggleLocalityActive(localityId: string) {
    const locality = this.localitiesService.getById(localityId);
    if (!locality) return;
    try {
      await this.localitiesService.setActive(localityId, !locality.active);
      this.success.set(locality.active ? "Localidad desactivada" : "Localidad activada");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar la localidad");
    }
  }

  routeMetrics(route: RoutePlan): RouteMetrics {
    const orders = this.ordersForRoute(route.route_id);
    const delivered = orders.filter((order) => this.isDelivered(order));
    const pending = this.pendingOrdersForRoute(route.route_id);
    const expenses = this.financeAvailable() ? this.expensesForRoute(route.route_id).reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0) : 0;
    let netSales = 0;
    let grossProfit = 0;
    let balanceDue = 0;
    let investmentNeeded = 0;
    for (const order of orders.filter((row) => !this.isCancelled(row))) {
      balanceDue += calculateOrderFinancials(order).balanceDue;
    }
    for (const order of delivered) {
      const financials = calculateOrderFinancials(order);
      netSales += financials.netAmount;
      grossProfit += financials.grossProfit;
    }
    for (const order of pending) {
      investmentNeeded += calculateOrderFinancials(order).netCost;
    }
    const routeRuns = this.runsForRoute(route.route_id);
    const runDates = routeRuns.map((run) => run.scheduled_at).sort();
    const lastRunAt = runDates.length ? runDates[runDates.length - 1] : null;
    return {
      localityCount: route.locality_ids.length,
      customerCount: this.customersForRoute(route.route_id).length,
      lastRunAt,
      netSales,
      grossProfit,
      expenses,
      netProfit: grossProfit - expenses,
      balanceDue,
      pendingOrders: pending.length,
      investmentNeeded: investmentNeeded + Number(route.estimated_run_expense || 0),
    };
  }

  routeStatusLabel(route: RoutePlan): string {
    if (!route.active) return "Inactiva";
    if (this.pendingOrdersForRoute(route.route_id).length > 0) return "Con pendientes";
    return "Activa";
  }

  routeStatusTone(route: RoutePlan): string {
    if (!route.active) return "inactive";
    if (this.pendingOrdersForRoute(route.route_id).length > 0) return "warning";
    return "active";
  }

  localityName(localityId: string): string {
    return this.localitiesService.getById(localityId)?.name || localityId;
  }

  localityOptionLabel(locality: Locality): string {
    const owner = this.ownerRouteForLocality(locality.locality_id);
    return owner ? `${locality.name} - en ${owner.name}` : locality.name;
  }

  localityOptions(): Locality[] {
    const selected = new Set(this.draft.locality_ids);
    return this.activeLocalities().filter((locality) => !selected.has(locality.locality_id));
  }

  ownerRouteName(localityId: string): string {
    return this.ownerRouteForLocality(localityId)?.name || "Sin ruta";
  }

  localityActive(localityId: string): boolean {
    return this.localitiesService.getById(localityId)?.active ?? true;
  }

  isBusy(routeId: string): boolean {
    return this.togglingId() === routeId;
  }

  expenseLabel(route: RoutePlan): string {
    if (this.financeAvailable()) return "";
    if (Number(route.estimated_run_expense || 0) > 0) return "Estimado";
    return "No disponible";
  }

  private ordersForRoute(routeId: string): Order[] {
    return this.orders().filter((order) => order.route_id === routeId);
  }

  private customersForRoute(routeId: string): Customer[] {
    return this.customers().filter((customer) => customer.route_id === routeId);
  }

  private expensesForRoute(routeId: string): FinanceExpense[] {
    return this.expenses().filter((row) => row.route_id === routeId);
  }

  private runsForRoute(routeId: string): RouteRunDoc[] {
    return this.runs().filter((run) => run.route_id === routeId);
  }

  private pendingOrdersForRoute(routeId: string): Order[] {
    return this.ordersForRoute(routeId).filter((order) => {
      if (order.route_run_id) return false;
      if (this.isCancelled(order)) return false;
      return order.status === "ready_for_route" || order.packing?.status === "done" || order.dispatch_request?.status === "requested";
    });
  }

  private ownerRouteForLocality(localityId: string): RoutePlan | null {
    return this.allRoutes().find((route) => route.locality_ids.includes(localityId)) || null;
  }

  private async moveSelectedLocalitiesToRoute(routeId: string) {
    const selected = new Set(this.draft.locality_ids);
    if (selected.size === 0) return;
    const updates = this.allRoutes()
      .filter((route) => route.route_id !== routeId && route.locality_ids.some((id) => selected.has(id)))
      .map((route) => ({
        ...route,
        locality_ids: route.locality_ids.filter((id) => !selected.has(id)),
      }));
    for (const route of updates) {
      await this.routesService.save(route);
    }
  }

  private compareRoutes(a: RoutePlan, b: RoutePlan, sort: RouteSort): number {
    const metricsA = this.routeMetrics(a);
    const metricsB = this.routeMetrics(b);
    if (sort === "localities") return metricsA.localityCount - metricsB.localityCount;
    if (sort === "customers") return metricsA.customerCount - metricsB.customerCount;
    if (sort === "lastRun") return this.time(metricsA.lastRunAt) - this.time(metricsB.lastRunAt);
    if (sort === "sales") return metricsA.netSales - metricsB.netSales;
    if (sort === "expenses") return metricsA.expenses - metricsB.expenses;
    if (sort === "profit") return metricsA.netProfit - metricsB.netProfit;
    if (sort === "balance") return metricsA.balanceDue - metricsB.balanceDue;
    if (sort === "pending") return metricsA.pendingOrders - metricsB.pendingOrders;
    if (sort === "status") return this.compareText(this.routeStatusLabel(a), this.routeStatusLabel(b));
    return this.compareText(a.name, b.name);
  }

  private coerceSort(value: string): RouteSort {
    return (["name", "localities", "customers", "lastRun", "sales", "expenses", "profit", "balance", "pending", "status"] as RouteSort[]).includes(value as RouteSort)
      ? (value as RouteSort)
      : "name";
  }

  private defaultSortDirection(sort: RouteSort): SortDirection {
    return sort === "name" || sort === "status" ? "asc" : "desc";
  }

  private compareText(a: string, b: string): number {
    return a.localeCompare(b, "es", { sensitivity: "base" });
  }

  private time(value: string | null): number {
    return value ? new Date(value).getTime() : 0;
  }

  private isCancelled(order: Order): boolean {
    return ["cancelado", "devuelto"].includes(String(order.status || ""));
  }

  private isDelivered(order: Order): boolean {
    return Boolean(order.delivered_at) || ["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed"].includes(String(order.status || ""));
  }

  private toNullableAmount(value: number | string | null): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Number(parsed.toFixed(2)));
  }

  private uniqueIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  }

  private uniqueLocalityId(name: string): string {
    const base = this.slugify(name) || `localidad-${Date.now().toString(36)}`;
    if (!this.localitiesService.getById(base)) return base;
    return `${base}-${Date.now().toString(36).slice(-4)}`;
  }

  private emptyDraft(): RouteDraft {
    return {
      route_id: "",
      name: "",
      notes: "",
      active: true,
      estimated_run_expense: null,
      estimated_run_expense_notes: "",
      locality_ids: [],
    };
  }

  private slugify(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
