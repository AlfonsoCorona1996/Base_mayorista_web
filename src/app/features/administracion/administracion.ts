import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { AuthzService } from "../../core/authz.service";
import { FinanceAccount, FinanceExpense, FinanceExpenseCategory, FinanceService } from "../../core/finance.service";
import { InventoryItem, InventoryService } from "../../core/inventory.service";
import { Order, OrderItem, OrderStatus, OrdersService } from "../../core/orders.service";
import { RoutePlan, RoutesService } from "../../core/routes.service";

type SummaryRow = {
  routeId: string;
  routeName: string;
  ventas: number;
  porCobrar: number;
  pedidosPendientes: number;
  utilidadNeta: number;
  devoluciones: number;
  devolucionRate: number;
};

type FinanceSummary = {
  ventasBrutas: number;
  ingresosCobrados: number;
  egresos: number;
  utilidadBruta: number;
  utilidadNeta: number;
  dsoDias: number;
  cajaActual: number;
  porCobrar: number;
  mercanciaTransito: number;
  inventarioCosto: number;
  inventoryTurnover: number;
  inventoryDays: number;
  potencialBorradores: number;
  potencialPendiente: number;
  promedioVentaDiaria: number;
  promedioEgresoDiario: number;
  proyeccionCaja: number;
  estancadoPiezas: number;
  estancadoCosto: number;
  estancadoPotencial: number;
  estancadoGanancia: number;
  perdidoStock: number;
  perdidoDano: number;
  devolucionesMonto: number;
  devolucionRate: number;
  devolucionImpacto: number;
  pedidosPendientes: number;
  pedidosBorrador: number;
  pendientesCobro: number;
};

const EXPENSE_CATEGORY_LABEL: Record<FinanceExpenseCategory, string> = {
  compra_inversion: "Compra por inversion",
  perdida: "Perdida",
  paqueteria: "Paqueteria",
  consumibles: "Consumibles",
  deuda_fija: "Deuda fija",
  deuda_meses: "Deuda a meses",
};

const DELIVERED_STATUSES = new Set<OrderStatus>(["entregado", "delivered", "delivered_partial", "pago_pendiente", "pagado", "closed"]);
const CLOSED_STATUSES = new Set<OrderStatus>(["pagado", "closed"]);
const RETURNED_STATUSES = new Set<OrderStatus>(["devuelto"]);
const CANCELLED_STATUSES = new Set<OrderStatus>(["cancelado"]);
const PIPELINE_STATUSES = new Set<OrderStatus>([
  "confirmando_proveedor",
  "reservado_inventario",
  "solicitado_proveedor",
  "supplier_processing",
  "inbound_in_transit",
  "en_transito",
  "recibido_qa",
  "packing",
  "empaque",
  "ready_for_route",
  "assigned_to_run",
  "in_transit",
  "en_ruta",
  "pago_pendiente",
]);

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-administracion",
  imports: [FormsModule],
  templateUrl: "./administracion.html",
  styleUrl: "./administracion.css",
})
export default class AdministracionPage {
  private ordersService = inject(OrdersService);
  private inventoryService = inject(InventoryService);
  private routesService = inject(RoutesService);
  private financeService = inject(FinanceService);
  private authz = inject(AuthzService);

  loading = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  routeScope = signal("general");
  projectionDays = signal(30);
  averageWindowDays = signal(30);
  stagnationDays = signal(45);

  cutLabel = signal("");
  cutStart = signal(this.offsetDate(-30));
  cutEnd = signal(this.offsetDate(0));

  accountEditingId = signal<string | null>(null);
  accountName = signal("");
  accountBalance = signal(0);
  accountNotes = signal("");

  expenseEditingId = signal<string | null>(null);
  expenseCategory = signal<FinanceExpenseCategory>("consumibles");
  expenseAmount = signal(0);
  expenseDate = signal(this.offsetDate(0));
  expenseRouteId = signal("general");
  expenseAccountId = signal("none");
  expenseInstallmentTotal = signal<number | null>(null);
  expenseInstallmentIndex = signal<number | null>(null);
  expenseNotes = signal("");

