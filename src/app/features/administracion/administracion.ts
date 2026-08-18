
import { NgClass } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { AuthzService } from "../../core/authz.service";
import { CustomersService } from "../../core/customers.service";
import {
  FinanceAccount,
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceService,
  FinanceWithdrawal,
  FinanceWithdrawalPurpose,
} from "../../core/finance.service";
import { InventoryItem, InventoryService } from "../../core/inventory.service";
import { Order, OrderItem, OrderStatus, OrdersService } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { BusinessScopeService } from "../../core/business-scope.service";
import { BusinessId } from "../../core/rbac.constants";
import { calculateOrderFinancials, calculateItemFinancials } from "../../core/order-financials";
import { calculatePartnerWithdrawalSummary, calculateWithdrawalProfit } from "../../core/withdrawal-profit";

type MoneyBucketId =
  | "openDrafts"
  | "confirmedNeedInvestment"
  | "investedNotDelivered"
  | "deliveredPendingCollection"
  | "stagnantInventory"
  | "collectedShouldBeInAccount"
  | "collectedByCourierPendingSettlement";

type BucketOrderRow = {
  bucketId: MoneyBucketId;
  orderId: string;
  routeId: string;
  customerId: string;
  status: OrderStatus;
  createdAt: string | null;
  amountClienta: number;
  cost: number;
  margin: number;
  paid: number;
  balance: number;
  note: string;
};

type BucketInventoryRow = {
  bucketId: MoneyBucketId;
  inventoryId: string;
  title: string;
  quantity: number;
  idleDays: number;
  cost: number;
  potentialSale: number;
  potentialMargin: number;
};

type MoneyBucket = {
  id: MoneyBucketId;
  title: string;
  description: string;
  count: number;
  amountClienta: number;
  cost: number;
  margin: number;
  paid: number;
  balance: number;
  orderRows: BucketOrderRow[];
  inventoryRows: BucketInventoryRow[];
};

type SummaryRow = {
  routeId: string;
  routeName: string;
  ordersCount: number;
  porCobrarReal: number;
  pipelineClienta: number;
  capitalRequerido: number;
  cobradoConRepartidor: number;
  gananciaPendiente: number;
  customerPreview: string;
  detailRows: BucketOrderRow[];
};

type DrilldownRow = {
  rowId: string;
  type: "order" | "inventory";
  primary: string;
  secondary: string;
  status: string;
  createdAt: string | null;
  amountClienta: number;
  cost: number;
  margin: number;
  paid: number;
  balance: number;
  orderId: string | null;
};

type DrilldownColumn = "primary" | "status" | "createdAt" | "amountClienta" | "cost" | "margin" | "paid";
type DrilldownFilterColumn = Exclude<DrilldownColumn, "createdAt">;

type DrilldownSortState = {
  column: DrilldownColumn;
  direction: "asc" | "desc";
};

type DrilldownFilterState = Record<DrilldownFilterColumn, string>;

type DrilldownDateRange = {
  start: string;
  end: string;
};

type DrilldownState = {
  id: string;
  title: string;
  subtitle: string;
  totalAmountClienta: number;
  totalCost: number;
  totalMargin: number;
  totalPaid: number;
  totalBalance: number;
  rows: DrilldownRow[];
};

type FinanceSummary = {
  ventasBrutas: number;
  descuentos: number;
  ventasNetas: number;
  ingresosCobrados: number;
  egresos: number;
  utilidadBruta: number;
  utilidadNeta: number;
  utilidadCobradaBase: number;
  gananciaPendienteCobro: number;
  saldoPendienteCobro: number;
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
  devolucionUnidadesRate: number;
  devolucionImpacto: number;
  pedidosPendientes: number;
  pedidosBorrador: number;
  pendientesCobro: number;
  pipelineClienta: number;
  capitalPorInvertir: number;
  cobradoConRepartidor: number;
  cobradoPorDepositar: number;
  gananciaPendientePipeline: number;
  buckets: MoneyBucket[];
  orderBucketRows: BucketOrderRow[];
};

type BusinessFinanceSummaryRow = {
  businessId: BusinessId;
  label: string;
  summary: FinanceSummary;
};

type OrderFinancialSnapshot = {
  order: Order;
  status: OrderStatus;
  routeId: string;
  customerId: string;
  totalClienta: number;
  cost: number;
  grossProfit: number;
  grossSales: number;
  returnsAmount: number;
  paid: number;
  balance: number;
  remaining: number;
  paidRatio: number;
  remainingRatio: number;
};

