import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink, ActivatedRoute } from "@angular/router";
import { AuthzService } from "../../core/authz.service";
import { CustomersService } from "../../core/customers.service";
import { Order, OrderItem, OrdersService } from "../../core/orders.service";
import { calculateItemFinancials, calculateOrderFinancials } from "../../core/order-financials";
import { RoutesService } from "../../core/routes.service";
import {
  FinanceAccount,
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceService,
  FinanceWithdrawal,
  FinanceWithdrawalPurpose,
} from "../../core/finance.service";

type WithdrawalOrderRow = {
  orderId: string;
  customerName: string;
  routeName: string;
  createdAt: string;
  totalClienta: number;
  investment: number;
  profit: number;
};

type SortColumn = "customerName" | "routeName" | "createdAt" | "totalClienta" | "investment" | "profit";
type TableMenuColumn = "customerName" | "routeName" | "createdAt" | "totalClienta" | "investment" | "profit";
type TableMenuOption = { value: string; label: string; count: number };
type PartnerWithdrawalPurpose = "socio_blanca" | "socio_andrea_pepe";

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  compra_inversion: "Compra por inversion",
  perdida: "Perdida",
  paqueteria: "Paqueteria",
  consumibles: "Consumibles",
  deuda_fija: "Deuda fija",
  deuda_meses: "Deuda a meses",
};