  orders = computed(() => this.ordersService.list());
  inventoryItems = computed(() => this.inventoryService.items());
  routes = computed(() => this.routesService.routes());
  accounts = computed(() => this.financeService.accounts());
  expenses = computed(() => this.financeService.expenses());
  cuts = computed(() => this.financeService.cuts());

  canViewAccounts = computed(() => this.authz.canCap("cap.finance.accounts.view"));
  canCreateAccounts = computed(() => this.authz.canCap("cap.finance.accounts.create"));
  canEditAccounts = computed(() => this.authz.canCap("cap.finance.accounts.edit"));
  canDeleteAccounts = computed(() => this.authz.canCap("cap.finance.accounts.delete"));

  canViewMovements = computed(() => this.authz.canCap("cap.finance.movements.view"));
  canCreateMovements = computed(() => this.authz.canCap("cap.finance.movements.create"));
  canEditMovements = computed(() => this.authz.canCap("cap.finance.movements.edit"));
  canDeleteMovements = computed(() => this.authz.canCap("cap.finance.movements.delete"));

  canViewReports = computed(() => this.authz.canCap("cap.finance.reports.view"));

  scopeOptions = computed(() => {
    const base = [{ id: "general", name: "General" }];
    const routes = this.routes().map((route) => ({ id: route.route_id, name: route.name }));
    return [...base, ...routes];
  });

  selectedRouteId = computed(() => {
    const current = this.routeScope();
    if (!current || current === "general") return null;
    return current;
  });

  filteredOrders = computed(() => {
    const routeId = this.selectedRouteId();
    return this.orders().filter((order) => this.matchesRoute(order.route_id, routeId));
  });

  filteredExpenses = computed(() => {
    const routeId = this.selectedRouteId();
    if (!routeId) return this.expenses();
    return this.expenses().filter((row) => row.route_id === routeId);
  });

  summary = computed<FinanceSummary>(() =>
    this.buildSummary({
      orders: this.filteredOrders(),
      expenses: this.filteredExpenses(),
      inventory: this.inventoryItems(),
      accounts: this.accounts(),
      projectionDays: this.projectionDays(),
      averageWindowDays: this.averageWindowDays(),
      stagnationDays: this.stagnationDays(),
    }),
  );

  routeRows = computed(() => this.buildRouteRows());

