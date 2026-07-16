import { CurrencyPipe, DatePipe, PercentPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { AuthzService } from "../../core/authz.service";
import { Customer, CustomersService } from "../../core/customers.service";
import { FinanceExpenseCategory, FinanceService } from "../../core/finance.service";
import { LocalitiesService, Locality } from "../../core/localities.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { Order, OrdersService } from "../../core/orders.service";
import { RouteExpenseTemplate, RoutePlan, RoutesService } from "../../core/routes.service";
import { DispatchOrderRow, RouteRunDoc, RouteRunsService, RunActor } from "../../services/route-runs.service";

type RouteTab = "summary" | "runs" | "orders" | "customers" | "expenses" | "localities";
type RunPlannerStatus = "draft" | "scheduled";
type LocalityEditorMode = "create" | "edit";

interface RouteSummary {
  netSales: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  margin: number;
  balanceDue: number;
  returnsAmount: number;
  pendingOrders: number;
  investmentNeeded: number;
}

interface RunInsight {
  run: RouteRunDoc;
  ordersCount: number;
  saleTotal: number;
  cost: number;
  grossProfit: number;
  expense: number;
  expenseSource: "real" | "estimated" | "none";
  netProfit: number;
  packages: number;
  balanceDue: number;
  needsRealExpense: boolean;
}

interface CustomerInsight {
  customer: Customer;
  orders: number;
  netSales: number;
  ticket: number;
  balanceDue: number;
  lastOrder: string | null;
}

interface PendingOrderInsight {
  order: Order;
  customerName: string;
  localityName: string;
  sale: number;
  cost: number;
  grossProfit: number;
  balanceDue: number;
  packages: number;
  hasRouteDataIssue: boolean;
}

interface LocalityInsight {
  localityId: string;
  locality: Locality | null;
  index: number;
  customers: number;
  pendingOrders: number;
  netSales: number;
  balanceDue: number;
  lastActivity: string | null;
  dataIssues: string[];
}

interface BestAction {
  icon: string;
  title: string;
  body: string;
  label: string;
  action: "planner" | "expense" | "localities" | "debt" | "reload";
}

interface RunPlannerDraft {
  date: string;
  status: RunPlannerStatus;
  estimatedExpense: number | null;
  notes: string;
  driverUid: string;
  driverName: string;
}

interface ExpenseDraft {
  amount: number | null;
  occurred_at: string;
  category: FinanceExpenseCategory;
  route_run_id: string;
  notes: string;
}

interface ExpenseTemplateDraft {
  label: string;
  amount: number | null;
  category: FinanceExpenseCategory;
  notes: string;
}

interface LocalityDraft {
  locality_id: string;
  name: string;
  notes: string;
  delivery_reference: string;
  delivery_notes: string;
  sort_notes: string;
  active: boolean;
}

const EXPENSE_CATEGORIES: Array<{ value: FinanceExpenseCategory; label: string }> = [
  { value: "paqueteria", label: "Ruta / traslado" },
  { value: "consumibles", label: "Consumibles" },
  { value: "compra_inversion", label: "Inversion" },
  { value: "perdida", label: "Perdida" },
  { value: "deuda_fija", label: "Deuda fija" },
  { value: "deuda_meses", label: "Deuda a meses" },
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-ruta-detalle",
  imports: [RouterLink, FormsModule, CurrencyPipe, DatePipe, PercentPipe],
  templateUrl: "./ruta-detalle.html",
  styleUrl: "./ruta-detalle.css",
})
export default class RutaDetallePage {
  private activatedRoute = inject(ActivatedRoute);
  private router = inject(Router);
  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);
  private customersService = inject(CustomersService);
  private ordersService = inject(OrdersService);
  private financeService = inject(FinanceService);
  private routeRuns = inject(RouteRunsService);
  private authz = inject(AuthzService);

  routeId = signal(this.activatedRoute.snapshot.paramMap.get("id") || "");
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  financeAvailable = signal(true);
  activeTab = signal<RouteTab>("summary");
  runs = signal<RouteRunDoc[]>([]);

  runPlannerOpen = signal(false);
  runPlannerSelectedOrderIds = signal<string[]>([]);
  runPlannerSelectedLocalityIds = signal<string[]>([]);
  runPlannerSelectedTemplateIds = signal<string[]>([]);
  runPlannerDraft: RunPlannerDraft = this.emptyRunPlannerDraft();

  selectedPendingOrderIds = signal<string[]>([]);
  assignSheetOpen = signal(false);
  assignRunId = signal("");

  expenseSheetOpen = signal(false);
  expenseDraft: ExpenseDraft = this.emptyExpenseDraft();
  templateFormOpen = signal(false);
  templateDraft: ExpenseTemplateDraft = this.emptyTemplateDraft();

  localitySheetOpen = signal(false);
  localityEditorMode = signal<LocalityEditorMode>("create");
  existingLocalityId = signal("");
  localityDraft: LocalityDraft = this.emptyLocalityDraft();

  routePlan = computed(() => this.routesService.getById(this.routeId()));
  localities = computed(() => this.localitiesService.localities());
  customers = computed(() => this.customersService.customers());
  orders = computed(() => this.ordersService.list());
  expenses = computed(() => this.financeService.expenses());

  routeOrders = computed(() => this.orders().filter((order) => order.route_id === this.routeId()));
  routeCustomers = computed(() => this.customers().filter((customer) => customer.route_id === this.routeId()));
  routeExpenses = computed(() => this.financeAvailable() ? this.expenses().filter((row) => row.route_id === this.routeId()) : []);
  routeRunsForRoute = computed(() => this.runs().filter((run) => run.route_id === this.routeId()).sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at)));
  pendingOrders = computed<PendingOrderInsight[]>(() => this.buildPendingOrders());
  runInsights = computed<RunInsight[]>(() => this.buildRunInsights());
  customerInsights = computed<CustomerInsight[]>(() => this.buildCustomerInsights());
  localityInsights = computed<LocalityInsight[]>(() => this.buildLocalityInsights());
  summary = computed<RouteSummary>(() => this.buildSummary());
  bestAction = computed<BestAction>(() => this.buildBestAction());
  plannerSelectedOrders = computed(() => {
    const selected = new Set(this.runPlannerSelectedOrderIds());
    return this.pendingOrders().filter((row) => selected.has(row.order.order_id));
  });
  plannerTotals = computed(() => this.sumPendingRows(this.plannerSelectedOrders()));
  selectedPendingRows = computed(() => {
    const selected = new Set(this.selectedPendingOrderIds());
    return this.pendingOrders().filter((row) => selected.has(row.order.order_id));
  });
  openRuns = computed(() => this.routeRunsForRoute().filter((run) => run.status === "draft" || run.status === "scheduled"));
  activeExpenseTemplates = computed(() => (this.routePlan()?.expense_templates || []).filter((template) => template.active !== false));
  availableLocalities = computed(() => {
    const route = this.routePlan();
    const selected = new Set(route?.locality_ids || []);
    return this.localities().filter((locality) => locality.active && !selected.has(locality.locality_id));
  });

  expenseCategoryOptions = EXPENSE_CATEGORIES;
  tabs: Array<{ key: RouteTab; label: string; icon: string }> = [
    { key: "summary", label: "Resumen", icon: "dashboard" },
    { key: "runs", label: "Salidas", icon: "local_shipping" },
    { key: "orders", label: "Pedidos", icon: "receipt_long" },
    { key: "customers", label: "Clientas", icon: "groups" },
    { key: "expenses", label: "Gastos", icon: "local_gas_station" },
    { key: "localities", label: "Localidades", icon: "location_on" },
  ];

  constructor() {
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await Promise.all([
        this.authz.refresh().catch(() => undefined),
        this.routesService.loadFromFirestore(),
        this.localitiesService.loadFromFirestore(),
        this.customersService.loadFromFirestore(),
        this.ordersService.loadFromFirestore(),
      ]);
      const financeLoaded = await this.financeService.loadAll().then(() => true).catch(() => false);
      this.financeAvailable.set(financeLoaded);
      this.runs.set(await this.routeRuns.listRuns().catch(() => []));
      if (!this.routePlan()) this.error.set("No se encontro la ruta solicitada");
      this.pruneSelections();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar la ruta");
    } finally {
      this.loading.set(false);
    }
  }

  setTab(tab: RouteTab): void {
    this.activeTab.set(tab);
  }

  goBack(): void {
    this.router.navigateByUrl("/main/rutas");
  }

  goRun(runId: string): void {
    this.router.navigateByUrl(`/main/salidas/${runId}`);
  }

  goOrdersDebt(): void {
    this.activeTab.set("orders");
  }

  handleBestAction(action: BestAction): void {
    if (action.action === "planner") {
      this.openRunPlanner();
      return;
    }
    if (action.action === "expense") {
      const target = this.runInsights().find((row) => row.needsRealExpense);
      this.openExpenseSheet(target?.run.runId || "");
      return;
    }
    if (action.action === "localities") {
      this.activeTab.set("localities");
      return;
    }
    if (action.action === "reload") {
      this.reload();
      return;
    }
    this.goOrdersDebt();
  }

  localityName(localityId: string): string {
    return this.localitiesService.getById(localityId)?.name || localityId;
  }

  localityCustomerCount(localityId: string): number {
    return this.routeCustomers().filter((customer) => customer.locality_id === localityId).length;
  }

  customerName(customerId: string): string {
    const customer = this.customersService.getById(customerId);
    return customer ? `${customer.first_name} ${customer.last_name}`.trim() : customerId || "Clienta";
  }

  runStatusLabel(status: string): string {
    return ({ draft: "Borrador", scheduled: "Programada", in_transit: "En ruta", completed: "Completada", cancelled: "Cancelada" } as Record<string, string>)[status] || status;
  }

  runStatusClass(status: string): string {
    if (status === "completed") return "tone-green";
    if (status === "in_transit") return "tone-blue";
    if (status === "cancelled") return "tone-gray";
    return "tone-orange";
  }

  orderStatusLabel(status: string): string {
    return ({
      ready_for_route: "Lista para salir",
      assigned_to_run: "Asignada",
      packing: "Empaque",
      empaque: "Empaque",
      delivered: "Entregada",
      delivered_partial: "Parcial",
      pagado: "Pagada",
      pagado_parcial: "Pago parcial",
      pago_pendiente: "Pago pendiente",
    } as Record<string, string>)[status] || status;
  }

  expenseSourceLabel(source: RunInsight["expenseSource"]): string {
    if (source === "real") return "Real";
    if (source === "estimated") return "Estimado";
    return "Sin gasto";
  }

  expenseCategoryLabel(category: string): string {
    return EXPENSE_CATEGORIES.find((row) => row.value === category)?.label || category;
  }

  templateLabel(template: RouteExpenseTemplate): string {
    const note = template.notes ? ` - ${template.notes}` : "";
    return `${template.label}${note}`;
  }

  openRunPlanner(orderIds?: string[]): void {
    const route = this.routePlan();
    const pendingIds = this.pendingOrders().map((row) => row.order.order_id);
    const selected = orderIds?.length ? orderIds.filter((id) => pendingIds.includes(id)) : pendingIds;
    this.runPlannerDraft = this.emptyRunPlannerDraft();
    this.runPlannerDraft.estimatedExpense = Number(route?.estimated_run_expense || 0) || null;
    this.runPlannerDraft.notes = route?.estimated_run_expense_notes || "";
    this.runPlannerSelectedOrderIds.set(selected);
    this.runPlannerSelectedLocalityIds.set(route?.locality_ids || []);
    this.runPlannerSelectedTemplateIds.set([]);
    this.runPlannerOpen.set(true);
    this.success.set(null);
    this.error.set(null);
  }

  closeRunPlanner(): void {
    this.runPlannerOpen.set(false);
  }

  togglePlannerOrder(orderId: string): void {
    this.runPlannerSelectedOrderIds.update((current) => this.toggleId(current, orderId));
  }

  togglePlannerLocality(localityId: string): void {
    this.runPlannerSelectedLocalityIds.update((current) => this.toggleId(current, localityId));
  }

  togglePlannerTemplate(templateId: string): void {
    this.runPlannerSelectedTemplateIds.update((current) => this.toggleId(current, templateId));
  }

  async savePreparedRun(): Promise<void> {
    const route = this.routePlan();
    const actor = this.currentActor();
    if (!route || !actor || this.saving()) return;
    const scheduledDate = this.dateFromInput(this.runPlannerDraft.date);
    if (!scheduledDate) {
      this.error.set("Selecciona una fecha valida para la salida");
      return;
    }
    const selectedOrders = this.plannerSelectedOrders();
    if (selectedOrders.length === 0) {
      this.error.set("Selecciona al menos un pedido pendiente");
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const runId = await this.routeRuns.createDraftRun(route.route_id, route.name, actor, scheduledDate, {
        localityIds: this.runPlannerSelectedLocalityIds(),
        estimatedExpense: this.toNullableAmount(this.runPlannerDraft.estimatedExpense),
        notes: this.runPlannerDraft.notes.trim() || null,
        createdFrom: "ruta_360",
      });
      if (this.runPlannerDraft.status === "scheduled") {
        await this.routeRuns.updateRunSchedule(runId, scheduledDate);
      }
      const driverName = this.runPlannerDraft.driverName.trim();
      const driverUid = this.runPlannerDraft.driverUid.trim();
      if (driverName && driverUid) {
        await this.routeRuns.assignRunDriver(runId, { uid: driverUid, name: driverName });
      }
      for (const row of selectedOrders) {
        await this.routeRuns.acceptDispatchRequest({
          order: this.toDispatchOrderRow(row.order),
          routeName: route.name,
          customerName: row.customerName,
          actor,
          runId,
          scheduledDate,
        });
      }
      if (this.financeAvailable()) {
        await this.saveSelectedTemplateExpenses(runId, scheduledDate);
      }
      this.success.set("Salida preparada con pedidos seleccionados");
      this.runPlannerOpen.set(false);
      await this.reload();
      await this.router.navigateByUrl(`/main/salidas/${runId}`);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo preparar la salida");
    } finally {
      this.saving.set(false);
    }
  }

  togglePendingOrder(orderId: string): void {
    this.selectedPendingOrderIds.update((current) => this.toggleId(current, orderId));
  }

  selectAllPendingOrders(): void {
    const allIds = this.pendingOrders().map((row) => row.order.order_id);
    const current = this.selectedPendingOrderIds();
    this.selectedPendingOrderIds.set(current.length === allIds.length ? [] : allIds);
  }

  openAssignOrdersSheet(): void {
    if (this.selectedPendingRows().length === 0) {
      this.error.set("Selecciona pedidos para agregarlos a una salida");
      return;
    }
    const firstRun = this.openRuns()[0];
    this.assignRunId.set(firstRun?.runId || "");
    this.assignSheetOpen.set(true);
    this.error.set(null);
  }

  closeAssignSheet(): void {
    this.assignSheetOpen.set(false);
  }

  async addOrdersToRun(): Promise<void> {
    const route = this.routePlan();
    const actor = this.currentActor();
    const run = this.openRuns().find((entry) => entry.runId === this.assignRunId());
    if (!route || !actor || !run || this.saving()) return;
    const selectedRows = this.selectedPendingRows();
    if (selectedRows.length === 0) return;
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      for (const row of selectedRows) {
        await this.routeRuns.acceptDispatchRequest({
          order: this.toDispatchOrderRow(row.order),
          routeName: route.name,
          customerName: row.customerName,
          actor,
          runId: run.runId,
          scheduledDate: new Date(run.scheduled_at),
        });
      }
      this.success.set("Pedidos agregados a la salida");
      this.selectedPendingOrderIds.set([]);
      this.assignSheetOpen.set(false);
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron agregar los pedidos");
    } finally {
      this.saving.set(false);
    }
  }

  openExpenseSheet(runId = ""): void {
    if (!this.financeAvailable()) return;
    this.expenseDraft = this.emptyExpenseDraft();
    this.expenseDraft.route_run_id = runId;
    this.expenseSheetOpen.set(true);
    this.error.set(null);
  }

  closeExpenseSheet(): void {
    this.expenseSheetOpen.set(false);
  }

  applyExpenseTemplate(template: RouteExpenseTemplate, runId = ""): void {
    if (!this.financeAvailable()) return;
    this.expenseDraft = {
      amount: Number(template.amount || 0),
      occurred_at: this.dateInput(new Date()),
      category: this.normalizeFinanceCategory(template.category),
      route_run_id: runId,
      notes: template.notes || template.label,
    };
    this.expenseSheetOpen.set(true);
  }

  async saveRouteExpense(): Promise<void> {
    const amount = this.toNullableAmount(this.expenseDraft.amount);
    if (!this.financeAvailable() || !amount || amount <= 0 || this.saving()) {
      this.error.set("Captura un monto valido para el gasto");
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveExpense({
        amount,
        category: this.expenseDraft.category,
        occurred_at: this.expenseDraft.occurred_at,
        route_id: this.routeId(),
        route_run_id: this.expenseDraft.route_run_id || null,
        account_id: null,
        installment_total: null,
        installment_index: null,
        notes: this.expenseDraft.notes.trim() || "Gasto de ruta",
      });
      this.success.set("Gasto registrado");
      this.expenseSheetOpen.set(false);
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar el gasto");
    } finally {
      this.saving.set(false);
    }
  }

  openTemplateForm(): void {
    this.templateDraft = this.emptyTemplateDraft();
    this.templateFormOpen.set(true);
  }

  closeTemplateForm(): void {
    this.templateFormOpen.set(false);
  }

  async saveExpenseTemplate(): Promise<void> {
    const route = this.routePlan();
    const amount = this.toNullableAmount(this.templateDraft.amount);
    const label = this.templateDraft.label.trim();
    if (!route || !label || !amount || amount <= 0 || this.saving()) {
      this.error.set("Captura nombre y monto de la plantilla");
      return;
    }
    const template: RouteExpenseTemplate = {
      template_id: `tpl_${Date.now()}`,
      label,
      amount,
      category: this.templateDraft.category,
      active: true,
      notes: this.templateDraft.notes.trim() || null,
    };
    await this.saveRoute({
      ...route,
      expense_templates: [...(route.expense_templates || []), template],
    }, "Plantilla de gasto guardada");
    this.templateFormOpen.set(false);
  }

  async toggleTemplateActive(template: RouteExpenseTemplate): Promise<void> {
    const route = this.routePlan();
    if (!route) return;
    const templates = (route.expense_templates || []).map((row) =>
      row.template_id === template.template_id ? { ...row, active: row.active === false } : row,
    );
    await this.saveRoute({ ...route, expense_templates: templates }, template.active === false ? "Plantilla activada" : "Plantilla pausada");
  }

  openCreateLocalitySheet(): void {
    this.localityEditorMode.set("create");
    this.localityDraft = this.emptyLocalityDraft();
    this.existingLocalityId.set("");
    this.localitySheetOpen.set(true);
    this.error.set(null);
  }

  openLocalityEditor(localityId: string): void {
    const locality = this.localitiesService.getById(localityId);
    if (!locality) return;
    this.localityEditorMode.set("edit");
    this.localityDraft = {
      locality_id: locality.locality_id,
      name: locality.name,
      notes: locality.notes || "",
      delivery_reference: locality.delivery_reference || "",
      delivery_notes: locality.delivery_notes || "",
      sort_notes: locality.sort_notes || "",
      active: locality.active,
    };
    this.localitySheetOpen.set(true);
    this.error.set(null);
  }

  closeLocalitySheet(): void {
    this.localitySheetOpen.set(false);
  }

  async saveLocalityFromRoute(): Promise<void> {
    const route = this.routePlan();
    const name = this.localityDraft.name.trim();
    if (!route || !name || this.saving()) {
      this.error.set("Captura el nombre de la localidad");
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const localityId = this.localityEditorMode() === "edit" ? this.localityDraft.locality_id : this.uniqueLocalityId(name);
      const existing = this.localitiesService.getById(localityId);
      await this.localitiesService.save({
        locality_id: localityId,
        name,
        active: this.localityDraft.active,
        notes: this.localityDraft.notes.trim(),
        delivery_reference: this.localityDraft.delivery_reference.trim() || null,
        delivery_notes: this.localityDraft.delivery_notes.trim() || null,
        sort_notes: this.localityDraft.sort_notes.trim() || null,
        created_at: existing?.created_at || new Date(),
      });
      const localityIds = route.locality_ids.includes(localityId) ? route.locality_ids : [...route.locality_ids, localityId];
      await this.routesService.save({ ...route, locality_ids: localityIds });
      this.success.set(this.localityEditorMode() === "edit" ? "Localidad actualizada" : "Localidad agregada a la ruta");
      this.localitySheetOpen.set(false);
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la localidad");
    } finally {
      this.saving.set(false);
    }
  }

  async addExistingLocalityToRoute(): Promise<void> {
    const route = this.routePlan();
    const localityId = this.existingLocalityId().trim();
    if (!route || !localityId || route.locality_ids.includes(localityId)) return;
    const owner = this.ownerRouteForLocality(localityId);
    if (owner && owner.route_id !== route.route_id) {
      const ok = window.confirm(`La localidad esta en "${owner.name}". Deseas moverla a esta ruta?`);
      if (!ok) return;
      await this.saveRoute({ ...owner, locality_ids: owner.locality_ids.filter((id) => id !== localityId) }, "");
    }
    await this.saveRoute({ ...route, locality_ids: [...route.locality_ids, localityId] }, "Localidad agregada a la ruta");
    this.existingLocalityId.set("");
  }

  async reorderLocality(index: number, direction: number): Promise<void> {
    const route = this.routePlan();
    if (!route) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= route.locality_ids.length) return;
    const next = [...route.locality_ids];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(nextIndex, 0, item);
    await this.saveRoute({ ...route, locality_ids: next }, "Orden de localidades actualizado");
  }

  async toggleLocalityActive(localityId: string): Promise<void> {
    const locality = this.localitiesService.getById(localityId);
    if (!locality) return;
    try {
      await this.localitiesService.setActive(localityId, !locality.active);
      this.success.set(locality.active ? "Localidad desactivada" : "Localidad activada");
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar la localidad");
    }
  }

  async removeLocalityFromRoute(localityId: string): Promise<void> {
    const route = this.routePlan();
    if (!route) return;
    const ok = window.confirm("La localidad se quitara de esta ruta, pero no se borrara. Deseas continuar?");
    if (!ok) return;
    await this.saveRoute({ ...route, locality_ids: route.locality_ids.filter((id) => id !== localityId) }, "Localidad quitada de la ruta");
  }

  private async saveSelectedTemplateExpenses(runId: string, scheduledDate: Date): Promise<void> {
    const selected = new Set(this.runPlannerSelectedTemplateIds());
    const templates = this.activeExpenseTemplates().filter((template) => selected.has(template.template_id));
    for (const template of templates) {
      await this.financeService.saveExpense({
        amount: Number(template.amount || 0),
        category: this.normalizeFinanceCategory(template.category),
        occurred_at: this.dateInput(scheduledDate),
        route_id: this.routeId(),
        route_run_id: runId,
        account_id: null,
        installment_total: null,
        installment_index: null,
        notes: template.notes || template.label,
      });
    }
  }

  private async saveRoute(route: RoutePlan, message: string): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    if (message) this.success.set(null);
    try {
      await this.routesService.save(route);
      if (message) this.success.set(message);
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la ruta");
    } finally {
      this.saving.set(false);
    }
  }

  private buildSummary(): RouteSummary {
    const route = this.routePlan();
    const delivered = this.routeOrders().filter((order) => this.isDelivered(order));
    let netSales = 0;
    let grossProfit = 0;
    let returnsAmount = 0;
    let balanceDue = 0;
    for (const order of this.routeOrders().filter((row) => !this.isCancelled(row))) {
      balanceDue += calculateOrderFinancials(order).balanceDue;
    }
    for (const order of delivered) {
      const financials = calculateOrderFinancials(order);
      netSales += financials.netAmount;
      grossProfit += financials.grossProfit;
      returnsAmount += financials.returnsAmount;
    }
    const expenses = this.routeExpenses().reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0);
    const pendingCost = this.pendingOrders().reduce((sum, row) => sum + row.cost, 0);
    const estimatedExpense = this.pendingOrders().length > 0 ? Number(route?.estimated_run_expense || 0) : 0;
    return {
      netSales,
      grossProfit,
      expenses,
      netProfit: grossProfit - expenses,
      margin: netSales > 0 ? grossProfit / netSales : 0,
      balanceDue,
      returnsAmount,
      pendingOrders: this.pendingOrders().length,
      investmentNeeded: pendingCost + estimatedExpense,
    };
  }

  private buildRunInsights(): RunInsight[] {
    const route = this.routePlan();
    return this.routeRunsForRoute().map((run) => {
      const orders = this.routeOrders().filter((order) => order.route_run_id === run.runId);
      let saleTotal = 0;
      let cost = 0;
      let grossProfit = 0;
      let balanceDue = 0;
      for (const order of orders) {
        const financials = calculateOrderFinancials(order);
        saleTotal += financials.netAmount;
        cost += financials.netCost;
        grossProfit += financials.grossProfit;
        balanceDue += financials.balanceDue;
      }
      const realExpense = this.routeExpenses()
        .filter((expense) => expense.route_run_id === run.runId)
        .reduce((sum, expense) => sum + Math.max(0, Number(expense.amount || 0)), 0);
      const runEstimate = Number(run.estimated_expense ?? route?.estimated_run_expense ?? 0);
      const estimatedExpense = realExpense <= 0 ? runEstimate : 0;
      const expense = realExpense || estimatedExpense;
      return {
        run,
        ordersCount: orders.length || run.counts.orders_total,
        saleTotal,
        cost,
        grossProfit,
        expense,
        expenseSource: realExpense > 0 ? "real" : estimatedExpense > 0 ? "estimated" : "none",
        netProfit: grossProfit - expense,
        packages: orders.reduce((sum, order) => sum + Math.max(0, Number(order.packing?.packages_count || 0)), 0) || run.counts.packages_total,
        balanceDue: balanceDue || run.counts.balance_total,
        needsRealExpense: this.financeAvailable() && realExpense <= 0 && estimatedExpense > 0 && run.status !== "cancelled",
      };
    });
  }

  private buildPendingOrders(): PendingOrderInsight[] {
    return this.routeOrders()
      .filter((order) => !order.route_run_id && !this.isCancelled(order) && (order.status === "ready_for_route" || order.packing?.status === "done" || order.dispatch_request?.status === "requested"))
      .map((order) => {
        const financials = calculateOrderFinancials(order);
        const customer = this.customersService.getById(order.customer_id);
        const localityId = customer?.locality_id || "";
        return {
          order,
          customerName: this.customerName(order.customer_id),
          localityName: localityId ? this.localityName(localityId) : "Sin localidad",
          sale: financials.netAmount,
          cost: financials.netCost,
          grossProfit: financials.grossProfit,
          balanceDue: financials.balanceDue,
          packages: Math.max(0, Number(order.packing?.packages_count || order.planned_packages || 0)),
          hasRouteDataIssue: !order.route_id || !localityId,
        };
      })
      .sort((a, b) => b.sale - a.sale);
  }

  private buildCustomerInsights(): CustomerInsight[] {
    return this.routeCustomers()
      .map((customer) => {
        const orders = this.routeOrders().filter((order) => order.customer_id === customer.customer_id && !this.isCancelled(order));
        const delivered = orders.filter((order) => this.isDelivered(order));
        let netSales = 0;
        let balanceDue = 0;
        for (const order of orders) balanceDue += calculateOrderFinancials(order).balanceDue;
        for (const order of delivered) netSales += calculateOrderFinancials(order).netAmount;
        const orderDates = delivered
          .map((order) => order.delivered_at || order.updated_at || order.created_at)
          .filter(Boolean)
          .sort();
        const lastOrder = orderDates.length ? orderDates[orderDates.length - 1] : null;
        return {
          customer,
          orders: delivered.length,
          netSales,
          ticket: delivered.length ? netSales / delivered.length : 0,
          balanceDue,
          lastOrder,
        };
      })
      .sort((a, b) => b.netSales - a.netSales);
  }

  private buildLocalityInsights(): LocalityInsight[] {
    const route = this.routePlan();
    if (!route) return [];
    return route.locality_ids.map((localityId, index) => {
      const locality = this.localitiesService.getById(localityId);
      const customers = this.routeCustomers().filter((customer) => customer.locality_id === localityId);
      const customerIds = new Set(customers.map((customer) => customer.customer_id));
      const orders = this.routeOrders().filter((order) => customerIds.has(order.customer_id) && !this.isCancelled(order));
      const delivered = orders.filter((order) => this.isDelivered(order));
      const pending = orders.filter((order) => !order.route_run_id && (order.status === "ready_for_route" || order.packing?.status === "done"));
      let netSales = 0;
      let balanceDue = 0;
      for (const order of orders) balanceDue += calculateOrderFinancials(order).balanceDue;
      for (const order of delivered) netSales += calculateOrderFinancials(order).netAmount;
      const activityDates = orders.map((order) => order.delivered_at || order.updated_at || order.created_at).filter(Boolean).sort();
      const dataIssues = [
        !locality?.delivery_reference ? "Referencia pendiente" : "",
        !locality?.delivery_notes ? "Instrucciones pendientes" : "",
      ].filter(Boolean);
      return {
        localityId,
        locality,
        index,
        customers: customers.length,
        pendingOrders: pending.length,
        netSales,
        balanceDue,
        lastActivity: activityDates.length ? activityDates[activityDates.length - 1] : null,
        dataIssues,
      };
    });
  }

  private buildBestAction(): BestAction {
    const pendingCount = this.pendingOrders().length;
    if (pendingCount > 0) {
      return {
        icon: "add_road",
        title: "Preparar siguiente salida",
        body: `${pendingCount} pedido(s) estan listos para organizar por localidad, inversion y cobro.`,
        label: "Preparar salida",
        action: "planner",
      };
    }
    const runWithoutExpense = this.runInsights().find((row) => row.needsRealExpense);
    if (runWithoutExpense) {
      return {
        icon: "local_gas_station",
        title: "Registrar gasto real",
        body: "Hay una salida usando gasto estimado. Conviene capturar el gasto real para medir utilidad.",
        label: "Registrar gasto",
        action: "expense",
      };
    }
    const missingLocalityData = this.localityInsights().filter((row) => row.dataIssues.length > 0).length;
    if (missingLocalityData > 0) {
      return {
        icon: "edit_location",
        title: "Completar datos de localidades",
        body: `${missingLocalityData} localidad(es) necesitan referencia o instrucciones de entrega.`,
        label: "Ver localidades",
        action: "localities",
      };
    }
    const balanceDue = this.summary().balanceDue;
    if (balanceDue > 0) {
      return {
        icon: "wallet",
        title: "Revisar cobranza de ruta",
        body: `Esta ruta tiene saldo por cobrar de ${this.money(balanceDue)}.`,
        label: "Ver pedidos",
        action: "debt",
      };
    }
    return {
      icon: "task_alt",
      title: "Ruta al dia",
      body: "No hay pendientes operativos relevantes en este momento.",
      label: "Actualizar",
      action: "reload",
    };
  }

  sumPendingRows(rows: PendingOrderInsight[]): { sale: number; cost: number; grossProfit: number; balanceDue: number; packages: number } {
    return rows.reduce(
      (acc, row) => ({
        sale: acc.sale + row.sale,
        cost: acc.cost + row.cost,
        grossProfit: acc.grossProfit + row.grossProfit,
        balanceDue: acc.balanceDue + row.balanceDue,
        packages: acc.packages + row.packages,
      }),
      { sale: 0, cost: 0, grossProfit: 0, balanceDue: 0, packages: 0 },
    );
  }

  private pruneSelections(): void {
    const pendingIds = new Set(this.pendingOrders().map((row) => row.order.order_id));
    this.selectedPendingOrderIds.update((current) => current.filter((id) => pendingIds.has(id)));
    this.runPlannerSelectedOrderIds.update((current) => current.filter((id) => pendingIds.has(id)));
  }

  private toDispatchOrderRow(order: Order): DispatchOrderRow {
    return {
      order_id: order.order_id,
      business_id: order.business_id,
      customer_id: order.customer_id,
      route_id: order.route_id,
      status: String(order.status || ""),
      route_run_id: order.route_run_id || null,
      dispatch_request: {
        status: order.dispatch_request?.status || "none",
        requested_at: order.dispatch_request?.requested_at || null,
        requested_by: order.dispatch_request?.requested_by || null,
        note: order.dispatch_request?.note || null,
      },
      packing: {
        status: order.packing?.status || "in_progress",
        packages_count: Number(order.packing?.packages_count || order.planned_packages || 0),
        completed_at: order.packing?.completed_at || null,
      },
      totals: {
        total_amount: Number(order.totals?.total_amount || 0),
        paid_amount: Number(order.totals?.paid_amount || 0),
        balance_due: Number(order.totals?.balance_due || 0),
      },
      updated_at: order.updated_at || new Date().toISOString(),
    };
  }

  private currentActor(): RunActor | null {
    const user = this.authz.currentUserSig();
    if (!user) {
      this.error.set("No hay usuario activo");
      return null;
    }
    return {
      uid: user.uid,
      name: user.displayName || user.email || "Usuario",
    };
  }

  private ownerRouteForLocality(localityId: string): RoutePlan | null {
    return this.routesService.routes().find((route) => route.locality_ids.includes(localityId)) || null;
  }

  private isCancelled(order: Order): boolean {
    return ["cancelado", "devuelto"].includes(String(order.status || ""));
  }

  private isDelivered(order: Order): boolean {
    return Boolean(order.delivered_at) || ["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed"].includes(String(order.status || ""));
  }

  private toggleId(current: string[], id: string): string[] {
    return current.includes(id) ? current.filter((row) => row !== id) : [...current, id];
  }

  private normalizeFinanceCategory(value: string): FinanceExpenseCategory {
    const found = EXPENSE_CATEGORIES.find((row) => row.value === value);
    return found?.value || "paqueteria";
  }

  private toNullableAmount(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Number(parsed.toFixed(2)));
  }

  private dateInput(value: Date): string {
    const date = new Date(value);
    const pad = (input: number) => String(input).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private dateFromInput(value: string): Date | null {
    const [yearRaw, monthRaw, dayRaw] = value.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const date = new Date(year, month - 1, day, 10, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private uniqueLocalityId(name: string): string {
    const base = this.slugify(name) || `localidad_${Date.now()}`;
    let candidate = base;
    let index = 2;
    while (this.localitiesService.getById(candidate)) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    return candidate;
  }

  private slugify(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  private money(value: number): string {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(value || 0);
  }

  private emptyRunPlannerDraft(): RunPlannerDraft {
    return {
      date: this.dateInput(new Date()),
      status: "scheduled",
      estimatedExpense: null,
      notes: "",
      driverUid: "",
      driverName: "",
    };
  }

  private emptyExpenseDraft(): ExpenseDraft {
    return {
      amount: null,
      occurred_at: this.dateInput(new Date()),
      category: "paqueteria",
      route_run_id: "",
      notes: "",
    };
  }

  private emptyTemplateDraft(): ExpenseTemplateDraft {
    return {
      label: "",
      amount: null,
      category: "paqueteria",
      notes: "",
    };
  }

  private emptyLocalityDraft(): LocalityDraft {
    return {
      locality_id: "",
      name: "",
      notes: "",
      delivery_reference: "",
      delivery_notes: "",
      sort_notes: "",
      active: true,
    };
  }
}