const WITHDRAWAL_PURPOSE_LABEL: Record<FinanceWithdrawalPurpose, string> = {
  socio_blanca: "Socio 1 - Blanca Trejo",
  socio_andrea_pepe: "Socio 2 - Andrea y Pepe",
  persona: "Persona",
  sueldo: "Sueldo",
  gasto: "Gasto",
  inversion: "Inversion",
  ahorro: "Ahorro",
  otro: "Otro",
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-retiro-ganancias-page",
  imports: [RouterLink, FormsModule],
  templateUrl: "./retiro-ganancias.page.html",
  styleUrl: "./retiro-ganancias.page.css",
})
export default class RetiroGananciasPage {
  private ordersService = inject(OrdersService);
  private routesService = inject(RoutesService);
  private customersService = inject(CustomersService);
  private financeService = inject(FinanceService);
  private authz = inject(AuthzService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  loading = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  expenseModalOpen = signal(false);
  withdrawalModalOpen = signal(false);
  routeScope = signal("general");
  sortColumn = signal<SortColumn>("totalClienta");
  sortDirection = signal<"asc" | "desc">("desc");
  filterCustomer = signal("");
  filterRoute = signal("");
  filterDateFrom = signal("");
  filterDateTo = signal("");
  filterTotalClienta = signal("");
  filterInvestment = signal("");
  filterProfit = signal("");
  tableMenuOpen = signal<TableMenuColumn | null>(null);
  tableMenuPosition = signal<{ left: number; top: number; width: number } | null>(null);
  routeSelections = signal<string[] | null>(null);
  expenseCategory = signal<FinanceExpenseCategory>("consumibles");
  expenseAmount = signal(0);
  expenseAmountInput = signal("");
  expenseDate = signal(this.offsetDate(0));
  expenseRouteId = signal("general");
  expenseAccountId = signal("none");
  expenseInstallmentTotal = signal<number | null>(null);
  expenseInstallmentIndex = signal<number | null>(null);
  expenseNotes = signal("");
  withdrawalAmount = signal(0);
  withdrawalAmountInput = signal("");
  withdrawalDate = signal(this.offsetDate(0));
  withdrawalPurpose = signal<FinanceWithdrawalPurpose>("socio_blanca");
  withdrawalRecipient = signal("");
  withdrawalRouteId = signal("general");
  withdrawalAccountId = signal("none");
  withdrawalNotes = signal("");

  orders = computed(() => this.ordersService.list());
  routes = computed(() => this.routesService.routes());
  customers = computed(() => this.customersService.customers());
  expenses = computed(() => this.financeService.expenses());
  withdrawals = computed(() => this.financeService.withdrawals());
  accounts = computed(() => this.financeService.accounts());
  canViewMovements = computed(() => this.authz.canCap("cap.finance.movements.view"));
  canCreateMovements = computed(() => this.authz.canCap("cap.finance.movements.create"));

  scopeOptions = computed(() => {
    const base = [{ id: "general", name: "General" }];
    const routes = this.routes().map((row) => ({ id: row.route_id, name: row.name }));
    return [...base, ...routes];
  });

  selectedRouteId = computed(() => {
    const current = this.routeScope();
    if (!current || current === "general") return null;
    return current;
  });

  routeMenuOptions = computed<TableMenuOption[]>(() => {
    const map = new Map<string, TableMenuOption>();
    for (const order of this.filteredOrders()) {
      const label = this.routeName(order.route_id);
      const key = this.normalizeText(label) || "general";
      const found = map.get(key);
      if (found) {
        found.count += 1;
      } else {
        map.set(key, { value: key, label, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "es-MX"));
  });

  hasRouteFilter = computed(() => this.routeSelections() !== null);

  filteredOrders = computed(() => {
    const routeId = this.selectedRouteId();
    return this.orders().filter((order) => this.matchesRoute(order.route_id, routeId));
  });
  filteredExpenses = computed(() => {
    const routeId = this.selectedRouteId();
    if (!routeId) return this.expenses();
    return this.expenses().filter((row) => (row.route_id || "") === routeId);
  });

  filteredWithdrawals = computed(() => {
    const routeId = this.selectedRouteId();
    if (!routeId) return this.withdrawals();
    return this.withdrawals().filter((row) => (row.route_id || "") === routeId);
  });

  orderRows = computed<WithdrawalOrderRow[]>(() => {
    const customerFilter = this.normalizeText(this.filterCustomer());
    const routeFilter = this.normalizeText(this.filterRoute());
    const routeSelections = this.routeSelections();
    const from = this.filterDateFrom();
    const to = this.filterDateTo();
    const totalFilter = this.filterTotalClienta();
    const investmentFilter = this.filterInvestment();
    const profitFilter = this.filterProfit();
    const sortColumn = this.sortColumn();
    const sortDirection = this.sortDirection();
    const dir = sortDirection === "asc" ? 1 : -1;

    const rows = this.filteredOrders()
      .map((order) => this.toOrderRow(order))
      .filter((row) => {
        if (customerFilter && !this.normalizeText(row.customerName).includes(customerFilter)) return false;
        const routeKey = this.normalizeText(row.routeName) || "general";
        if (routeSelections !== null && !routeSelections.includes(routeKey)) return false;
        if (routeFilter && !routeKey.includes(routeFilter)) return false;
        const date = this.toDateInput(row.createdAt);
        if (from && (!date || date < from)) return false;
        if (to && (!date || date > to)) return false;
        if (!this.matchesNumericFilter(row.totalClienta, totalFilter)) return false;
        if (!this.matchesNumericFilter(row.investment, investmentFilter)) return false;
        if (!this.matchesNumericFilter(row.profit, profitFilter)) return false;
        return true;
      });

    return rows.sort((a, b) => {
      const va = a[sortColumn];
      const vb = b[sortColumn];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "es-MX") * dir;
    });
  });

  totals = computed(() => {
    const rows = this.orderRows();
    return {
      totalClienta: rows.reduce((sum, row) => sum + row.totalClienta, 0),
      investment: rows.reduce((sum, row) => sum + row.investment, 0),
      profit: rows.reduce((sum, row) => sum + row.profit, 0),
    };
  });

  financialBreakdown = computed(() => {
    const grossProfit = this.toSafeNumber(this.totals().profit);
    const expensesTotal = this.filteredExpenses().reduce((sum, row) => sum + Math.max(0, this.toSafeNumber(row.amount)), 0);
    const netProfitBase = Math.max(0, grossProfit - expensesTotal);
    const totalWithdrawn = this.filteredWithdrawals().reduce((sum, row) => sum + Math.max(0, this.toSafeNumber(row.amount)), 0);
    const available = Math.max(0, netProfitBase - totalWithdrawn);
    return {
      grossProfit: this.toSafeNumber(grossProfit),
      expensesTotal: this.toSafeNumber(expensesTotal),
      netProfitBase: this.toSafeNumber(netProfitBase),
      totalWithdrawn: this.toSafeNumber(totalWithdrawn),
      available: this.toSafeNumber(available),
    };
  });

  withdrawalPartnerSummary = computed(() => {
    let withdrawnBlanca = 0;
    let withdrawnAndreaPepe = 0;
    let withdrawnNonPartner = 0;
    for (const row of this.filteredWithdrawals()) {
      const partner = this.resolveWithdrawalPartner(row);
      if (partner === "socio_blanca") withdrawnBlanca += this.toSafeNumber(row.amount);
      else if (partner === "socio_andrea_pepe") withdrawnAndreaPepe += this.toSafeNumber(row.amount);
      else withdrawnNonPartner += this.toSafeNumber(row.amount);
    }
    const distributableBase = Math.max(0, this.financialBreakdown().netProfitBase - withdrawnNonPartner);
    const perPartnerTarget = this.toSafeNumber(distributableBase / 2);
    const pendingBlanca = Math.max(0, perPartnerTarget - withdrawnBlanca);
    const pendingAndreaPepe = Math.max(0, perPartnerTarget - withdrawnAndreaPepe);
    return {
      distributableBase: this.toSafeNumber(distributableBase),
      perPartnerTarget,
      withdrawnBlanca: this.toSafeNumber(withdrawnBlanca),
      withdrawnAndreaPepe: this.toSafeNumber(withdrawnAndreaPepe),
      withdrawnNonPartner: this.toSafeNumber(withdrawnNonPartner),
      pendingBlanca: this.toSafeNumber(pendingBlanca),
      pendingAndreaPepe: this.toSafeNumber(pendingAndreaPepe),
    };
  });

  expenseRows = computed(() =>
    [...this.filteredExpenses()].sort((a, b) => (this.toIsoDate(b.occurred_at) || "").localeCompare(this.toIsoDate(a.occurred_at) || "")),
  );
  withdrawalRows = computed(() =>
    [...this.filteredWithdrawals()].sort((a, b) => (this.toIsoDate(b.occurred_at) || "").localeCompare(this.toIsoDate(a.occurred_at) || "")),
  );

  partnerSplit = computed(() => {
    const totalProfit = this.toSafeNumber(this.withdrawalPartnerSummary().distributableBase);
    const perPartner = this.toSafeNumber(totalProfit / 2);
    return {
      totalProfit,
      socioBlanca: perPartner,
      socioAndreaPepe: perPartner,
    };
  });

  constructor() {
    const scope = String(this.route.snapshot.queryParamMap.get("scope") || "general").trim();
    this.routeScope.set(scope || "general");
    this.reload().catch(() => null);
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    try {
      await Promise.all([
        this.ordersService.loadFromFirestore(),
        this.routesService.loadFromFirestore().catch(() => null),
        this.customersService.loadFromFirestore().catch(() => null),
        this.financeService.loadAll(),
      ]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo cargar el detalle de retiros.";
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  setRouteScope(value: unknown) {
    const next = String(value || "general").trim() || "general";
    this.routeScope.set(next);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { scope: next },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  openExpenseModal() {
    this.expenseModalOpen.set(true);
  }

  closeExpenseModal() {
    this.expenseModalOpen.set(false);
  }

  openWithdrawalModal() {
    this.withdrawalModalOpen.set(true);
  }

  closeWithdrawalModal() {
    this.withdrawalModalOpen.set(false);
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

  setExpenseAmountInput(value: unknown) {
    const normalized = this.normalizeCurrencyInput(String(value || ""));
    this.expenseAmount.set(normalized.amount);
    this.expenseAmountInput.set(normalized.formatted);
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
    const n = Math.trunc(this.toSafeNumber(value));
    this.expenseInstallmentTotal.set(n > 0 ? n : null);
  }

  setExpenseInstallmentIndex(value: unknown) {
    const n = Math.trunc(this.toSafeNumber(value));
    this.expenseInstallmentIndex.set(n > 0 ? n : null);
  }

  setExpenseNotes(value: unknown) {
    this.expenseNotes.set(String(value || ""));
  }

  async submitExpense() {
    if (!this.canCreateMovements()) return;
    if (this.expenseAmount() <= 0) {
      this.error.set("El monto del egreso debe ser mayor a 0.");
      return;
    }
    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveExpense({
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
      this.closeExpenseModal();
      this.success.set("Egreso registrado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar el egreso.";
      this.error.set(message);
    }
  }

  resetExpenseForm() {
    this.expenseCategory.set("consumibles");
    this.expenseAmount.set(0);
    this.expenseAmountInput.set("");
    this.expenseDate.set(this.offsetDate(0));
    this.expenseRouteId.set(this.selectedRouteId() || "general");
    this.expenseAccountId.set("none");
    this.expenseInstallmentTotal.set(null);
    this.expenseInstallmentIndex.set(null);
    this.expenseNotes.set("");
  }

  setWithdrawalAmount(value: unknown) {
    this.withdrawalAmount.set(this.toSafeNumber(value));
  }

  setWithdrawalAmountInput(value: unknown) {
    const normalized = this.normalizeCurrencyInput(String(value || ""));
    this.withdrawalAmount.set(normalized.amount);
    this.withdrawalAmountInput.set(normalized.formatted);
  }

  setWithdrawalDate(value: unknown) {
    this.withdrawalDate.set(this.normalizeDateInput(value, this.offsetDate(0)));
  }

  setWithdrawalPurpose(value: unknown) {
    const raw = String(value || "").trim();
    if (raw === "socio_blanca" || raw === "socio_andrea_pepe" || raw === "persona" || raw === "sueldo" || raw === "gasto" || raw === "inversion" || raw === "ahorro" || raw === "otro") {
      this.withdrawalPurpose.set(raw);
    }
  }

  setWithdrawalRecipient(value: unknown) {
    this.withdrawalRecipient.set(String(value || ""));
  }

  setWithdrawalRouteId(value: unknown) {
    const raw = String(value || "general").trim();
    this.withdrawalRouteId.set(raw || "general");
  }

  setWithdrawalAccountId(value: unknown) {
    const raw = String(value || "none").trim();
    this.withdrawalAccountId.set(raw || "none");
  }

  setWithdrawalNotes(value: unknown) {
    this.withdrawalNotes.set(String(value || ""));
  }

  async submitWithdrawal() {
    if (!this.canCreateMovements()) return;
    if (this.withdrawalAmount() <= 0) {
      this.error.set("El monto del retiro debe ser mayor a 0.");
      return;
    }
    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveWithdrawal({
        amount: this.withdrawalAmount(),
        occurred_at: this.withdrawalDate(),
        purpose: this.withdrawalPurpose(),
        recipient: this.withdrawalRecipient().trim() || null,
        route_id: this.withdrawalRouteId() === "general" ? null : this.withdrawalRouteId(),
        account_id: this.withdrawalAccountId() === "none" ? null : this.withdrawalAccountId(),
        notes: this.withdrawalNotes().trim() || null,
      });
      this.resetWithdrawalForm();
      this.closeWithdrawalModal();
      this.success.set("Retiro registrado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar el retiro.";
      this.error.set(message);
    }
  }

  resetWithdrawalForm() {
    this.withdrawalAmount.set(0);
    this.withdrawalAmountInput.set("");
    this.withdrawalDate.set(this.offsetDate(0));
    this.withdrawalPurpose.set("socio_blanca");
    this.withdrawalRecipient.set("");
    this.withdrawalRouteId.set(this.selectedRouteId() || "general");
    this.withdrawalAccountId.set("none");
    this.withdrawalNotes.set("");
  }

  toggleSort(column: SortColumn) {
    if (this.sortColumn() === column) {
      this.sortDirection.set(this.sortDirection() === "asc" ? "desc" : "asc");
      return;
    }
    this.sortColumn.set(column);
    this.sortDirection.set(column === "customerName" || column === "routeName" ? "asc" : "desc");
  }

  setSortFromMenu(column: SortColumn, direction: "asc" | "desc", event?: Event) {
    event?.stopPropagation();
    this.sortColumn.set(column);
    this.sortDirection.set(direction);
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
  }

  sortArrow(column: SortColumn): string {
    if (this.sortColumn() !== column) return "↕";
    return this.sortDirection() === "asc" ? "↑" : "↓";
  }

  toggleTableColumnMenu(column: TableMenuColumn, event?: Event) {
    event?.stopPropagation();
    if (this.tableMenuOpen() === column) {
      this.tableMenuOpen.set(null);
      this.tableMenuPosition.set(null);
      return;
    }
    this.tableMenuOpen.set(column);
    this.tableMenuPosition.set(this.computeTableMenuPosition(event));
  }

  isTableColumnMenuOpen(column: TableMenuColumn): boolean {
    return this.tableMenuOpen() === column;
  }

  isRouteOptionChecked(value: string): boolean {
    const selected = this.routeSelections();
    if (selected === null) return true;
    return selected.includes(value);
  }

  toggleRouteOption(value: string, checked: boolean) {
    const options = this.routeMenuOptions().map((option) => option.value);
    this.routeSelections.update((selected) => this.updateColumnSelection(selected, options, value, checked));
  }

  clearRouteColumnFilter(event?: Event) {
    event?.stopPropagation();
    this.routeSelections.set(null);
  }

  @HostListener("document:keydown.escape")
  onTableMenuEscape(): void {
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
  }

  @HostListener("document:click", ["$event"])
  onTableMenuOutsideClick(event: MouseEvent): void {
    if (!this.tableMenuOpen()) return;
    const target = event.target as HTMLElement | null;
    if (!target) {
      this.tableMenuOpen.set(null);
      this.tableMenuPosition.set(null);
      return;
    }
    if (target.closest(".th-menu-trigger") || target.closest(".th-menu-dropdown")) return;
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
  }

  @HostListener("window:resize")
  onWindowResizeCloseTableMenu(): void {
    if (!this.tableMenuOpen()) return;
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
  }

  openOrder(orderId: string) {
    this.router.navigate(["/main/pedidos", orderId], {
      state: {
        from: "administracion.retiro-ganancias",
        scope: this.routeScope(),
      },
    });
  }

  routeName(routeId: string | null): string {
    if (!routeId) return "General";
    return this.routes().find((row) => row.route_id === routeId)?.name || routeId;
  }

  expenseCategoryLabel(key: string): string {
    return EXPENSE_CATEGORY_LABEL[key] || key;
  }

  withdrawalPurposeLabel(key: FinanceWithdrawalPurpose): string {
    return WITHDRAWAL_PURPOSE_LABEL[key];
  }

  withdrawalDestinationLabel(row: FinanceWithdrawal): string {
    const base = this.withdrawalPurposeLabel(row.purpose);
    if (!row.recipient) return base;
    return `${base}: ${row.recipient}`;
  }

  partnerPendingLabel(partner: PartnerWithdrawalPurpose): string {
    return partner === "socio_blanca" ? "Pendiente Blanca Trejo" : "Pendiente Andrea y Pepe";
  }

  trackExpenseRow = (_: number, row: FinanceExpense) => row.expense_id;
  trackWithdrawalRow = (_: number, row: FinanceWithdrawal) => row.withdrawal_id;
  trackAccount = (_: number, row: FinanceAccount) => row.account_id;

  customerName(customerId: string): string {
    const customer = this.customersService.getById(customerId);
    if (!customer) return "Clienta sin nombre";
    return [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() || "Clienta sin nombre";
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(this.toSafeNumber(value));
  }

  formatDate(value: unknown): string {
    const iso = this.toIsoDate(value);
    if (!iso) return "-";
    return new Date(iso).toLocaleDateString("es-MX");
  }

  trackScope = (_: number, row: { id: string }) => row.id;
  trackOrderRow = (_: number, row: WithdrawalOrderRow) => row.orderId;

  private toOrderRow(order: Order): WithdrawalOrderRow {
    const totalClienta = this.resolveOrderTotal(order);
    const investment = this.resolveOrderCost(order);
    const profit = Math.max(0, totalClienta - investment);
    return {
      orderId: order.order_id,
      customerName: this.customerName(order.customer_id),
      routeName: this.routeName(order.route_id),
      createdAt: order.created_at,
      totalClienta: this.toSafeNumber(totalClienta),
      investment: this.toSafeNumber(investment),
      profit: this.toSafeNumber(profit),
    };
  }

  private resolveOrderTotal(order: Order): number {
    return calculateOrderFinancials(order).netAmount;
  }

  private resolveOrderCost(order: Order): number {
    return calculateOrderFinancials(order).netCost;
  }

  private resolveItemSaleValue(item: OrderItem): number {
    return calculateItemFinancials(item).netClient;
  }

  private resolveItemCostValue(item: OrderItem): number {
    return calculateItemFinancials(item).netCost;
  }

  private matchesRoute(orderRouteId: string | null, selectedRouteId: string | null): boolean {
    if (!selectedRouteId) return true;
    return (orderRouteId || "") === selectedRouteId;
  }

  private toIsoDate(value: unknown): string | null {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }

  private resolveWithdrawalPartner(row: FinanceWithdrawal): PartnerWithdrawalPurpose | null {
    if (row.purpose === "socio_blanca") return "socio_blanca";
    if (row.purpose === "socio_andrea_pepe") return "socio_andrea_pepe";
    const hint = this.normalizeText(`${row.recipient || ""} ${row.notes || ""}`);
    if (hint.includes("blanca")) return "socio_blanca";
    if (hint.includes("andrea") || hint.includes("pepe")) return "socio_andrea_pepe";
    return null;
  }

  private toDateInput(value: unknown): string {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return "";
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private normalizeDateInput(value: unknown, fallback: string): string {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return fallback;
    return this.toDateInput(parsed.toISOString()) || fallback;
  }

  private normalizeText(value: unknown): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  private matchesNumericFilter(value: number, filter: string): boolean {
    const raw = String(filter || "").trim();
    if (!raw) return true;
    const simple = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(simple)) return value === simple;
    const opMatch = raw.match(/^(<=|>=|<|>|=)\s*(-?\d+(?:[.,]\d+)?)$/);
    if (opMatch) {
      const op = opMatch[1];
      const target = Number(opMatch[2].replace(",", "."));
      if (!Number.isFinite(target)) return true;
      if (op === "<") return value < target;
      if (op === "<=") return value <= target;
      if (op === ">") return value > target;
      if (op === ">=") return value >= target;
      return value === target;
    }
    const rangeMatch = raw.match(/^(-?\d+(?:[.,]\d+)?)\s*\.\.\s*(-?\d+(?:[.,]\d+)?)$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1].replace(",", "."));
      const b = Number(rangeMatch[2].replace(",", "."));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      return value >= min && value <= max;
    }
    return true;
  }

  private computeTableMenuPosition(event?: Event): { left: number; top: number; width: number } {
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const fallback = { left: Math.max(12, viewportWidth - 280), top: 96, width: 260 };
    if (!event) return fallback;
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return fallback;
    const rect = target.getBoundingClientRect();
    const width = Math.max(rect.width, 220);
    const left = Math.min(Math.max(12, rect.left), Math.max(12, viewportWidth - width - 12));
    const top = Math.min(rect.bottom + 6, viewportHeight - 16);
    return { left, top, width };
  }

  private updateColumnSelection(
    selected: string[] | null,
    options: string[],
    value: string,
    checked: boolean,
  ): string[] | null {
    const current = selected ? [...selected] : [...options];
    const next = checked ? [...new Set([...current, value])] : current.filter((item) => item !== value);
    if (next.length === options.length) return null;
    if (next.length === 0) return [];
    return next;
  }

  private toSafeNumber(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n;
  }

  private offsetDate(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return this.toDateInput(date.toISOString());
  }

  private normalizeCurrencyInput(value: string): { amount: number; formatted: string } {
    const raw = String(value || "").trim();
    if (!raw) return { amount: 0, formatted: "" };
    const digitsAndDots = raw.replace(/[^0-9.]/g, "");
    const firstDot = digitsAndDots.indexOf(".");
    const canonical =
      firstDot >= 0
        ? `${digitsAndDots.slice(0, firstDot + 1)}${digitsAndDots.slice(firstDot + 1).replace(/\./g, "")}`
        : digitsAndDots;
    const parts = canonical.split(".");
    const intPart = (parts[0] || "").replace(/^0+(?=\d)/, "");
    const decPart = (parts[1] || "").slice(0, 2);
    const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const formatted = decPart ? `${intWithCommas}.${decPart}` : intWithCommas;
    const amount = this.toSafeNumber(Number(decPart ? `${intPart || "0"}.${decPart}` : intPart || "0"));
    return { amount, formatted };
  }
}