const EXPENSE_CATEGORY_LABEL: Record<FinanceExpenseCategory, string> = {
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

type PartnerWithdrawalPurpose = "socio_blanca" | "socio_andrea_pepe";

const MONEY_BUCKET_ORDER: MoneyBucketId[] = [
  "openDrafts",
  "confirmedNeedInvestment",
  "investedNotDelivered",
  "deliveredPendingCollection",
  "collectedByCourierPendingSettlement",
  "collectedShouldBeInAccount",
  "stagnantInventory",
];
const MONEY_BUCKET_META: Record<MoneyBucketId, { title: string; description: string }> = {
  openDrafts: {
    title: "1) Borrador de pedidos",
    description: "Aun en apertura; sin solicitud ni pago a proveedor.",
  },
  confirmedNeedInvestment: {
    title: "2) Inversión en puerta",
    description: "Confirmados para pedir; falta invertir capital.",
  },
  investedNotDelivered: {
    title: "3) Pedidos por entregar",
    description: "Mercancia pagada/en proceso que aun no llega a clienta.",
  },
  deliveredPendingCollection: {
    title: "4) Cuentas pendientes",
    description: "Pedido entregado con saldo pendiente de cobro.",
  },
  stagnantInventory: {
    title: "7) Inventario estancado",
    description: "Dinero en mercancia sin dueña y con baja rotacion.",
  },
  collectedShouldBeInAccount: {
    title: "6) Cobrado",
    description: "Cobrado y fuera de ruta; debe reflejarse en cuenta.",
  },
  collectedByCourierPendingSettlement: {
    title: "5) Cobrado por repartidor",
    description: "Cobrado en ruta y pendiente de liquidacion.",
  },
};

const STATUS_LABELS: Record<string, string> = {
  borrador: "Borrador",
  confirmando_proveedor: "Confirmando proveedor",
  reservado_inventario: "Reservado inventario",
  solicitado_proveedor: "Solicitado proveedor",
  supplier_processing: "Proveedor procesando",
  inbound_in_transit: "En transito proveedor",
  en_transito: "En transito proveedor",
  recibido_qa: "En transito proveedor",
  packing: "Empacando",
  empaque: "Empaque",
  ready_for_route: "Listo para ruta",
  assigned_to_run: "Asignado a salida",
  in_transit: "En ruta",
  en_ruta: "En ruta",
  delivered: "Entregado",
  delivered_partial: "Entrega parcial",
  entregado: "Entregado",
  pago_pendiente: "Pago pendiente",
  pagado: "Pagado",
  closed: "Cerrado",
  cancelado: "Cancelado",
  devuelto: "Devuelto",
};

const DELIVERED_STATUSES = new Set<OrderStatus>(["entregado", "delivered", "delivered_partial", "pago_pendiente", "pagado_parcial", "pagado", "closed"]);
const RETURNED_STATUSES = new Set<OrderStatus>(["devuelto"]);
const CANCELLED_STATUSES = new Set<OrderStatus>(["cancelado"]);
const NEED_INVEST_STATUSES = new Set<OrderStatus>(["confirmando_proveedor", "reservado_inventario", "solicitado_proveedor", "supplier_processing"]);
const INVESTED_NOT_DELIVERED_STATUSES = new Set<OrderStatus>([
  "inbound_in_transit",
  "en_transito",
  "recibido_qa",
  "packing",
  "empaque",
  "ready_for_route",
  "assigned_to_run",
  "in_transit",
  "en_ruta",
]);
const COURIER_COLLECTION_STATUSES = new Set<OrderStatus>(["in_transit", "en_ruta", "assigned_to_run"]);

const DRILLDOWN_DEFAULT_SORT: DrilldownSortState = {
  column: "amountClienta",
  direction: "desc",
};

const DRILLDOWN_COLUMN_DEFAULT_DIRECTION: Record<DrilldownColumn, "asc" | "desc"> = {
  primary: "asc",
  status: "asc",
  createdAt: "desc",
  amountClienta: "desc",
  cost: "desc",
  margin: "desc",
  paid: "desc",
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-administracion",
  imports: [FormsModule, NgClass],
  templateUrl: "./administracion.html",
  styleUrl: "./administracion.css",
})
export default class AdministracionPage {
  private ordersService = inject(OrdersService);
  private inventoryService = inject(InventoryService);
  private routesService = inject(RoutesService);
  private financeService = inject(FinanceService);
  private customersService = inject(CustomersService);
  businessScope = inject(BusinessScopeService);
  private authz = inject(AuthzService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private pendingDrilldownRestore = signal<string | null>(null);

  loading = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  drilldown = signal<DrilldownState | null>(null);
  drilldownSort = signal<DrilldownSortState>({ ...DRILLDOWN_DEFAULT_SORT });
  drilldownFilters = signal<DrilldownFilterState>(this.createEmptyDrilldownFilters());
  drilldownDateRange = signal<DrilldownDateRange>({
    start: "",
    end: "",
  });

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

  withdrawalEditingId = signal<string | null>(null);
  withdrawalAmount = signal(0);
  withdrawalAmountInput = signal("");
  withdrawalDate = signal(this.offsetDate(0));
  withdrawalPurpose = signal<FinanceWithdrawalPurpose>("socio_blanca");
  withdrawalRecipient = signal("");
  withdrawalRouteId = signal("general");
  withdrawalAccountId = signal("none");
  withdrawalNotes = signal("");

  orders = computed(() => this.ordersService.list());
  inventoryItems = computed(() => this.inventoryService.items());
  routes = computed(() => this.routesService.routes());
  accounts = computed(() => this.financeService.accounts());
  expenses = computed(() => this.financeService.expenses());
  withdrawals = computed(() => this.financeService.withdrawals());
  cuts = computed(() => this.financeService.cuts());
  refunds = computed(() => this.financeService.refunds());
  customers = computed(() => this.customersService.customers());
  refundsTotal = computed(() => this.refunds().reduce((sum, row) => sum + Number(row.amount || 0), 0));
  customerCreditsTotal = computed(() => this.customers().reduce((sum, row) => sum + Number(row.credit_balance || 0), 0));

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

  filteredWithdrawals = computed(() => {
    const routeId = this.selectedRouteId();
    if (!routeId) return this.withdrawals();
    return this.withdrawals().filter((row) => row.route_id === routeId);
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

  businessSummaryRows = computed<BusinessFinanceSummaryRow[]>(() => {
    if (!this.businessScope.isBothMode()) return [];
    return this.businessScope.activeBusinessIds().map((businessId) => ({
      businessId,
      label: this.businessScope.businessShortLabel(businessId),
      summary: this.buildSummary({
        orders: this.filteredOrders().filter((order) => (order.business_id || "bm") === businessId),
        expenses: this.filteredExpenses().filter((row) => (row.business_id || "bm") === businessId),
        inventory: this.inventoryItems().filter((item) => (item.business_id || "bm") === businessId),
        accounts: this.accounts().filter((account) => (account.business_id || "bm") === businessId),
        projectionDays: this.projectionDays(),
        averageWindowDays: this.averageWindowDays(),
        stagnationDays: this.stagnationDays(),
      }),
    }));
  });

  businessSummaryClass(row: BusinessFinanceSummaryRow): string {
    return row.businessId === "catalogo" ? "business-catalogo" : "business-bm";
  }

  withdrawalSummary = computed(() => {
    const summary = this.summary();
    const baseDisponible = Math.max(0, summary.utilidadCobradaBase);
    const totalRetirado = this.filteredWithdrawals().reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);
    const disponible = Math.max(0, baseDisponible - totalRetirado);
    return {
      baseDisponible: this.toSafeNumber(baseDisponible),
      totalRetirado: this.toSafeNumber(totalRetirado),
      disponible: this.toSafeNumber(disponible),
      gananciaPendienteCobro: this.toSafeNumber(summary.gananciaPendienteCobro),
      saldoPendienteCobro: this.toSafeNumber(summary.saldoPendienteCobro),
    };
  });

  withdrawalPartnerSummary = computed(() => {
    let withdrawnBlanca = 0;
    let withdrawnAndreaPepe = 0;
    let withdrawnNonPartner = 0;

    for (const row of this.filteredWithdrawals()) {
      const partner = this.resolveWithdrawalPartner(row);
      if (partner === "socio_blanca") {
        withdrawnBlanca += this.toSafeNumber(row.amount);
      } else if (partner === "socio_andrea_pepe") {
        withdrawnAndreaPepe += this.toSafeNumber(row.amount);
      } else {
        withdrawnNonPartner += this.toSafeNumber(row.amount);
      }
    }

    const partnerAmounts = calculatePartnerWithdrawalSummary(
      this.withdrawalSummary().baseDisponible,
      withdrawnBlanca,
      withdrawnAndreaPepe,
      withdrawnNonPartner,
    );

    return {
      distributableBase: this.toSafeNumber(partnerAmounts.distributableBase),
      perPartnerTarget: this.toSafeNumber(partnerAmounts.perPartnerTarget),
      withdrawnBlanca: this.toSafeNumber(withdrawnBlanca),
      withdrawnAndreaPepe: this.toSafeNumber(withdrawnAndreaPepe),
      withdrawnNonPartner: this.toSafeNumber(withdrawnNonPartner),
      pendingBlanca: this.toSafeNumber(partnerAmounts.pendingBlanca),
      pendingAndreaPepe: this.toSafeNumber(partnerAmounts.pendingAndreaPepe),
      excessBlanca: this.toSafeNumber(partnerAmounts.excessBlanca),
      excessAndreaPepe: this.toSafeNumber(partnerAmounts.excessAndreaPepe),
    };
  });

  withdrawalSelectedPartner = computed(() => this.asPartnerPurpose(this.withdrawalPurpose()));

  withdrawalAvailableForForm = computed(() => {
    const editingId = this.withdrawalEditingId();
    if (!editingId) return this.withdrawalSummary().disponible;
    const current = this.filteredWithdrawals().find((row) => row.withdrawal_id === editingId);
    return this.toSafeNumber(this.withdrawalSummary().disponible + this.toSafeNumber(current?.amount));
  });

  withdrawalAvailableForSelectedPartner = computed(() => {
    const selectedPartner = this.withdrawalSelectedPartner();
    if (!selectedPartner) return this.withdrawalAvailableForForm();
    const summary = this.withdrawalPartnerSummary();
    const editingId = this.withdrawalEditingId();
    const baseWithdrawn = selectedPartner === "socio_blanca" ? summary.withdrawnBlanca : summary.withdrawnAndreaPepe;
    const current = editingId ? this.filteredWithdrawals().find((row) => row.withdrawal_id === editingId) : null;
    const currentPartner = current ? this.resolveWithdrawalPartner(current) : null;
    const restoredCurrentAmount = current && currentPartner === selectedPartner ? this.toSafeNumber(current.amount) : 0;
    const available = Math.max(0, summary.perPartnerTarget - baseWithdrawn + restoredCurrentAmount);
    return this.toSafeNumber(available);
  });

  routeRows = computed(() => this.buildRouteRows(this.summary().orderBucketRows));
  drilldownRows = computed(() => {
    const detail = this.drilldown();
    if (!detail) return [];
    const filters = this.drilldownFilters();
    const dateRange = this.drilldownDateRange();
    const sort = this.drilldownSort();
    return detail.rows
      .filter((row) => this.matchesDrilldownFilters(row, filters, dateRange))
      .sort((a, b) => this.compareDrilldownRows(a, b, sort));
  });

  constructor() {
    this.restoreReturnContextFromQuery();
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
        this.customersService.loadFromFirestore().catch(() => null),
        this.financeService.loadAll(),
      ]);
      const pending = this.pendingDrilldownRestore();
      if (pending) {
        this.tryRestoreDrilldown(pending);
        this.pendingDrilldownRestore.set(null);
      }
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
    this.drilldown.set(null);
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

  startEditWithdrawal(row: FinanceWithdrawal) {
    if (!this.canEditMovements()) return;
    this.withdrawalEditingId.set(row.withdrawal_id);
    this.withdrawalAmount.set(row.amount);
    this.withdrawalAmountInput.set(this.formatCurrencyInput(row.amount));
    this.withdrawalDate.set(this.normalizeDateInput(row.occurred_at, this.offsetDate(0)));
    this.withdrawalPurpose.set(row.purpose);
    this.withdrawalRecipient.set(row.recipient || "");
    this.withdrawalRouteId.set(row.route_id || "general");
    this.withdrawalAccountId.set(row.account_id || "none");
    this.withdrawalNotes.set(row.notes || "");
  }

  resetWithdrawalForm() {
    this.withdrawalEditingId.set(null);
    this.withdrawalAmount.set(0);
    this.withdrawalAmountInput.set("");
    this.withdrawalDate.set(this.offsetDate(0));
    this.withdrawalPurpose.set("socio_blanca");
    this.withdrawalRecipient.set("");
    this.withdrawalRouteId.set(this.selectedRouteId() || "general");
    this.withdrawalAccountId.set("none");
    this.withdrawalNotes.set("");
  }

  setWithdrawalAmount(value: unknown) {
    this.withdrawalAmount.set(this.toSafeNumber(value));
  }

  setWithdrawalAmountInput(value: unknown) {
    const raw = String(value || "");
    const normalized = this.normalizeCurrencyInput(raw);
    this.withdrawalAmount.set(normalized.amount);
    this.withdrawalAmountInput.set(normalized.formatted);
  }

  setWithdrawalDate(value: unknown) {
    this.withdrawalDate.set(this.normalizeDateInput(value, this.offsetDate(0)));
  }

  setWithdrawalPurpose(value: unknown) {
    const raw = String(value || "").trim();
    if (
      raw === "socio_blanca" ||
      raw === "socio_andrea_pepe" ||
      raw === "persona" ||
      raw === "sueldo" ||
      raw === "gasto" ||
      raw === "inversion" ||
      raw === "ahorro" ||
      raw === "otro"
    ) {
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
    const editingId = this.withdrawalEditingId();
    const isEditing = Boolean(editingId);
    if (isEditing && !this.canEditMovements()) return;
    if (!isEditing && !this.canCreateMovements()) return;
    if (this.withdrawalAmount() <= 0) {
      this.error.set("El monto del retiro debe ser mayor a 0.");
      return;
    }

    const available = this.withdrawalAvailableForForm();
    if (this.withdrawalAmount() > available + 0.001) {
      this.error.set(`No hay saldo suficiente para retirar ${this.formatCurrency(this.withdrawalAmount())}. Disponible: ${this.formatCurrency(available)}.`);
      return;
    }

    const selectedPartner = this.withdrawalSelectedPartner();
    if (selectedPartner) {
      const availableForPartner = this.withdrawalAvailableForSelectedPartner();
      if (this.withdrawalAmount() > availableForPartner + 0.001) {
        const partnerLabel = this.withdrawalPurposeLabel(this.withdrawalPurpose());
        this.error.set(`Ese retiro excede la parte de ${partnerLabel}. Maximo permitido ahora: ${this.formatCurrency(availableForPartner)}.`);
        return;
      }
    }

    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveWithdrawal({
        withdrawal_id: editingId || undefined,
        amount: this.withdrawalAmount(),
        occurred_at: this.withdrawalDate(),
        purpose: this.withdrawalPurpose(),
        recipient: this.withdrawalRecipient().trim() || null,
        route_id: this.withdrawalRouteId() === "general" ? null : this.withdrawalRouteId(),
        account_id: this.withdrawalAccountId() === "none" ? null : this.withdrawalAccountId(),
        notes: this.withdrawalNotes().trim() || null,
      });
      this.resetWithdrawalForm();
      this.success.set(isEditing ? "Retiro actualizado." : "Retiro registrado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar el retiro.";
      this.error.set(message);
    }
  }

  async deleteWithdrawal(row: FinanceWithdrawal) {
    if (!this.canDeleteMovements()) return;
    const ok = confirm(`Eliminar retiro de ${this.formatCurrency(row.amount)}?`);
    if (!ok) return;
    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.deleteWithdrawal(row.withdrawal_id);
      if (this.withdrawalEditingId() === row.withdrawal_id) this.resetWithdrawalForm();
      this.success.set("Retiro eliminado.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo eliminar el retiro.";
      this.error.set(message);
    }
  }

  openBucketById(bucketId: MoneyBucketId) {
    const target = this.summary().buckets.find((row) => row.id === bucketId);
    if (!target) return;
    this.openBucketDrilldown(target);
  }

  openBucketDrilldown(bucket: MoneyBucket) {
    this.resetDrilldownTableState();
    const rows = this.buildDrilldownRowsFromBucket(bucket);
    this.drilldown.set({
      id: `bucket:${bucket.id}`,
      title: bucket.title,
      subtitle: `${bucket.description} | ${bucket.count} ${bucket.id === "stagnantInventory" ? "SKUs" : "pedidos"}`,
      totalAmountClienta: this.toSafeNumber(bucket.amountClienta),
      totalCost: this.toSafeNumber(bucket.cost),
      totalMargin: this.toSafeNumber(bucket.margin),
      totalPaid: this.toSafeNumber(bucket.paid),
      totalBalance: this.toSafeNumber(bucket.balance),
      rows,
    });
  }

  openRouteDrilldown(row: SummaryRow) {
    this.resetDrilldownTableState();
    const rows: DrilldownRow[] = row.detailRows
      .map((entry) => ({
        rowId: `route:${row.routeId}:${entry.orderId}`,
        type: "order" as const,
        primary: this.customerName(entry.customerId),
        secondary: this.routeName(entry.routeId),
        status: this.statusLabel(entry.status),
        createdAt: entry.createdAt,
        amountClienta: this.toSafeNumber(entry.amountClienta),
        cost: this.toSafeNumber(entry.cost),
        margin: this.toSafeNumber(entry.margin),
        paid: this.toSafeNumber(entry.paid),
        balance: this.toSafeNumber(entry.balance),
        orderId: entry.orderId,
      }))
      .sort((a, b) => b.amountClienta - a.amountClienta);

    const totalAmountClienta = rows.reduce((sum, item) => sum + item.amountClienta, 0);
    const totalCost = rows.reduce((sum, item) => sum + item.cost, 0);
    const totalMargin = rows.reduce((sum, item) => sum + item.margin, 0);
    const totalPaid = rows.reduce((sum, item) => sum + item.paid, 0);
    const totalBalance = rows.reduce((sum, item) => sum + item.balance, 0);

    this.drilldown.set({
      id: `route:${row.routeId}`,
      title: `Ruta ${row.routeName}`,
      subtitle: `${row.ordersCount} pedidos | ${row.customerPreview}`,
      totalAmountClienta,
      totalCost,
      totalMargin,
      totalPaid,
      totalBalance,
      rows,
    });
  }

  closeDrilldown() {
    this.drilldown.set(null);
  }

  goToWithdrawalBreakdownPage() {
    this.router.navigate(["/main/administracion/retiro-ganancias"], {
      queryParams: {
        scope: this.routeScope(),
      },
    });
  }

  setDrilldownFilter(column: DrilldownFilterColumn, value: unknown) {
    const nextValue = String(value || "");
    this.drilldownFilters.update((current) => ({
      ...current,
      [column]: nextValue,
    }));
  }

  setDrilldownDateStart(value: unknown) {
    const next = this.normalizeDateInput(value, "");
    this.drilldownDateRange.update((current) => ({
      ...current,
      start: next,
    }));
  }

  setDrilldownDateEnd(value: unknown) {
    const next = this.normalizeDateInput(value, "");
    this.drilldownDateRange.update((current) => ({
      ...current,
      end: next,
    }));
  }

  clearDrilldownFilters() {
    this.drilldownFilters.set(this.createEmptyDrilldownFilters());
    this.drilldownDateRange.set({
      start: "",
      end: "",
    });
  }

  toggleDrilldownSort(column: DrilldownColumn) {
    this.drilldownSort.update((current) => {
      if (current.column === column) {
        return {
          column,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }
      return {
        column,
        direction: DRILLDOWN_COLUMN_DEFAULT_DIRECTION[column],
      };
    });
  }

  drilldownSortArrow(column: DrilldownColumn): string {
    const current = this.drilldownSort();
    if (current.column !== column) return "\u2195";
    return current.direction === "asc" ? "\u2191" : "\u2193";
  }

  openOrder(orderId: string) {
    const active = this.drilldown();
    const state = {
      from: "administracion",
      scope: this.routeScope(),
      drilldown: active?.id || null,
    };
    this.closeDrilldown();
    this.router.navigate(["/main/pedidos", orderId], { state });
  }

  expenseCategoryLabel(key: FinanceExpenseCategory): string {
    return EXPENSE_CATEGORY_LABEL[key];
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

  accountLabel(accountId: string | null): string {
    if (!accountId) return "-";
    return this.accounts().find((row) => row.account_id === accountId)?.name || accountId;
  }

  customerName(customerId: string): string {
    const row = this.customersService.getById(customerId);
    if (!row) return "Clienta sin nombre";
    return [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Clienta sin nombre";
  }

  routeName(routeId: string | null): string {
    const normalized = this.normalizeRouteId(routeId);
    if (normalized === "sin_ruta") return "Sin ruta";
    return this.routes().find((row) => row.route_id === normalized)?.name || normalized;
  }

  statusLabel(status: OrderStatus): string {
    return STATUS_LABELS[status] || status;
  }

  bucketTitle(bucketId: MoneyBucketId): string {
    return MONEY_BUCKET_META[bucketId].title;
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
  trackWithdrawal = (_: number, row: FinanceWithdrawal) => row.withdrawal_id;
  trackCut = (_: number, row: { cut_id: string }) => row.cut_id;
  trackScope = (_: number, row: { id: string }) => row.id;
  trackBucket = (_: number, row: MoneyBucket) => row.id;
  trackDrilldownRow = (_: number, row: DrilldownRow) => row.rowId;

  private resolveWithdrawalPartner(row: FinanceWithdrawal): PartnerWithdrawalPurpose | null {
    if (row.purpose === "socio_blanca") return "socio_blanca";
    if (row.purpose === "socio_andrea_pepe") return "socio_andrea_pepe";
    const hint = this.normalizeText(`${row.recipient || ""} ${row.notes || ""}`);
    if (hint.includes("blanca")) return "socio_blanca";
    if (hint.includes("andrea") || hint.includes("pepe")) return "socio_andrea_pepe";
    return null;
  }

  private asPartnerPurpose(value: FinanceWithdrawalPurpose | null | undefined): PartnerWithdrawalPurpose | null {
    if (value === "socio_blanca") return "socio_blanca";
    if (value === "socio_andrea_pepe") return "socio_andrea_pepe";
    return null;
  }

  private restoreReturnContextFromQuery() {
    const scope = String(this.route.snapshot.queryParamMap.get("scope") || "").trim();
    if (scope) {
      this.routeScope.set(scope);
    }
    const drilldown = String(this.route.snapshot.queryParamMap.get("drilldown") || "").trim();
    if (drilldown) {
      this.pendingDrilldownRestore.set(drilldown);
    }
  }

  private tryRestoreDrilldown(token: string) {
    if (token.startsWith("bucket:")) {
      const bucketId = token.slice("bucket:".length) as MoneyBucketId;
      const bucket = this.summary().buckets.find((row) => row.id === bucketId);
      if (bucket) this.openBucketDrilldown(bucket);
      return;
    }
    if (token.startsWith("route:")) {
      const routeId = token.slice("route:".length);
      const route = this.routeRows().find((row) => row.routeId === routeId);
      if (route) this.openRouteDrilldown(route);
    }
  }

  private buildRouteRows(rows: BucketOrderRow[]): SummaryRow[] {
    const selectedRouteId = this.selectedRouteId();
    const map = new Map<string, SummaryRow>();

    for (const entry of rows) {
      const routeId = entry.routeId;
      if (selectedRouteId && routeId !== selectedRouteId) continue;
      if (!map.has(routeId)) {
        map.set(routeId, {
          routeId,
          routeName: this.routeName(routeId),
          ordersCount: 0,
          porCobrarReal: 0,
          pipelineClienta: 0,
          capitalRequerido: 0,
          cobradoConRepartidor: 0,
          gananciaPendiente: 0,
          customerPreview: "Sin clientas",
          detailRows: [],
        });
      }
      const target = map.get(routeId);
      if (!target) continue;
      target.ordersCount += 1;
      target.detailRows.push(entry);

      if (entry.bucketId === "deliveredPendingCollection") {
        target.porCobrarReal += entry.amountClienta;
        target.gananciaPendiente += entry.margin;
      }

      if (entry.bucketId === "confirmedNeedInvestment" || entry.bucketId === "investedNotDelivered") {
        target.pipelineClienta += entry.amountClienta;
        target.gananciaPendiente += entry.margin;
      }

      if (entry.bucketId === "confirmedNeedInvestment") {
        target.capitalRequerido += entry.cost;
      }

      if (entry.bucketId === "collectedByCourierPendingSettlement") {
        target.cobradoConRepartidor += entry.amountClienta;
      }
    }

    const out = Array.from(map.values())
      .map((row) => ({
        ...row,
        customerPreview: this.buildCustomerPreview(row.detailRows),
        porCobrarReal: this.toSafeNumber(row.porCobrarReal),
        pipelineClienta: this.toSafeNumber(row.pipelineClienta),
        capitalRequerido: this.toSafeNumber(row.capitalRequerido),
        cobradoConRepartidor: this.toSafeNumber(row.cobradoConRepartidor),
        gananciaPendiente: this.toSafeNumber(row.gananciaPendiente),
      }))
      .filter((row) => row.ordersCount > 0)
      .sort((a, b) => b.pipelineClienta + b.porCobrarReal - (a.pipelineClienta + a.porCobrarReal));

    return out;
  }

  private buildCustomerPreview(rows: BucketOrderRow[]): string {
    if (rows.length === 0) return "Sin clientas";
    const map = new Map<string, number>();
    for (const row of rows) {
      const name = this.customerName(row.customerId);
      map.set(name, (map.get(name) || 0) + 1);
    }
    const ordered = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    return ordered
      .slice(0, 3)
      .map(([name]) => name)
      .join(", ");
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
    const expensesTotal = input.expenses.reduce((sum, row) => sum + Math.max(0, this.toSafeNumber(row.amount)), 0);
    const withdrawalProfit = calculateWithdrawalProfit(input.orders, expensesTotal);
    const { avgCostUnit, avgSaleUnit, markupMultiplier } = this.estimateMargins(input.orders);
    const bucketMap = this.createBucketMap();
    const orderBucketRows: BucketOrderRow[] = [];

    let ventasBrutas = 0;
    let descuentos = 0;
    let ingresosCobrados = 0;
    let utilidadBruta = 0;
    let potencialBorradores = 0;
    let perdidoStock = 0;
    let perdidoDano = 0;
    let devolucionesMonto = 0;
    let baseVentasDevolucion = 0;
    let unidadesBrutas = 0;
    let unidadesDevueltas = 0;
    let pedidosBorrador = 0;
    let recentSales = 0;
    let costOfDelivered = 0;

    for (const order of input.orders) {
      const snapshot = this.toOrderSnapshot(order);
      const status = snapshot.status;
      const isCancelled = CANCELLED_STATUSES.has(status);
      const isDelivered = DELIVERED_STATUSES.has(status) || Boolean(order.delivered_at);
      const financials = calculateOrderFinancials(order);

      if (!isCancelled) {
        perdidoDano += financials.items.reduce((sum, item) => sum + item.damagedReturnedQty * item.unitCost, 0);
      }

      if (isDelivered) {
        ventasBrutas += snapshot.grossSales;
        devolucionesMonto += snapshot.returnsAmount;
        descuentos += financials.remainingDiscount;
        unidadesBrutas += financials.recognizedUnits;
        unidadesDevueltas += financials.returnedUnits;
      }

      if (isDelivered) {
        ingresosCobrados += snapshot.paid > 0 ? snapshot.paid : snapshot.balance <= 0 ? snapshot.totalClienta : 0;
        utilidadBruta += snapshot.grossProfit;
        baseVentasDevolucion += snapshot.grossSales;
        costOfDelivered += snapshot.cost;
        if (this.isDateWithinWindow(order.updated_at, input.averageWindowDays)) {
          recentSales += snapshot.totalClienta;
        }
      }

      if (status === "borrador") {
        pedidosBorrador += 1;
        potencialBorradores += snapshot.remaining > 0 ? snapshot.remaining : snapshot.totalClienta;
      }

      const bucketId = this.classifyBucket(snapshot);
      if (bucketId) {
        const allocation = this.allocateBucket(snapshot, bucketId);
        const row: BucketOrderRow = {
          bucketId,
          orderId: order.order_id,
          routeId: snapshot.routeId,
          customerId: snapshot.customerId,
          status: snapshot.status,
          createdAt: this.toIsoDate(order.created_at),
          amountClienta: allocation.amountClienta,
          cost: allocation.cost,
          margin: allocation.margin,
          paid: allocation.paid,
          balance: allocation.balance,
          note: allocation.note,
        };
        this.pushOrderRowToBucket(bucketMap.get(bucketId), row);
        orderBucketRows.push(row);
      }

      for (const item of order.items || []) {
        const rowValue = this.resolveItemSaleValue(item);
        if (rowValue <= 0) continue;
        const stockLoss = item.confirmation_state === "out_of_stock" || item.late_addition_status === "missing";
        const damageLoss = item.late_addition_status === "damaged";
        if (damageLoss) perdidoDano += rowValue;
        else if (stockLoss) perdidoStock += rowValue;
      }
    }

    const egresos = expensesTotal;
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
      const potentialMargin = Math.max(0, potential - value);

      estancadoPiezas += qty;
      estancadoCosto += value;
      estancadoPotencial += potential;
      estancadoGanancia += potentialMargin;

      this.pushInventoryRowToBucket(bucketMap.get("stagnantInventory"), {
        bucketId: "stagnantInventory",
        inventoryId: (row as { inventory_id?: string }).inventory_id || (row as { sku?: string }).sku || `inv-${row.title}`,
        title: row.title || "Producto sin nombre",
        quantity: qty,
        idleDays,
        cost: value,
        potentialSale: potential,
        potentialMargin,
      });
    }

    const buckets = MONEY_BUCKET_ORDER.map((id) => bucketMap.get(id)!).map((row) => ({
      ...row,
      amountClienta: this.toSafeNumber(row.amountClienta),
      cost: this.toSafeNumber(row.cost),
      margin: this.toSafeNumber(row.margin),
      paid: this.toSafeNumber(row.paid),
      balance: this.toSafeNumber(row.balance),
    }));

    const confirmedNeedInvestment = bucketMap.get("confirmedNeedInvestment")!;
    const investedNotDelivered = bucketMap.get("investedNotDelivered")!;
    const deliveredPendingCollection = bucketMap.get("deliveredPendingCollection")!;
    const collectedShouldBeInAccount = bucketMap.get("collectedShouldBeInAccount")!;
    const collectedByCourierPendingSettlement = bucketMap.get("collectedByCourierPendingSettlement")!;

    const pipelineClienta = confirmedNeedInvestment.amountClienta + investedNotDelivered.amountClienta;
    const capitalPorInvertir = confirmedNeedInvestment.cost;
    const mercanciaTransito = investedNotDelivered.cost;
    const porCobrar = deliveredPendingCollection.amountClienta;
    const cobradoConRepartidor = collectedByCourierPendingSettlement.amountClienta;
    const cobradoPorDepositar = collectedShouldBeInAccount.amountClienta;
    const gananciaPendientePipeline = confirmedNeedInvestment.margin + investedNotDelivered.margin + deliveredPendingCollection.margin;
    const potencialPendiente = gananciaPendientePipeline;
    const pedidosPendientes = confirmedNeedInvestment.count + investedNotDelivered.count;
    const pendientesCobro = deliveredPendingCollection.count;

    const proyeccionCaja =
      cajaActual +
      porCobrar +
      cobradoPorDepositar +
      (promedioVentaDiaria - promedioEgresoDiario) * Math.max(1, input.projectionDays);

    const devolucionRate = baseVentasDevolucion > 0 ? devolucionesMonto / baseVentasDevolucion : 0;
    const devolucionUnidadesRate = unidadesBrutas > 0 ? unidadesDevueltas / unidadesBrutas : 0;
    const ventasNetas = ventasBrutas - descuentos - devolucionesMonto;
    const devolucionImpacto = devolucionesMonto + perdidasRegistradas;
    const dsoDias = recentSales > 0 ? (porCobrar / recentSales) * averageWindowDays : 0;
    const inventoryTurnover = inventarioCosto > 0 ? costOfDelivered / inventarioCosto : 0;
    const inventoryDays = inventoryTurnover > 0 ? 365 / inventoryTurnover : 0;

    return {
      ventasBrutas,
      descuentos,
      ventasNetas,
      ingresosCobrados,
      egresos,
      utilidadBruta,
      utilidadNeta,
      utilidadCobradaBase: withdrawalProfit.collectedProfitBase,
      gananciaPendienteCobro: withdrawalProfit.pendingProfit,
      saldoPendienteCobro: withdrawalProfit.pendingCollection,
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
      devolucionUnidadesRate,
      devolucionImpacto,
      pedidosPendientes,
      pedidosBorrador,
      pendientesCobro,
      pipelineClienta,
      capitalPorInvertir,
      cobradoConRepartidor,
      cobradoPorDepositar,
      gananciaPendientePipeline,
      buckets,
      orderBucketRows,
    };
  }

  private createBucketMap(): Map<MoneyBucketId, MoneyBucket> {
    const map = new Map<MoneyBucketId, MoneyBucket>();
    for (const id of MONEY_BUCKET_ORDER) {
      const meta = MONEY_BUCKET_META[id];
      map.set(id, {
        id,
        title: meta.title,
        description: meta.description,
        count: 0,
        amountClienta: 0,
        cost: 0,
        margin: 0,
        paid: 0,
        balance: 0,
        orderRows: [],
        inventoryRows: [],
      });
    }
    return map;
  }

  private pushOrderRowToBucket(bucket: MoneyBucket | undefined, row: BucketOrderRow) {
    if (!bucket) return;
    bucket.count += 1;
    bucket.amountClienta += row.amountClienta;
    bucket.cost += row.cost;
    bucket.margin += row.margin;
    bucket.paid += row.paid;
    bucket.balance += row.balance;
    bucket.orderRows.push(row);
  }

  private pushInventoryRowToBucket(bucket: MoneyBucket | undefined, row: BucketInventoryRow) {
    if (!bucket) return;
    bucket.count += 1;
    bucket.amountClienta += row.potentialSale;
    bucket.cost += row.cost;
    bucket.margin += row.potentialMargin;
    bucket.balance += row.potentialSale;
    bucket.inventoryRows.push(row);
  }

  private buildDrilldownRowsFromBucket(bucket: MoneyBucket): DrilldownRow[] {
    const orderRows: DrilldownRow[] = bucket.orderRows.map((row) => ({
      rowId: `order:${row.orderId}`,
      type: "order",
      primary: this.customerName(row.customerId),
      secondary: this.routeName(row.routeId),
      status: this.statusLabel(row.status),
      createdAt: row.createdAt,
      amountClienta: this.toSafeNumber(row.amountClienta),
      cost: this.toSafeNumber(row.cost),
      margin: this.toSafeNumber(row.margin),
      paid: this.toSafeNumber(row.paid),
      balance: this.toSafeNumber(row.balance),
      orderId: row.orderId,
    }));

    const inventoryRows: DrilldownRow[] = bucket.inventoryRows.map((row) => ({
      rowId: `inventory:${row.inventoryId}`,
      type: "inventory",
      primary: row.title,
      secondary: `${row.quantity} pzas | ${row.idleDays} dias sin salida`,
      status: "Inventario estancado",
      createdAt: null,
      amountClienta: this.toSafeNumber(row.potentialSale),
      cost: this.toSafeNumber(row.cost),
      margin: this.toSafeNumber(row.potentialMargin),
      paid: 0,
      balance: this.toSafeNumber(row.potentialSale),
      orderId: null,
    }));

    return [...orderRows, ...inventoryRows].sort((a, b) => b.amountClienta - a.amountClienta);
  }

  private classifyBucket(snapshot: OrderFinancialSnapshot): MoneyBucketId | null {
    if (CANCELLED_STATUSES.has(snapshot.status) || RETURNED_STATUSES.has(snapshot.status)) return null;

    if (DELIVERED_STATUSES.has(snapshot.status) && snapshot.balance > 0) {
      return "deliveredPendingCollection";
    }

    if (COURIER_COLLECTION_STATUSES.has(snapshot.status) && snapshot.paid > 0) {
      return "collectedByCourierPendingSettlement";
    }

    if (DELIVERED_STATUSES.has(snapshot.status) && snapshot.paid > 0 && snapshot.balance <= 0) {
      return "collectedShouldBeInAccount";
    }

    if (snapshot.status === "borrador") {
      return "openDrafts";
    }

    if (NEED_INVEST_STATUSES.has(snapshot.status)) {
      return "confirmedNeedInvestment";
    }

    if (INVESTED_NOT_DELIVERED_STATUSES.has(snapshot.status)) {
      return "investedNotDelivered";
    }

    if (snapshot.balance > 0) {
      return "deliveredPendingCollection";
    }

    if (snapshot.paid > 0) {
      return "collectedShouldBeInAccount";
    }

    if (snapshot.remaining > 0) {
      return "confirmedNeedInvestment";
    }

    return null;
  }

  private allocateBucket(snapshot: OrderFinancialSnapshot, bucketId: MoneyBucketId): {
    amountClienta: number;
    cost: number;
    margin: number;
    paid: number;
    balance: number;
    note: string;
  } {
    if (bucketId === "deliveredPendingCollection") {
      const ratio = snapshot.remainingRatio;
      return {
        amountClienta: snapshot.balance,
        cost: snapshot.cost * ratio,
        margin: snapshot.grossProfit * ratio,
        paid: snapshot.paid,
        balance: snapshot.balance,
        note: "Entregado, pendiente cobrar",
      };
    }

    if (bucketId === "collectedShouldBeInAccount") {
      const ratio = snapshot.paidRatio;
      return {
        amountClienta: snapshot.paid,
        cost: snapshot.cost * ratio,
        margin: snapshot.grossProfit * ratio,
        paid: snapshot.paid,
        balance: 0,
        note: "Cobrado, conciliar en cuenta",
      };
    }

    if (bucketId === "collectedByCourierPendingSettlement") {
      const ratio = snapshot.paidRatio;
      return {
        amountClienta: snapshot.paid,
        cost: snapshot.cost * ratio,
        margin: snapshot.grossProfit * ratio,
        paid: snapshot.paid,
        balance: 0,
        note: "Cobrado por repartidor",
      };
    }

    const ratio = snapshot.remainingRatio > 0 ? snapshot.remainingRatio : 1;
    return {
      amountClienta: snapshot.remaining > 0 ? snapshot.remaining : snapshot.totalClienta,
      cost: snapshot.cost * ratio,
      margin: snapshot.grossProfit * ratio,
      paid: snapshot.paid,
      balance: snapshot.remaining,
      note:
        bucketId === "openDrafts"
          ? "Apertura sin solicitud"
          : bucketId === "confirmedNeedInvestment"
            ? "Por solicitar/pagar proveedor"
            : "Invertido, pendiente entrega",
    };
  }

  private toOrderSnapshot(order: Order): OrderFinancialSnapshot {
    const financials = calculateOrderFinancials(order);
    const totalClienta = financials.netAmount;
    const cost = financials.netCost;
    const grossProfit = financials.grossProfit;

    const paidRaw = Math.max(0, this.toSafeNumber(order.totals?.paid_amount));
    const paid = Math.min(totalClienta, paidRaw);
    const inferredBalance = Math.max(0, totalClienta - paid);
    const reportedBalance = Math.max(0, this.toSafeNumber(order.totals?.balance_due));
    const balance = Math.min(totalClienta, Math.max(inferredBalance, reportedBalance));

    const paidRatio = totalClienta > 0 ? Math.min(1, paid / totalClienta) : 0;
    const remainingRatio = totalClienta > 0 ? Math.min(1, balance / totalClienta) : 0;

    return {
      order,
      status: order.status,
      routeId: this.normalizeRouteId(order.route_id),
      customerId: String(order.customer_id || ""),
      totalClienta,
      cost,
      grossProfit,
      grossSales: financials.grossClient,
      returnsAmount: financials.returnsAmount,
      paid,
      balance,
      remaining: balance,
      paidRatio,
      remainingRatio,
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

  private matchesRoute(orderRouteId: string | null, selectedRouteId: string | null): boolean {
    if (!selectedRouteId) return true;
    return this.normalizeRouteId(orderRouteId) === selectedRouteId;
  }

  private normalizeRouteId(routeId: string | null): string {
    const raw = String(routeId || "sin_ruta").trim();
    return raw || "sin_ruta";
  }

  private resolveOrderTotal(order: Order): number {
    return calculateOrderFinancials(order).netAmount;
  }

  private estimateOrderValue(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.resolveItemSaleValue(item), 0);
  }

  private resolveOrderCost(order: Order): number {
    return calculateOrderFinancials(order).netCost;
  }

  private resolveItemQty(item: OrderItem): number {
    return calculateItemFinancials(item).netQty;
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
    const hasAvailable = item.available_qty !== null && item.available_qty !== undefined;
    if (hasAvailable) {
      return Math.max(0, Math.trunc(this.toSafeNumber(item.available_qty)));
    }

    const hasOnHand = item.on_hand_qty !== null && item.on_hand_qty !== undefined;
    if (!hasOnHand) {
      // Legacy docs may only have quantity_on_hand as already-available stock.
      return Math.max(0, Math.trunc(this.toSafeNumber(item.quantity_on_hand)));
    }

    const onHand = this.toSafeNumber(item.on_hand_qty);
    const reservedDirect = this.toSafeNumber(item.reserved_qty ?? 0);
    const reservedFromMap = Object.values(item.reservations || {}).reduce((sum, row) => {
      if (!row || row.status !== "reserved") return sum;
      return sum + this.toSafeNumber(row.qty);
    }, 0);
    const reserved = Math.max(reservedDirect, reservedFromMap);

    return Math.max(0, Math.trunc(onHand - reserved));
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

  private formatCurrencyInput(value: number): string {
    const safe = this.toSafeNumber(value);
    if (safe <= 0) return "";
    const [whole, decimals] = safe.toFixed(2).split(".");
    const wholeFormatted = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(whole));
    return `${wholeFormatted}.${decimals}`;
  }

  private normalizeCurrencyInput(value: string): { amount: number; formatted: string } {
    const cleaned = String(value || "")
      .replace(/[^0-9.,]/g, "")
      .replace(/,/g, "");
    if (!cleaned) {
      return { amount: 0, formatted: "" };
    }

    const hasTrailingDot = cleaned.endsWith(".");
    const parts = cleaned.split(".");
    const wholeDigitsRaw = parts.shift() || "";
    const decimalDigits = parts.join("").slice(0, 2);
    const wholeDigits = wholeDigitsRaw.replace(/^0+(?=\d)/, "") || "0";
    const wholeValue = Number(wholeDigits);
    const wholeFormatted = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(wholeValue);

    let formatted = wholeFormatted;
    if (hasTrailingDot) {
      formatted += ".";
    } else if (decimalDigits) {
      formatted += `.${decimalDigits}`;
    }

    const canonical = `${wholeValue}.${decimalDigits || "0"}`;
    const amount = this.toSafeNumber(Number(canonical));
    return { amount, formatted };
  }

  private createEmptyDrilldownFilters(): DrilldownFilterState {
    return {
      primary: "",
      status: "",
      amountClienta: "",
      cost: "",
      margin: "",
      paid: "",
    };
  }

  private resetDrilldownTableState() {
    this.drilldownSort.set({ ...DRILLDOWN_DEFAULT_SORT });
    this.drilldownFilters.set(this.createEmptyDrilldownFilters());
    this.drilldownDateRange.set({
      start: "",
      end: "",
    });
  }

  private matchesDrilldownFilters(row: DrilldownRow, filters: DrilldownFilterState, dateRange: DrilldownDateRange): boolean {
    if (!this.textMatches(`${row.primary} ${row.secondary}`, filters.primary)) return false;
    if (!this.textMatches(row.status, filters.status)) return false;
    if (!this.matchesDateRange(row.createdAt, dateRange)) return false;
    if (!this.matchesNumericFilter(row.amountClienta, filters.amountClienta)) return false;
    if (!this.matchesNumericFilter(row.cost, filters.cost)) return false;
    if (!this.matchesNumericFilter(row.margin, filters.margin)) return false;
    if (!this.matchesNumericFilter(row.paid, filters.paid)) return false;
    return true;
  }

  private matchesDateRange(value: string | null, range: DrilldownDateRange): boolean {
    const start = this.normalizeDateInput(range.start, "");
    const end = this.normalizeDateInput(range.end, "");
    if (!start && !end) return true;

    const dateKey = this.toLocalDateKey(value);
    if (!dateKey) return false;

    if (start && end) {
      const min = start <= end ? start : end;
      const max = start <= end ? end : start;
      return dateKey >= min && dateKey <= max;
    }
    if (start) return dateKey >= start;
    return dateKey <= end;
  }

  private textMatches(value: unknown, filterRaw: string): boolean {
    const filter = this.normalizeText(filterRaw);
    if (!filter) return true;
    return this.normalizeText(value).includes(filter);
  }

  private matchesNumericFilter(value: number, filterRaw: string): boolean {
    const filter = String(filterRaw || "").trim();
    if (!filter) return true;
    const normalized = filter.replace(/\s+/g, "").replace(/\$/g, "").replace(/,/g, "");
    const baseValue = this.toSafeNumber(value);

    const operatorMatch = normalized.match(/^(<=|>=|=|<|>)(-?\d+(?:\.\d+)?)$/);
    if (operatorMatch) {
      const numeric = Number(operatorMatch[2]);
      if (!Number.isFinite(numeric)) return false;
      if (operatorMatch[1] === "<") return baseValue < numeric;
      if (operatorMatch[1] === "<=") return baseValue <= numeric;
      if (operatorMatch[1] === ">") return baseValue > numeric;
      if (operatorMatch[1] === ">=") return baseValue >= numeric;
      return baseValue === numeric;
    }

    const dottedRange = normalized.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
    const dashedRange = normalized.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/);
    const rangeMatch = dottedRange || dashedRange;
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      return baseValue >= min && baseValue <= max;
    }

    const valueAsRaw = String(baseValue);
    const valueAsCurrencyDigits = this.formatCurrency(baseValue).replace(/[^\d.-]/g, "");
    return valueAsRaw.includes(normalized) || valueAsCurrencyDigits.includes(normalized);
  }

  private compareDrilldownRows(a: DrilldownRow, b: DrilldownRow, sort: DrilldownSortState): number {
    let result = 0;
    if (sort.column === "primary") {
      result = this.compareText(a.primary, b.primary) || this.compareText(a.secondary, b.secondary);
    } else if (sort.column === "status") {
      result = this.compareText(a.status, b.status);
    } else if (sort.column === "createdAt") {
      result = this.toDateStamp(a.createdAt) - this.toDateStamp(b.createdAt);
    } else if (sort.column === "amountClienta") {
      result = a.amountClienta - b.amountClienta;
    } else if (sort.column === "cost") {
      result = a.cost - b.cost;
    } else if (sort.column === "margin") {
      result = a.margin - b.margin;
    } else if (sort.column === "paid") {
      result = a.paid - b.paid;
    }
    if (result === 0) {
      result = this.compareText(a.primary, b.primary);
    }
    return sort.direction === "asc" ? result : -result;
  }

  private compareText(a: unknown, b: unknown): number {
    return this.normalizeText(a).localeCompare(this.normalizeText(b), "es-MX");
  }

  private normalizeText(value: unknown): string {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  private toDateStamp(value: unknown): number {
    const date = this.toDate(value);
    return date ? date.getTime() : 0;
  }

  private toLocalDateKey(value: unknown): string | null {
    const date = this.toDate(value);
    if (!date) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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