  constructor() {
    this.reload().catch(() => null);
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await Promise.all([
        this.ordersService.loadFromFirestore(),
        this.inventoryService.loadFromFirestore().catch(() => null),
        this.routesService.loadFromFirestore().catch(() => null),
        this.financeService.loadAll(),
      ]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo cargar la informacion financiera.";
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  setRouteScope(value: unknown) {
    const raw = String(value || "general").trim();
    this.routeScope.set(raw || "general");
  }

  setProjectionDays(value: unknown) {
    this.projectionDays.set(this.toPositiveInt(value, 30));
  }

  setAverageWindowDays(value: unknown) {
    this.averageWindowDays.set(this.toPositiveInt(value, 30));
  }

  setStagnationDays(value: unknown) {
    this.stagnationDays.set(this.toPositiveInt(value, 45));
  }

  setCutStart(value: unknown) {
    this.cutStart.set(this.normalizeDateInput(value, this.offsetDate(-30)));
  }

  setCutEnd(value: unknown) {
    this.cutEnd.set(this.normalizeDateInput(value, this.offsetDate(0)));
  }

  async saveCut() {
    if (!this.canViewReports()) return;
    this.error.set(null);
    this.success.set(null);
    const start = this.cutStart();
    const end = this.cutEnd();
    if (start > end) {
      this.error.set("El inicio del corte no puede ser mayor que la fecha final.");
      return;
    }
    const summary = this.summary();
    try {
      await this.financeService.saveCut({
        label: this.cutLabel().trim() || `Corte ${start} a ${end}`,
        route_id: this.selectedRouteId(),
        start_at: start,
        end_at: end,
        snapshot: {
          ingresos: summary.ingresosCobrados,
          egresos: summary.egresos,
          utilidad_bruta: summary.utilidadBruta,
          utilidad_neta: summary.utilidadNeta,
          por_cobrar: summary.porCobrar,
          caja: summary.cajaActual,
          mercancia_transito: summary.mercanciaTransito,
          inventario: summary.inventarioCosto,
        },
      });
      this.cutLabel.set("");
      this.success.set("Corte guardado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar el corte.";
      this.error.set(message);
    }
  }

  startEditAccount(row: FinanceAccount) {
    if (!this.canEditAccounts()) return;
    this.accountEditingId.set(row.account_id);
    this.accountName.set(row.name);
    this.accountBalance.set(row.balance);
    this.accountNotes.set(row.notes || "");
  }

  resetAccountForm() {
    this.accountEditingId.set(null);
    this.accountName.set("");
    this.accountBalance.set(0);
    this.accountNotes.set("");
  }

  async submitAccount() {
    const editingId = this.accountEditingId();
    const isEditing = Boolean(editingId);
    if (isEditing && !this.canEditAccounts()) return;
    if (!isEditing && !this.canCreateAccounts()) return;
    const name = this.accountName().trim();
    if (!name) {
      this.error.set("El nombre de la cuenta es obligatorio.");
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveAccount({
        account_id: editingId || undefined,
        name,
        balance: this.accountBalance(),
        notes: this.accountNotes().trim() || null,
      });
      this.resetAccountForm();
      this.success.set(isEditing ? "Cuenta actualizada." : "Cuenta registrada.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar la cuenta.";
      this.error.set(message);
    }
  }

  async deleteAccount(row: FinanceAccount) {
    if (!this.canDeleteAccounts()) return;
    const ok = confirm(`Eliminar la cuenta "${row.name}"?`);
    if (!ok) return;
    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.deleteAccount(row.account_id);
      if (this.accountEditingId() === row.account_id) this.resetAccountForm();
      this.success.set("Cuenta eliminada.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo eliminar la cuenta.";
      this.error.set(message);
    }
  }

  setAccountName(value: unknown) {
    this.accountName.set(String(value || ""));
  }

  setAccountBalance(value: unknown) {
    this.accountBalance.set(this.toSafeNumber(value));
  }

  setAccountNotes(value: unknown) {
    this.accountNotes.set(String(value || ""));
  }

  startEditExpense(row: FinanceExpense) {
    if (!this.canEditMovements()) return;
    this.expenseEditingId.set(row.expense_id);
    this.expenseCategory.set(row.category);
    this.expenseAmount.set(row.amount);
    this.expenseDate.set(this.normalizeDateInput(row.occurred_at, this.offsetDate(0)));
    this.expenseRouteId.set(row.route_id || "general");
    this.expenseAccountId.set(row.account_id || "none");
    this.expenseInstallmentTotal.set(row.installment_total);
    this.expenseInstallmentIndex.set(row.installment_index);
    this.expenseNotes.set(row.notes || "");
  }

  resetExpenseForm() {
    this.expenseEditingId.set(null);
    this.expenseCategory.set("consumibles");
    this.expenseAmount.set(0);
    this.expenseDate.set(this.offsetDate(0));
    this.expenseRouteId.set(this.selectedRouteId() || "general");
    this.expenseAccountId.set("none");
    this.expenseInstallmentTotal.set(null);
    this.expenseInstallmentIndex.set(null);
    this.expenseNotes.set("");
  }

  setExpenseCategory(value: unknown) {
    const raw = String(value || "").trim();
    if (raw === "compra_inversion" || raw === "perdida" || raw === "paqueteria" || raw === "consumibles" || raw === "deuda_fija" || raw === "deuda_meses") {
      this.expenseCategory.set(raw);
    }
  }

  setExpenseAmount(value: unknown) {
    this.expenseAmount.set(this.toSafeNumber(value));
  }

  setExpenseDate(value: unknown) {
    this.expenseDate.set(this.normalizeDateInput(value, this.offsetDate(0)));
  }

  setExpenseRouteId(value: unknown) {
    const raw = String(value || "general").trim();
    this.expenseRouteId.set(raw || "general");
  }

  setExpenseAccountId(value: unknown) {
    const raw = String(value || "none").trim();
    this.expenseAccountId.set(raw || "none");
  }

  setExpenseInstallmentTotal(value: unknown) {
    this.expenseInstallmentTotal.set(this.toNullablePositiveInt(value));
  }

  setExpenseInstallmentIndex(value: unknown) {
    this.expenseInstallmentIndex.set(this.toNullablePositiveInt(value));
  }

  setExpenseNotes(value: unknown) {
    this.expenseNotes.set(String(value || ""));
  }

  async submitExpense() {
    const editingId = this.expenseEditingId();
    const isEditing = Boolean(editingId);
    if (isEditing && !this.canEditMovements()) return;
    if (!isEditing && !this.canCreateMovements()) return;
    if (this.expenseAmount() <= 0) {
      this.error.set("El monto del egreso debe ser mayor a 0.");
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveExpense({
        expense_id: editingId || undefined,
        category: this.expenseCategory(),
        amount: this.expenseAmount(),
        occurred_at: this.expenseDate(),
        route_id: this.expenseRouteId() === "general" ? null : this.expenseRouteId(),
        account_id: this.expenseAccountId() === "none" ? null : this.expenseAccountId(),
        installment_total: this.expenseInstallmentTotal(),
        installment_index: this.expenseInstallmentIndex(),
        notes: this.expenseNotes().trim() || null,
      });
      this.resetExpenseForm();
      this.success.set(isEditing ? "Egreso actualizado." : "Egreso registrado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar el egreso.";
      this.error.set(message);
    }
  }

  async deleteExpense(row: FinanceExpense) {
    if (!this.canDeleteMovements()) return;
    const ok = confirm(`Eliminar egreso de ${this.formatCurrency(row.amount)}?`);
    if (!ok) return;
    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.deleteExpense(row.expense_id);
      if (this.expenseEditingId() === row.expense_id) this.resetExpenseForm();
      this.success.set("Egreso eliminado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo eliminar el egreso.";
      this.error.set(message);
    }
  }

  expenseCategoryLabel(key: FinanceExpenseCategory): string {
    return EXPENSE_CATEGORY_LABEL[key];
  }

  routeName(routeId: string | null): string {
    if (!routeId || routeId === "sin_ruta") return "Sin ruta";
    return this.routes().find((row) => row.route_id === routeId)?.name || routeId;
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(this.toSafeNumber(value));
  }

  formatPercent(value: number): string {
    return `${(this.toSafeNumber(value) * 100).toFixed(1)}%`;
  }

  formatNumber(value: number, decimals = 1): string {
    return this.toSafeNumber(value).toFixed(Math.max(0, Math.trunc(decimals)));
  }

  formatDate(value: unknown): string {
    const iso = this.toIsoDate(value);
    if (!iso) return "-";
    return new Date(iso).toLocaleDateString("es-MX");
  }

  trackRoute = (_: number, row: SummaryRow) => row.routeId;
  trackAccount = (_: number, row: FinanceAccount) => row.account_id;
  trackExpense = (_: number, row: FinanceExpense) => row.expense_id;
  trackCut = (_: number, row: { cut_id: string }) => row.cut_id;
  trackScope = (_: number, row: { id: string }) => row.id;

  private buildRouteRows(): SummaryRow[] {
    const selectedRouteId = this.selectedRouteId();
    const rows = this.collectRouteRows(this.routes(), this.orders());
    const baseExpenses = this.expenses();
    const out: SummaryRow[] = [];

    for (const row of rows) {
      if (selectedRouteId && row.routeId !== selectedRouteId) continue;
      const routeOrders = this.orders().filter((order) => this.matchesRoute(order.route_id, row.routeId));
      const routeExpenses = baseExpenses.filter((expense) => expense.route_id === row.routeId);
      const summary = this.buildSummary({
        orders: routeOrders,
        expenses: routeExpenses,
        inventory: [],
        accounts: [],
        projectionDays: this.projectionDays(),
        averageWindowDays: this.averageWindowDays(),
        stagnationDays: this.stagnationDays(),
      });
      out.push({
        routeId: row.routeId,
        routeName: row.routeName,
        ventas: summary.ventasBrutas,
        porCobrar: summary.porCobrar,
        pedidosPendientes: summary.pedidosPendientes,
        utilidadNeta: summary.utilidadNeta,
        devoluciones: summary.devolucionesMonto,
        devolucionRate: summary.devolucionRate,
      });
    }

    return out.sort((a, b) => b.ventas - a.ventas);
  }

  private buildSummary(input: {
    orders: Order[];
    expenses: FinanceExpense[];
    inventory: InventoryItem[];
    accounts: FinanceAccount[];
    projectionDays: number;
    averageWindowDays: number;
    stagnationDays: number;
  }): FinanceSummary {
    const { avgCostUnit, avgSaleUnit, markupMultiplier } = this.estimateMargins(input.orders);
    let ventasBrutas = 0;
    let ingresosCobrados = 0;
    let utilidadBruta = 0;
    let porCobrar = 0;
    let mercanciaTransito = 0;
    let potencialBorradores = 0;
    let potencialPendiente = 0;
    let perdidoStock = 0;
    let perdidoDano = 0;
    let devolucionesMonto = 0;
    let baseVentasDevolucion = 0;
    let pedidosPendientes = 0;
    let pedidosBorrador = 0;
    let pendientesCobro = 0;
    let recentSales = 0;
    let costOfDelivered = 0;

    for (const order of input.orders) {
      const total = this.resolveOrderTotal(order);
      const cost = this.resolveOrderCost(order);
      const grossProfit = Math.max(0, total - cost);
      const paid = Math.max(0, this.toSafeNumber(order.totals?.paid_amount));
      const balance = Math.max(0, this.toSafeNumber(order.totals?.balance_due));
      const status = order.status;
      const isDelivered = DELIVERED_STATUSES.has(status);
      const isCancelled = CANCELLED_STATUSES.has(status);
      const isReturned = RETURNED_STATUSES.has(status);
      const isPipeline = PIPELINE_STATUSES.has(status);

      if (!isCancelled) {
        ventasBrutas += total;
      }

      if (isDelivered) {
        ingresosCobrados += paid > 0 ? paid : balance <= 0 ? total : 0;
        utilidadBruta += grossProfit;
        baseVentasDevolucion += total;
        costOfDelivered += cost;
        if (this.isDateWithinWindow(order.updated_at, input.averageWindowDays)) {
          recentSales += total;
        }
      }

      if (!isCancelled && !isReturned) {
        porCobrar += balance;
      }

      if (status === "borrador") {
        pedidosBorrador += 1;
        potencialBorradores += total > 0 ? total : this.estimateOrderValue(order);
      }

      if (isPipeline && status !== "borrador") {
        pedidosPendientes += 1;
        mercanciaTransito += this.resolveOrderCost(order);
        potencialPendiente += grossProfit;
      }

      if (this.requiresCollectionFollowUp(status, balance)) {
        pendientesCobro += 1;
        potencialPendiente += grossProfit;
      }

      for (const item of order.items || []) {
        const rowValue = this.resolveItemSaleValue(item);
        if (rowValue <= 0) continue;
        if (item.state === "devuelto") {
          devolucionesMonto += rowValue;
        }
        const stockLoss = item.confirmation_state === "out_of_stock" || item.late_addition_status === "missing";
        const damageLoss = item.late_addition_status === "damaged";
        if (damageLoss) perdidoDano += rowValue;
        else if (stockLoss) perdidoStock += rowValue;
      }
    }

    const egresos = input.expenses.reduce((sum, row) => sum + Math.max(0, this.toSafeNumber(row.amount)), 0);
    const perdidasRegistradas = input.expenses
      .filter((row) => row.category === "perdida")
      .reduce((sum, row) => sum + Math.max(0, this.toSafeNumber(row.amount)), 0);
    const utilidadNeta = utilidadBruta - egresos;

    const cajaActual = input.accounts.reduce((sum, account) => sum + this.toSafeNumber(account.balance), 0);
    const averageWindowDays = Math.max(1, input.averageWindowDays);
    const promedioVentaDiaria = recentSales / averageWindowDays;
    const recentExpenses = input.expenses
      .filter((row) => this.isDateWithinWindow(row.occurred_at, averageWindowDays))
      .reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);
    const promedioEgresoDiario = recentExpenses / averageWindowDays;

    let inventarioCosto = 0;
    let estancadoPiezas = 0;
    let estancadoCosto = 0;
    let estancadoPotencial = 0;
    let estancadoGanancia = 0;
    const now = new Date();

    for (const row of input.inventory) {
      const qty = this.inventoryAvailableQty(row);
      if (qty <= 0) continue;
      const costUnit = this.resolveInventoryCostUnit(row, avgCostUnit);
      const value = qty * costUnit;
      inventarioCosto += value;

      const idleDays = this.daysSince(this.pickBestDate(row.updated_at, row.created_at), now);
      if (idleDays < Math.max(1, input.stagnationDays)) continue;
      const estimatedSaleUnit = costUnit > 0 ? costUnit * markupMultiplier : avgSaleUnit;
      const potential = qty * estimatedSaleUnit;
      estancadoPiezas += qty;
      estancadoCosto += value;
      estancadoPotencial += potential;
      estancadoGanancia += Math.max(0, potential - value);
    }

    const proyeccionCaja = cajaActual + porCobrar + (promedioVentaDiaria - promedioEgresoDiario) * Math.max(1, input.projectionDays);
    const devolucionRate = baseVentasDevolucion > 0 ? devolucionesMonto / baseVentasDevolucion : 0;
    const devolucionImpacto = devolucionesMonto + perdidasRegistradas;
    const dsoDias = recentSales > 0 ? (porCobrar / recentSales) * averageWindowDays : 0;
    const inventoryTurnover = inventarioCosto > 0 ? costOfDelivered / inventarioCosto : 0;
    const inventoryDays = inventoryTurnover > 0 ? 365 / inventoryTurnover : 0;

    return {
      ventasBrutas,
      ingresosCobrados,
      egresos,
      utilidadBruta,
      utilidadNeta,
      dsoDias,
      cajaActual,
      porCobrar,
      mercanciaTransito,
      inventarioCosto,
      inventoryTurnover,
      inventoryDays,
      potencialBorradores,
      potencialPendiente,
      promedioVentaDiaria,
      promedioEgresoDiario,
      proyeccionCaja,
      estancadoPiezas,
      estancadoCosto,
      estancadoPotencial,
      estancadoGanancia,
      perdidoStock,
      perdidoDano,
      devolucionesMonto,
      devolucionRate,
      devolucionImpacto,
      pedidosPendientes,
      pedidosBorrador,
      pendientesCobro,
    };
  }

  private estimateMargins(orders: Order[]): { avgCostUnit: number; avgSaleUnit: number; markupMultiplier: number } {
    let saleTotal = 0;
    let costTotal = 0;
    let qtyTotal = 0;
    for (const order of orders) {
      for (const item of order.items || []) {
        const qty = this.resolveItemQty(item);
        if (qty <= 0) continue;
        const saleUnit = this.resolveItemSaleUnit(item);
        const costUnit = this.resolveItemCostUnit(item);
        if (saleUnit > 0) saleTotal += saleUnit * qty;
        if (costUnit > 0) costTotal += costUnit * qty;
        qtyTotal += qty;
      }
    }
    const avgSaleUnit = qtyTotal > 0 ? saleTotal / qtyTotal : 0;
    const avgCostUnit = qtyTotal > 0 ? costTotal / qtyTotal : 0;
    const ratio = avgCostUnit > 0 ? avgSaleUnit / avgCostUnit : 1.35;
    const markupMultiplier = Math.min(2.5, Math.max(1.1, ratio || 1.35));
    return {
      avgCostUnit: avgCostUnit > 0 ? avgCostUnit : 1,
      avgSaleUnit: avgSaleUnit > 0 ? avgSaleUnit : 1.35,
      markupMultiplier,
    };
  }

  private collectRouteRows(routes: RoutePlan[], orders: Order[]): Array<{ routeId: string; routeName: string }> {
    const map = new Map<string, string>();
    for (const route of routes) {
      map.set(route.route_id, route.name || route.route_id);
    }
    for (const order of orders) {
      const routeId = (order.route_id || "sin_ruta").trim() || "sin_ruta";
      if (!map.has(routeId)) map.set(routeId, routeId === "sin_ruta" ? "Sin ruta" : routeId);
    }
    return Array.from(map.entries()).map(([routeId, routeName]) => ({ routeId, routeName }));
  }

  private matchesRoute(orderRouteId: string | null, selectedRouteId: string | null): boolean {
    if (!selectedRouteId) return true;
    return (orderRouteId || "sin_ruta") === selectedRouteId;
  }

  private resolveOrderTotal(order: Order): number {
    const totals = this.toSafeNumber(order.totals?.total_amount);
    if (totals > 0) return totals;
    return this.estimateOrderValue(order);
  }

  private estimateOrderValue(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.resolveItemSaleValue(item), 0);
  }

  private resolveOrderCost(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.resolveItemCostValue(item), 0);
  }

  private resolveItemQty(item: OrderItem): number {
    const candidate = item.confirmed_qty ?? item.quantity;
    return Math.max(1, Math.trunc(this.toSafeNumber(candidate)));
  }

  private resolveItemSaleUnit(item: OrderItem): number {
    const direct = this.toSafeNumber(item.price_clienta);
    if (direct > 0) return direct;
    const publicPrice = this.toSafeNumber(item.price_public);
    if (publicPrice > 0) return Number((publicPrice * 0.75).toFixed(2));
    const cost = this.toSafeNumber(item.price_cost);
    if (cost > 0) return Number((cost * 1.35).toFixed(2));
    return 0;
  }

  private resolveItemCostUnit(item: OrderItem): number {
    const cost = this.toSafeNumber(item.price_cost);
    return cost > 0 ? cost : 0;
  }

  private resolveItemSaleValue(item: OrderItem): number {
    return this.resolveItemSaleUnit(item) * this.resolveItemQty(item);
  }

  private resolveItemCostValue(item: OrderItem): number {
    return this.resolveItemCostUnit(item) * this.resolveItemQty(item);
  }

  private resolveInventoryCostUnit(item: InventoryItem, fallback: number): number {
    const direct = this.toSafeNumber(item.unit_price);
    if (direct > 0) return direct;
    return Math.max(0, fallback);
  }

  private inventoryAvailableQty(item: InventoryItem): number {
    const raw = item.available_qty ?? item.on_hand_qty ?? item.quantity_on_hand;
    return Math.max(0, Math.trunc(this.toSafeNumber(raw)));
  }

  private requiresCollectionFollowUp(status: OrderStatus, balance: number): boolean {
    if (balance <= 0) return false;
    if (CLOSED_STATUSES.has(status)) return false;
    return DELIVERED_STATUSES.has(status) || status === "en_ruta" || status === "in_transit";
  }

  private isDateWithinWindow(rawDate: unknown, days: number): boolean {
    const date = this.toDate(rawDate);
    if (!date) return false;
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 0) return false;
    return diff <= Math.max(1, days) * 24 * 60 * 60 * 1000;
  }

  private toDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "object" && value !== null) {
      const maybe = value as { toDate?: () => Date };
      if (typeof maybe.toDate === "function") {
        const parsed = maybe.toDate();
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    }
    return null;
  }

  private pickBestDate(...values: unknown[]): Date | null {
    for (const value of values) {
      const date = this.toDate(value);
      if (date) return date;
    }
    return null;
  }

  private daysSince(value: Date | null, now: Date): number {
    if (!value) return 9999;
    const diff = now.getTime() - value.getTime();
    if (diff < 0) return 0;
    return Math.floor(diff / (24 * 60 * 60 * 1000));
  }

  private toIsoDate(value: unknown): string | null {
    const date = this.toDate(value);
    if (!date) return null;
    return date.toISOString();
  }

  private normalizeDateInput(value: unknown, fallback: string): string {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = this.toDate(value);
    if (!parsed) return fallback;
    return parsed.toISOString().slice(0, 10);
  }

  private toSafeNumber(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    const n = typeof value === "number" ? value : Number(value || fallback);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.trunc(n));
  }

  private toNullablePositiveInt(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.trunc(n));
  }

  private offsetDate(offsetDays: number): string {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }
}
