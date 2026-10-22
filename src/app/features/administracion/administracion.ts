
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal, viewChild } from "@angular/core";
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
  isOperatingExpense,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_CATEGORY_HINT,
  EXPENSE_CATEGORY_ORDER,
} from "../../core/finance.service";
import { InventoryItem, InventoryMovement, InventoryService } from "../../core/inventory.service";
import { Order, OrderCollectionEvent, OrderItem, OrderStatus, OrdersService } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { ReturnRecord, ReturnsService } from "../../core/returns.service";
import { BusinessScopeService } from "../../core/business-scope.service";
import { BusinessId } from "../../core/rbac.constants";
import { calculateOrderFinancials, calculateItemFinancials } from "../../core/order-financials";
import { calculateOrderProfitProjection } from "../../core/order-profit-projection";
import { calculatePartnerWithdrawalSummary, calculateWithdrawalProfit } from "../../core/withdrawal-profit";
import { BusinessPosition, calculateBusinessPosition } from "../../core/business-position";
import { calculateAccountingPeriodOutcome, originalOrderFinancials } from "../../core/accounting-period";
import { buildProfitAudit } from "../../core/profit-audit";
import { ProfitAuditComponent } from "./profit-audit.component";

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
  capitalPendienteCobro: number;
  saldoPendienteCobro: number;
  costoEntregado: number;
  dsoDias: number;
  cajaActual: number;
  porCobrar: number;
  mercanciaTransito: number;
  inventarioCosto: number;
  inventarioReservado: number;
  inventarioRecuperable: number;
  inventarioCostoImputado: number;
  inventarioPiezasSinCosto: number;
  position: BusinessPosition;
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

type AdministrationView = "resumen" | "mensual" | "inventario" | "socios";
type PartnerViewScope = "general" | "mensual";

type MonthlyFinanceSnapshot = {
  id: string;
  label: string;
  shortLabel: string;
  start: Date;
  end: Date;
  investment: number;
  generatedSales: number;
  cohortCurrentSales: number;
  cohortReturnsToDate: number;
  generatedOrderCount: number;
  netSales: number;
  salesBeforeReturns: number;
  deliveredSales: number;
  deliveredCost: number;
  returnedInventoryCost: number;
  damagedWriteOff: number;
  cashRefunds: number;
  netCashCollections: number;
  periodStatus: "open" | "in_review" | "closed" | "reopened";
  collected: number;
  merchandiseCost: number;
  expenses: number;
  returnsImpact: number;
  distributionAdjustments: number;
  netProfit: number;
  collectedProfit: number;
  inProcessProfit: number;
  pendingCollectionProfit: number;
  projectedProfit: number;
  inProcessOrderCount: number;
  pendingCollectionOrderCount: number;
  cohortCollectedToDate: number;
  cohortPendingToday: number;
  cohortProfit: number;
  cohortCollectedProfit: number;
  cohortPendingProfit: number;
  cohortCollectedAfterPeriod: number;
  collectedFromCurrentPeriod: number;
  collectedFromPriorPeriods: number;
  receivablesOpening: number;
  receivablesClosing: number;
  distributableProfit: number;
  overdue: number;
  dso: number;
  partnerOneWithdrawn: number;
  partnerTwoWithdrawn: number;
  inventoryOpening: number;
  inventoryReceipts: number;
  returnedToInventory: number;
  inventoryReleased: number;
  inventoryRecovered: number;
  inventoryWriteOff: number;
  inventoryClosing: number;
  stagnantCapital: number;
};

type ReturnCapitalRow = {
  id: string;
  product: string;
  capitalReturned: number;
  capitalResold: number;
  daysToRotate: number | null;
  status: "Liberado" | "Parcial" | "Estancado" | "En seguimiento";
};

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

const DELIVERED_STATUSES = new Set<OrderStatus>(["entregado", "entregado_parcial", "pago_pendiente", "pagado_parcial", "pagado", "closed"]);
const RETURNED_STATUSES = new Set<OrderStatus>(["devuelto"]);
const CANCELLED_STATUSES = new Set<OrderStatus>(["cancelado"]);
const NEED_INVEST_STATUSES = new Set<OrderStatus>(["confirmando_proveedor", "reservado_inventario", "solicitado_proveedor", "supplier_processing"]);
const INVESTED_NOT_DELIVERED_STATUSES = new Set<OrderStatus>([
  
  "en_transito",
  "recibido_qa",
  
  "empaque",
  "ready_for_route",
  "assigned_to_run",
  
  "en_ruta",
]);
const COURIER_COLLECTION_STATUSES = new Set<OrderStatus>(["en_ruta", "assigned_to_run"]);

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
  imports: [FormsModule, ProfitAuditComponent],
  templateUrl: "./administracion.html",
  styleUrls: ["./administracion-redesign-prototype.component.css", "./administracion.css"],
})
export default class AdministracionPage {
  private ordersService = inject(OrdersService);
  private inventoryService = inject(InventoryService);
  private returnsService = inject(ReturnsService);
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

  activeView = signal<AdministrationView>("resumen");
  partnerScope = signal<PartnerViewScope>("general");
  selectedMonthId = signal(this.monthId(new Date()));
  lastUpdatedAt = signal<Date | null>(null);
  movementDialogOpen = signal(false);
  movementDialogKind = signal<"expense" | "withdrawal" | "account">("expense");
  movementSaving = signal(false);
  private readonly movementDialog = viewChild<ElementRef<HTMLDialogElement>>("movementDialog");
  private readonly movementDialogEffect = afterRenderEffect((onCleanup) => {
    const dialog = this.movementDialog()?.nativeElement;
    if (!dialog) return;
    const previousFocus = dialog.ownerDocument.activeElement;
    const body = dialog.ownerDocument.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    dialog.showModal();
    onCleanup(() => {
      dialog.close();
      body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    });
  });
  cutDialogOpen = signal(false);
  collectionEventRows = signal<OrderCollectionEvent[]>([]);

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
  expenseAmountInput = signal("");
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

  activeBusinessId = computed<BusinessId>(() => this.businessScope.scope() === "catalogo" ? "catalogo" : "bm");
  activeBusinessLabel = computed(() => this.businessScope.businessLabel(this.activeBusinessId()));

  orders = computed(() => this.ordersService.list().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  inventoryItems = computed(() => this.inventoryService.items().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  inventoryMovements = computed(() => this.inventoryService.movements().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  returnRecords = computed(() => {
    const orderIds = new Set(this.filteredOrders().map((order) => order.order_id));
    return this.returnsService.returns().filter(
      (row) => (row.business_id || "bm") === this.activeBusinessId() && orderIds.has(row.order_id),
    );
  });
  collectionEvents = computed(() => this.collectionEventRows().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  unallocatedHistoricalCollections = computed(() => this.filteredOrders().reduce((total, order) => {
    if (order.paid_at) return total;
    const represented = this.collectionEvents()
      .filter((event) => event.order_id === order.order_id && event.verification_status !== "rejected")
      .reduce((sum, event) => sum + Math.max(0, this.toSafeNumber(event.amount)), 0);
    const paid = Math.min(
      calculateOrderFinancials(order).netAmount,
      Math.max(0, calculateOrderFinancials(order).paidAmount),
    );
    return total + Math.max(0, paid - represented);
  }, 0));
  routes = computed(() => this.routesService.routes());
  accounts = computed(() => this.financeService.accounts().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  expenses = computed(() => this.financeService.expenses().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  withdrawals = computed(() => this.financeService.withdrawals().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  cuts = computed(() => this.financeService.cuts().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  refunds = computed(() => this.financeService.refunds().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  periods = computed(() => this.financeService.periods().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
  customers = computed(() => this.customersService.customers().filter((row) => (row.business_id || "bm") === this.activeBusinessId()));
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

  profitAudit = computed(() => buildProfitAudit(this.filteredOrders(), this.filteredExpenses(), this.filteredWithdrawals()));
  auditCustomers = computed(() => Object.fromEntries(this.customers().map(row => [row.customer_id, [row.first_name, row.last_name].filter(Boolean).join(' ')])));
  auditAccounts = computed(() => Object.fromEntries(this.accounts().map(row => [row.account_id, row.name])));
  auditError = computed(() => this.error() || this.ordersService.loadError());
  auditLoading = computed(() => this.loading() || this.ordersService.loading() || this.financeService.loading());

  editAuditMovement(event: { source: 'expense' | 'withdrawal'; id: string }): void {
    if (!this.canEditMovements()) return;
    if (event.source === 'expense') {
      const row = this.expenses().find(row => row.expense_id === event.id);
      if (!row) return;
      this.startEditExpense(row);
    } else {
      const row = this.withdrawals().find(row => row.withdrawal_id === event.id);
      if (!row) return;
      this.startEditWithdrawal(row);
    }
    this.movementDialogKind.set(event.source);
    this.movementDialogOpen.set(true);
  }

  summary = computed<FinanceSummary>(() =>
    this.buildSummary({
      orders: this.filteredOrders(),
      expenses: this.filteredExpenses(),
      withdrawals: this.filteredWithdrawals(),
      inventory: this.inventoryItems(),
      accounts: this.accounts(),
      projectionDays: this.projectionDays(),
      averageWindowDays: this.averageWindowDays(),
      stagnationDays: this.stagnationDays(),
    }),
  );

  withdrawalPartnerSummary = computed(() => {
    const summary = this.summary();
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

    return calculatePartnerWithdrawalSummary(
      summary.utilidadNeta,
      summary.utilidadCobradaBase,
      withdrawnBlanca,
      withdrawnAndreaPepe,
      withdrawnNonPartner,
    );
  });

  withdrawalSummary = computed(() => {
    const summary = this.summary();
    const partners = this.withdrawalPartnerSummary();
    const totalRetirado = this.filteredWithdrawals().reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);
    return {
      baseDisponible: partners.collectedBase,
      totalRetirado: this.toSafeNumber(totalRetirado),
      disponible: partners.totalAvailableNow,
      gananciaPendienteCobro: this.toSafeNumber(summary.gananciaPendienteCobro),
      saldoPendienteCobro: this.toSafeNumber(summary.saldoPendienteCobro),
    };
  });

  monthlySnapshots = computed<MonthlyFinanceSnapshot[]>(() => {
    const months = this.buildMonthWindows();
    const orders = this.filteredOrders();
    const deliveredOrders = orders.filter(
      (order) => DELIVERED_STATUSES.has(order.status) || Boolean(order.delivered_at),
    );
    const expenses = this.filteredExpenses();
    const withdrawals = this.filteredWithdrawals();
    const movements = this.inventoryMovements();
    const collectionEvents = this.collectionEvents();
    const returns = this.returnRecords().filter((row) => this.isFinancialReturn(row));
    const inventory = this.inventoryItems();
    const currentInventoryCapital = inventory.reduce(
      (sum, row) => sum + this.inventoryRecoverableQty(row) * this.resolveInventoryCostUnit(row, 0),
      0,
    );
    const projections = orders.map((order) => ({
      order,
      projection: calculateOrderProfitProjection(order),
    }));

    return months.map((month) => {
      const cohortOrders = orders.filter((order) =>
        !CANCELLED_STATUSES.has(order.status)
        && this.isWithinMonth(this.orderRecognitionDate(order), month.start, month.end));
      const monthOrders = deliveredOrders.filter((order) =>
        this.isWithinMonth(this.orderDeliveryDate(order), month.start, month.end));
      const monthExpenses = expenses.filter((row) => this.isWithinMonth(row.occurred_at, month.start, month.end));
      const monthWithdrawals = withdrawals.filter((row) => this.isWithinMonth(row.occurred_at, month.start, month.end));
      const monthMovements = movements.filter((row) => this.isWithinMonth(row.created_at, month.start, month.end));
      const monthReturns = returns.filter((row) => this.isWithinMonth(row.occurred_at || row.created_at, month.start, month.end));
      const collected = this.collectedAmountForMonth(month.start, month.end, orders, collectionEvents);
      const cashRefunds = this.refunds()
        .filter((row) => this.isWithinMonth(row.occurred_at, month.start, month.end))
        .reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);
      const laterMovementDelta = movements
        .filter((row) => {
          const date = this.toDate(row.created_at);
          return Boolean(date && date > month.end);
        })
        .reduce((sum, row) => sum + this.inventoryMovementCapitalDelta(row), 0);
      const laterLegacyReturnDelta = returns
        .filter((row) => !movements.some((movement) => movement.return_id === row.return_id))
        .filter((row) => {
          const date = this.toDate(row.created_at);
          return Boolean(date && date > month.end);
        })
        .reduce((sum, row) => sum + this.returnRecoverableCost(row), 0);
      const inventoryClosing = Math.max(0, currentInventoryCapital - laterMovementDelta - laterLegacyReturnDelta);
      const monthLegacyReturnDelta = monthReturns
        .filter((row) => !movements.some((movement) => movement.return_id === row.return_id))
        .reduce((sum, row) => sum + this.returnRecoverableCost(row), 0);
      const monthMovementDelta = monthMovements.reduce(
        (sum, row) => sum + this.inventoryMovementCapitalDelta(row),
        monthLegacyReturnDelta,
      );
      const inventoryOpening = Math.max(0, inventoryClosing - monthMovementDelta);
      const operatingExpenses = this.operatingExpenseTotal(monthExpenses);
      const outcome = calculateAccountingPeriodOutcome({
        deliveredOrders: monthOrders,
        returns: monthReturns.map((row) => ({
          ...row,
          net_return_amount: this.returnRevenueAmount(row),
          returned_cost_amount: this.returnRecoverableCost(row),
        })),
        operatingExpenses,
      });
      const salesBeforeReturns = outcome.deliveredSales;
      const returnsImpact = outcome.returnRevenueAdjustment;
      const returnedCost = outcome.returnedInventoryCost;
      const merchandiseCost = outcome.netCost;
      const netSales = outcome.netSales;
      const generatedSales = this.toSafeNumber(cohortOrders.reduce(
        (sum, order) => sum + originalOrderFinancials(order).netAmount,
        0,
      ));
      const cohortCurrentSales = this.toSafeNumber(cohortOrders.reduce(
        (sum, order) => sum + calculateOrderFinancials(order).netAmount,
        0,
      ));
      const netProfit = outcome.netProfit;
      const inProcessRows = projections.filter(({ order, projection }) =>
        projection.stage === "in_process"
        && this.isWithinMonth(order.created_at || order.updated_at, month.start, month.end));
      const pendingCollectionRows = projections.filter(({ order, projection }) =>
        projection.stage === "pending_collection"
        && this.isWithinMonth(this.orderRecognitionDate(order), month.start, month.end));
      const inProcessProfit = this.toSafeNumber(
        inProcessRows.reduce((sum, row) => sum + row.projection.projectedProfit, 0),
      );
      const pendingCollectionProfit = this.toSafeNumber(
        pendingCollectionRows.reduce((sum, row) => sum + row.projection.projectedProfit, 0),
      );
      const cohortCollectedToDate = this.cohortCollectedToDate(cohortOrders, collectionEvents);
      const cohortPendingToday = this.toSafeNumber(cohortOrders.reduce((sum, order) => {
        const netAmount = calculateOrderFinancials(order).netAmount;
        const collectedToDate = this.knownCollectedToDate(order, collectionEvents);
        return sum + Math.max(0, netAmount - collectedToDate);
      }, 0));
      const cohortProfit = this.toSafeNumber(cohortOrders.reduce(
        (sum, order) => sum + calculateOrderFinancials(order).grossProfit,
        0,
      ));
      const cohortCollectedProfit = this.toSafeNumber(cohortOrders.reduce((sum, order) => {
        const financials = calculateOrderFinancials(order);
        if (financials.netAmount <= 0) return sum;
        const collectedRatio = Math.min(1, this.knownCollectedToDate(order, collectionEvents) / financials.netAmount);
        return sum + financials.grossProfit * collectedRatio;
      }, 0));
      const cohortPendingProfit = this.toSafeNumber(cohortProfit - cohortCollectedProfit);
      const cohortCollectedAfterPeriod = this.toSafeNumber(cohortOrders.reduce((sum, order) => {
        const netAmount = calculateOrderFinancials(order).netAmount;
        const collectedAtClose = this.appliedCollectionsUntil(order, collectionEvents, month.end, netAmount);
        const collectedToDate = this.appliedCollectionsUntil(order, collectionEvents, new Date(), netAmount);
        return sum + Math.max(0, collectedToDate - collectedAtClose);
      }, 0));
      const collectionFlow = this.collectionFlowForMonth(month.start, month.end, orders, collectionEvents);
      const receivablesOpening = this.receivablesAt(
        new Date(month.start.getTime() - 1),
        deliveredOrders,
        collectionEvents,
        returns,
      );
      const receivablesClosing = this.receivablesAt(month.end, deliveredOrders, collectionEvents, returns);
      // Lo pendiente de cobro ya forma parte de netProfit porque el pedido fue
      // entregado. Solo el margen de pedidos aun no entregados se suma para
      // construir el escenario proyectado y evitar contar utilidad dos veces.
      const projectedProfit = this.toSafeNumber(netProfit + inProcessProfit);
      // La utilidad del mes es la que se genero, no la que sobrevivio a una
      // barrera de costo por pedido: esa barrera dejaba meses enteros en cero
      // cuando los pedidos se pagaban en abonos. Las devoluciones ya vienen
      // descontadas dentro de netProfit, restarlas otra vez las contaba doble.
      const collectedProfit = this.collectedProfitForMonth(
        month.start,
        month.end,
        deliveredOrders,
        collectionEvents,
        monthReturns,
      ) - operatingExpenses;
      const distributionAdjustments = operatingExpenses;
      const distributableProfit = netProfit;
      const overdue = monthOrders.reduce((sum, order) => sum + calculateOrderFinancials(order).balanceDue, 0);
      const receivableAge = this.averageReceivableAge(monthOrders);
      let partnerOneWithdrawn = 0;
      let partnerTwoWithdrawn = 0;
      for (const row of monthWithdrawals) {
        const partner = this.resolveWithdrawalPartner(row);
        if (partner === "socio_blanca") partnerOneWithdrawn += this.toSafeNumber(row.amount);
        if (partner === "socio_andrea_pepe") partnerTwoWithdrawn += this.toSafeNumber(row.amount);
      }

      const received = this.movementCapitalByType(monthMovements, "receipt");
      const returned = monthReturns.reduce((sum, row) => sum + this.returnRecoverableCost(row), 0);
      const released = Math.abs(this.movementCapitalByType(monthMovements, "sale"));
      const writtenOff = Math.abs(
        monthMovements
          .filter((row) => row.type === "damage" || row.type === "scrap")
          .reduce((sum, row) => {
            const explicit = Math.max(0, this.toSafeNumber(row.write_off_amount));
            return sum + (explicit > 0 ? explicit : Math.abs(Math.min(0, this.inventoryMovementCapitalDelta(row))));
          }, 0),
      );
      const recovered = this.recoveredCapitalForMonth(month.start, month.end, deliveredOrders, collectionEvents);
      const investment = monthExpenses
        .filter((row) => row.category === "compra_inversion")
        .reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);

      return {
        ...month,
        investment,
        generatedSales,
        cohortCurrentSales,
        cohortReturnsToDate: this.toSafeNumber(Math.max(0, generatedSales - cohortCurrentSales)),
        generatedOrderCount: cohortOrders.length,
        netSales,
        salesBeforeReturns,
        deliveredSales: outcome.deliveredSales,
        deliveredCost: outcome.deliveredCost,
        returnedInventoryCost: returnedCost,
        damagedWriteOff: outcome.damagedWriteOff,
        cashRefunds: this.toSafeNumber(cashRefunds),
        netCashCollections: this.toSafeNumber(collected - cashRefunds),
        periodStatus: this.periods().find((row) => row.month_id === month.id)?.status || "open",
        collected,
        merchandiseCost,
        expenses: operatingExpenses,
        returnsImpact,
        distributionAdjustments,
        netProfit,
        collectedProfit,
        inProcessProfit,
        pendingCollectionProfit,
        projectedProfit,
        inProcessOrderCount: inProcessRows.length,
        pendingCollectionOrderCount: pendingCollectionRows.length,
        cohortCollectedToDate,
        cohortPendingToday,
        cohortProfit,
        cohortCollectedProfit,
        cohortPendingProfit,
        cohortCollectedAfterPeriod,
        collectedFromCurrentPeriod: collectionFlow.currentPeriod,
        collectedFromPriorPeriods: collectionFlow.priorPeriods,
        receivablesOpening,
        receivablesClosing,
        distributableProfit,
        overdue,
        dso: receivableAge,
        partnerOneWithdrawn,
        partnerTwoWithdrawn,
        inventoryOpening,
        inventoryReceipts: Math.max(0, received),
        returnedToInventory: Math.max(0, returned),
        inventoryReleased: released,
        inventoryRecovered: Math.max(0, recovered),
        inventoryWriteOff: writtenOff,
        inventoryClosing,
        stagnantCapital: this.inventoryStagnantCapitalAt(month.end),
      };
    });
  });

  get months(): readonly MonthlyFinanceSnapshot[] {
    return this.monthlySnapshots();
  }

  selectedMonth = computed(() => {
    const months = this.monthlySnapshots();
    return months.find((month) => month.id === this.selectedMonthId()) ?? months[months.length - 1] ?? this.emptyMonthSnapshot();
  });

  previousMonth = computed(() => {
    const months = this.monthlySnapshots();
    const index = months.findIndex((month) => month.id === this.selectedMonthId());
    return months[Math.max(0, index - 1)] ?? this.selectedMonth();
  });

  netSalesDelta = computed(() => this.percentageDelta(this.selectedMonth().netSales, this.previousMonth().netSales));
  netProfitDelta = computed(() => this.percentageDelta(this.selectedMonth().netProfit, this.previousMonth().netProfit));
  margin = computed(() => this.safeRatio(this.selectedMonth().netProfit, this.selectedMonth().netSales));
  /** Margen de todo el historico. El resumen no depende del mes seleccionado. */
  overallMargin = computed(() => this.safeRatio(this.summary().utilidadNeta, this.summary().ventasNetas));
  /**
   * Solo algunas vistas dependen del mes elegido. Resumen y el acumulado de
   * socios son historicos: mostrarles un selector de mes hacia creer que sus
   * cifras cambiaban al moverlo.
   */
  usesMonthScope = computed(() => {
    const view = this.activeView();
    if (view === "mensual" || view === "inventario") return true;
    return false;
  });
  distributableProfit = computed(() => this.selectedMonth().distributableProfit);
  monthlyCollectedProfit = computed(() => this.selectedMonth().collectedProfit);
  monthlyPendingProfit = computed(() => this.distributableProfit() - this.monthlyCollectedProfit());
  sharePerPartner = computed(() => this.distributableProfit() / 2);
  partnerOnePending = computed(() => this.sharePerPartner() - this.selectedMonth().partnerOneWithdrawn);
  partnerTwoPending = computed(() => this.sharePerPartner() - this.selectedMonth().partnerTwoWithdrawn);
  monthlyDistributionAdjustments = computed(() => this.selectedMonth().distributionAdjustments);
  monthlyMerchandiseCost = computed(() => this.selectedMonth().merchandiseCost);
  partnerOne = computed(() => this.withdrawalPartnerSummary().blanca);
  partnerTwo = computed(() => this.withdrawalPartnerSummary().andreaPepe);
  totalDistributableProfit = computed(() => this.withdrawalPartnerSummary().accruedBase);
  totalCollectedProfit = computed(() => this.withdrawalPartnerSummary().collectedBase);
  totalPendingProfit = computed(() => this.withdrawalPartnerSummary().pendingBase);
  profitProjection = computed(() => {
    let inProcessProfit = 0;
    let pendingCollectionProfit = 0;
    let inProcessOrderCount = 0;
    let pendingCollectionOrderCount = 0;

    for (const order of this.filteredOrders()) {
      const projection = calculateOrderProfitProjection(order);
      if (projection.stage === "in_process") {
        inProcessProfit += projection.projectedProfit;
        inProcessOrderCount += 1;
      } else if (projection.stage === "pending_collection") {
        pendingCollectionProfit += projection.projectedProfit;
        pendingCollectionOrderCount += 1;
      }
    }

    return {
      inProcessProfit: this.toSafeNumber(inProcessProfit),
      pendingCollectionProfit: this.toSafeNumber(pendingCollectionProfit),
      inProcessOrderCount,
      pendingCollectionOrderCount,
    };
  });
  totalInProcessProfit = computed(() => this.profitProjection().inProcessProfit);
  totalProjectedProfit = computed(() => this.toSafeNumber(this.totalDistributableProfit() + this.totalInProcessProfit()));
  totalUnclassifiedWithdrawals = computed(() => this.withdrawalPartnerSummary().unclassifiedWithdrawals);
  totalCollected = computed(() => this.summary().ingresosCobrados);
  totalDistributionAdjustments = computed(() => this.summary().egresos);
  totalSharePerPartner = computed(() => this.withdrawalPartnerSummary().blanca.share);
  totalCollectedSharePerPartner = computed(() => this.withdrawalPartnerSummary().blanca.collectedShare);
  totalPartnerOneWithdrawn = computed(() => this.partnerOne().withdrawn);
  totalPartnerTwoWithdrawn = computed(() => this.partnerTwo().withdrawn);
  totalPartnerOnePending = computed(() => this.partnerOne().pendingTotal);
  totalPartnerTwoPending = computed(() => this.partnerTwo().pendingTotal);
  totalPartnerOneAvailable = computed(() => this.partnerOne().availableNow);
  totalPartnerTwoAvailable = computed(() => this.partnerTwo().availableNow);
  totalDistributed = computed(() => this.withdrawalPartnerSummary().totalWithdrawn);
  totalPendingDistribution = computed(() => this.withdrawalPartnerSummary().totalPending);
  totalAvailableNow = computed(() => this.withdrawalPartnerSummary().totalAvailableNow);
  position = computed(() => this.summary().position);
  expenseBreakdown = computed(() => {
    const totals = new Map<FinanceExpenseCategory, number>();
    for (const row of this.filteredExpenses()) {
      totals.set(row.category, (totals.get(row.category) || 0) + Math.max(0, this.toSafeNumber(row.amount)));
    }
    const rows = EXPENSE_CATEGORY_ORDER.filter((category) => totals.has(category)).map((category) => ({
      category,
      label: EXPENSE_CATEGORY_LABEL[category],
      hint: EXPENSE_CATEGORY_HINT[category],
      amount: this.toSafeNumber(totals.get(category) || 0),
      operating: isOperatingExpense(category),
    }));
    const operatingTotal = rows.filter((row) => row.operating).reduce((sum, row) => sum + row.amount, 0);
    const capitalTotal = rows.filter((row) => !row.operating).reduce((sum, row) => sum + row.amount, 0);
    return { rows, operatingTotal: this.toSafeNumber(operatingTotal), capitalTotal: this.toSafeNumber(capitalTotal) };
  });
  expenseCategoryOptions = EXPENSE_CATEGORY_ORDER.map((category) => ({
    id: category,
    label: EXPENSE_CATEGORY_LABEL[category],
    hint: EXPENSE_CATEGORY_HINT[category],
    operating: isOperatingExpense(category),
  }));
  inventoryCapitalDelta = computed(() => this.selectedMonth().inventoryClosing - this.selectedMonth().inventoryOpening);
  inventoryRecoveryRate = computed(() => this.safeRatio(this.selectedMonth().inventoryRecovered, this.selectedMonth().collected));
  inventoryPendingRecovery = computed(() => Math.max(0, this.selectedMonth().collected - this.selectedMonth().inventoryRecovered));
  stagnantCapitalShare = computed(() => this.safeRatio(this.selectedMonth().stagnantCapital, this.availableInventoryCapital()));
  agingCriticalCapital = computed(() => this.inventoryAgingCapital(91, Number.POSITIVE_INFINITY));
  agingStaleCapital = computed(() => this.inventoryAgingCapital(46, 90));
  agingWatchCapital = computed(() => this.inventoryAgingCapital(31, 45));
  agingFreshCapital = computed(() => this.inventoryAgingCapital(0, 30));
  returnCapitalRows = computed<ReturnCapitalRow[]>(() => {
    const month = this.selectedMonth();
    return this.returnRecords()
      .filter((row) => this.isFinancialReturn(row) && row.disposition !== "damaged" && this.isWithinMonth(row.created_at, month.start, month.end))
      .map((row) => {
        const returnedAt = this.toDate(row.created_at) ?? month.start;
        const returnedQty = Math.max(0, this.toSafeNumber(row.qty));
        const capitalReturned = this.returnRecoverableCost(row);
        const cost = returnedQty > 0 ? capitalReturned / returnedQty : 0;
        const sales = this.inventoryMovements()
          .filter((candidate) => candidate.inventory_id === row.inventory_id && candidate.type === "sale")
          .map((candidate) => ({ movement: candidate, date: this.toDate(candidate.created_at) }))
          .filter((candidate) => Boolean(candidate.date && candidate.date >= returnedAt))
          .sort((a, b) => a.date!.getTime() - b.date!.getTime());
        const soldQty = Math.min(returnedQty, sales.reduce((sum, sale) => sum + Math.abs(this.toSafeNumber(sale.movement.delta_on_hand)), 0));
        const firstSaleAt = sales[0]?.date ?? null;
        const elapsedDays = Math.max(0, this.daysSince(returnedAt, new Date()));
        const status: ReturnCapitalRow["status"] = soldQty >= returnedQty && returnedQty > 0
          ? "Liberado"
          : soldQty > 0
            ? "Parcial"
            : elapsedDays > this.stagnationDays()
              ? "Estancado"
              : "En seguimiento";
        const inventory = this.inventoryItems().find((item) => item.inventory_id === row.inventory_id);
        const snapshotTitle = String(row.product_snapshot?.["title"] || row.product_snapshot?.["name"] || "").trim();
        return {
          id: row.return_id,
          product: snapshotTitle || inventory?.title || row.reason || "Producto devuelto",
          capitalReturned,
          capitalResold: soldQty * cost,
          daysToRotate: firstSaleAt ? Math.max(0, this.daysSince(returnedAt, firstSaleAt)) : null,
          status,
        };
      })
      .sort((a, b) => b.capitalReturned - a.capitalReturned);
  });

  returnCapitalResold = computed(() => this.returnCapitalRows().reduce((sum, row) => sum + row.capitalResold, 0));

  withdrawalSelectedPartner = computed(() => this.asPartnerPurpose(this.withdrawalPurpose()));

  movementSourceAccount = computed(() => {
    const accountId = this.movementDialogKind() === "withdrawal" ? this.withdrawalAccountId() : this.expenseAccountId();
    return this.accounts().find((account) => account.account_id === accountId) ?? null;
  });

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
    const account = selectedPartner === "socio_blanca" ? summary.blanca : summary.andreaPepe;
    const current = editingId ? this.filteredWithdrawals().find((row) => row.withdrawal_id === editingId) : null;
    const currentPartner = current ? this.resolveWithdrawalPartner(current) : null;
    const restoredCurrentAmount = current && currentPartner === selectedPartner ? this.toSafeNumber(current.amount) : 0;
    // Solo se puede retirar utilidad ya cobrada; lo que sigue por cobrar es
    // suyo pero todavia no es efectivo.
    return this.toSafeNumber(Math.max(0, account.availableNow + restoredCurrentAmount));
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
    this.returnsService.watch();
    this.restoreReturnContextFromQuery();
    this.reload().catch(() => null);
  }

  setView(view: AdministrationView): void {
    this.activeView.set(view);
  }

  setPartnerScope(scope: PartnerViewScope): void {
    this.partnerScope.set(scope);
  }

  onMonthChange(event: Event): void {
    const select = event.target;
    if (select instanceof HTMLSelectElement) this.selectedMonthId.set(select.value);
  }

  moveMonth(direction: -1 | 1): void {
    const months = this.monthlySnapshots();
    const index = months.findIndex((month) => month.id === this.selectedMonthId());
    const next = Math.min(months.length - 1, Math.max(0, index + direction));
    if (months[next]) this.selectedMonthId.set(months[next].id);
  }

  isFirstMonth(): boolean {
    return this.monthlySnapshots()[0]?.id === this.selectedMonthId();
  }

  isLastMonth(): boolean {
    const months = this.monthlySnapshots();
    return months[months.length - 1]?.id === this.selectedMonthId();
  }

  barHeight(value: number): number {
    if (value <= 0) return 0;
    const max = this.chartScaleMax();
    return Math.max(4, (Math.max(0, value) / max) * 100);
  }

  inventoryBarHeight(value: number): number {
    const max = this.inventoryChartScaleMax();
    return Math.max(4, (Math.max(0, value) / max) * 100);
  }

  inventoryCapitalShare(value: number): number {
    return this.safeRatio(value, this.availableInventoryCapital()) * 100;
  }

  partnerProgress(withdrawn: number): number {
    return Math.min(100, Math.max(0, this.safeRatio(withdrawn, this.sharePerPartner()) * 100));
  }

  overallPartnerProgress(withdrawn: number): number {
    return Math.min(100, Math.max(0, this.safeRatio(withdrawn, this.totalSharePerPartner()) * 100));
  }

  formatMoney(value: number): string {
    return this.formatCurrency(value);
  }

  /** La cuenta que representa la caja del negocio, no una cuenta cualquiera. */
  isGeneralAccount(account: FinanceAccount): boolean {
    const name = String(account.name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("es-MX");
    return name === "general" || String(account.account_id || "").includes("caja_general");
  }

  private defaultFinanceAccountId(): string {
    const rows = this.accounts();
    return rows.find((account) => this.isGeneralAccount(account))?.account_id
      || rows[0]?.account_id
      || "none";
  }

  /** Lo que le falta o le sobra a la General contra lo que arrojan los movimientos. */
  generalAccountGap(account: FinanceAccount): number {
    if (!this.isGeneralAccount(account)) return 0;
    return this.toSafeNumber(this.position().theoreticalCash - this.toSafeNumber(account.balance));
  }

  async syncGeneralAccountBalance(account: FinanceAccount): Promise<void> {
    if (!this.canEditAccounts() || !this.isGeneralAccount(account)) return;
    try {
      await this.financeService.saveAccount({
        account_id: account.account_id,
        business_id: account.business_id,
        name: account.name,
        balance: this.position().theoreticalCash,
        notes: account.notes,
      });
      this.success.set("Saldo de General ajustado a la caja calculada.");
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : "No se pudo ajustar el saldo.");
    }
  }

  absValue(value: number): number {
    return Math.abs(this.toSafeNumber(value));
  }

  formatSignedMoney(value: number): string {
    if (value === 0) return this.formatMoney(0);
    return `${value > 0 ? "+" : "−"}${this.formatMoney(Math.abs(value))}`;
  }

  chartScaleMax(): number {
    return this.roundChartMax(Math.max(1, ...this.monthlySnapshots().flatMap((month) => [month.netSales, month.investment, month.netProfit])));
  }

  inventoryChartScaleMax(): number {
    return this.roundChartMax(Math.max(1, ...this.monthlySnapshots().flatMap((month) => [month.inventoryClosing, month.inventoryReleased])));
  }

  formatCompactMoney(value: number): string {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", notation: "compact", maximumFractionDigits: 0 }).format(value);
  }

  formatDelta(value: number): string {
    const prefix = value > 0 ? "+" : "";
    return `${prefix}${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 }).format(value)}%`;
  }

  ratio(value: number, total: number): number {
    return this.safeRatio(value, total);
  }

  boundedRatio(value: number, total: number): number {
    return Math.min(1, Math.max(0, this.safeRatio(value, total)));
  }

  absolute(value: number): number {
    return Math.abs(value);
  }

  monthlyCollectionGapMagnitude(): number {
    return Math.abs(this.selectedMonth().netSales - this.selectedMonth().collected);
  }

  monthlyCollectionGapLabel(): string {
    return this.selectedMonth().netSales >= this.selectedMonth().collected
      ? "Ventas por encima de cobros del periodo"
      : "Cobros por encima de ventas del periodo";
  }

  monthlyDistributionStatus(month: MonthlyFinanceSnapshot): "Preliminar" | "Seguimiento" | "Cobrado después" | "Cerrado" {
    if (month.periodStatus === "closed") return "Cerrado";
    if (month.id === this.months[this.months.length - 1]?.id) return "Preliminar";
    if (month.cohortPendingToday > 0 || month.inProcessOrderCount > 0) return "Seguimiento";
    if (month.cohortCollectedAfterPeriod > 0) return "Cobrado después";
    return "Cerrado";
  }

  lastUpdatedLabel(): string {
    const value = this.lastUpdatedAt();
    if (!value) return "Sincronizando datos…";
    return `Actualizado hoy, ${new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" }).format(value)}`;
  }

  periodRangeLabel(): string {
    const dates = [
      ...this.orders().map((row) => this.toDate(row.created_at)),
      ...this.expenses().map((row) => this.toDate(row.occurred_at)),
      ...this.withdrawals().map((row) => this.toDate(row.occurred_at)),
      ...this.cuts().map((row) => this.toDate(row.start_at)),
    ].filter((value): value is Date => value !== null);
    if (dates.length === 0) return "Sin movimientos registrados";
    const first = new Date(Math.min(...dates.map((date) => date.getTime())));
    const formatter = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" });
    return `${formatter.format(first)} – hoy`;
  }

  cashAvailable(): number { return this.summary().cajaActual; }
  accountCount(): number { return this.accounts().length; }
  selectedMonthReturnCount(): number {
    const month = this.selectedMonth();
    return this.returnRecords().filter(
      (row) => this.isFinancialReturn(row) && row.disposition !== "damaged" && this.isWithinMonth(row.created_at, month.start, month.end),
    ).length;
  }
  availableInventoryCapital(): number {
    return this.inventoryItems().reduce(
      (sum, item) => sum + this.inventoryAvailableQty(item) * this.resolveInventoryCostUnit(item, 0),
      0,
    );
  }
  reservedInventoryCapital(): number {
    return this.inventoryItems().reduce((sum, item) => {
      const reservedQty = Math.max(0, this.inventoryRecoverableQty(item) - this.inventoryAvailableQty(item));
      return sum + reservedQty * this.resolveInventoryCostUnit(item, 0);
    }, 0);
  }
  inventoryMissingCostQty(): number {
    return this.inventoryItems().reduce((sum, item) => {
      if (this.resolveInventoryCostUnit(item, 0) > 0) return sum;
      return sum + this.inventoryRecoverableQty(item);
    }, 0);
  }
  receivableCapital(): number { return this.summary().porCobrar; }
  courierCash(): number { return this.summary().cobradoConRepartidor; }
  capitalToInvest(): number { return this.summary().capitalPorInvertir; }
  transitCapital(): number { return this.summary().mercanciaTransito; }
  reconciledThisMonth(): number { return this.selectedMonth().collected; }
  stagnantSkuCount(): number { return this.summary().buckets.find((row) => row.id === "stagnantInventory")?.count ?? 0; }
  pendingCollectionCount(): number { return this.summary().pendientesCobro; }
  pendingInvestmentCount(): number { return this.summary().buckets.find((row) => row.id === "confirmedNeedInvestment")?.count ?? 0; }
  transitOrderCount(): number { return this.summary().buckets.find((row) => row.id === "investedNotDelivered")?.count ?? 0; }
  attentionCount(): number {
    return [
      this.summary().saldoPendienteCobro,
      this.courierCash(),
      this.capitalToInvest(),
      this.summary().estancadoCosto,
    ].filter((value) => value > 0).length;
  }

  includedClosuresCount(): number {
    return this.cuts().length;
  }

  openMovementDialog(kind: "expense" | "withdrawal" | "account" = "expense"): void {
    this.movementDialogKind.set(kind);
    if (kind === "expense") this.resetExpenseForm();
    if (kind === "withdrawal") this.resetWithdrawalForm();
    if (kind === "account") this.resetAccountForm();
    this.movementDialogOpen.set(true);
  }

  closeMovementDialog(): void {
    if (this.movementSaving()) return;
    this.movementDialogOpen.set(false);
  }

  async saveMovement(): Promise<void> {
    if (this.movementSaving()) return;
    this.movementSaving.set(true);
    try {
      if (this.movementDialogKind() === "expense") await this.submitExpense();
      else if (this.movementDialogKind() === "withdrawal") await this.submitWithdrawal();
      else await this.submitAccount();
    } finally {
      this.movementSaving.set(false);
    }
  }

  openPartnerPayment(partner: PartnerWithdrawalPurpose): void {
    this.resetWithdrawalForm();
    this.withdrawalPurpose.set(partner);
    this.movementDialogKind.set("withdrawal");
    this.movementDialogOpen.set(true);
  }

  openCutDialog(): void {
    this.cutLabel.set(`Cierre ${this.selectedMonth().label}`);
    this.cutStart.set(this.localDateKey(this.selectedMonth().start));
    this.cutEnd.set(this.localDateKey(this.selectedMonth().end));
    this.cutDialogOpen.set(true);
  }

  closeCutDialog(): void {
    this.cutDialogOpen.set(false);
  }

  exportMonthlyReport(): void {
    const month = this.selectedMonth();
    const rows = [
      ["Indicador", "Monto MXN"],
      ["Inversión pagada", month.investment],
      ["Ventas netas", month.netSales],
      ["Cobrado", month.collected],
      ["Costo de mercancía", month.merchandiseCost],
      ["Gastos", month.expenses],
      ["Devoluciones y ajustes", month.returnsImpact],
      ["Utilidad neta", month.netProfit],
      ["Utilidad distribuible", month.distributableProfit],
      ["Capital en inventario al cierre", month.inventoryClosing],
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `administracion-${this.activeBusinessId()}-${month.id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await Promise.all([
        this.ordersService.loadFromFirestore(),
        this.ordersService.listCollectionEventsForAvailableBusinesses().then((rows) => this.collectionEventRows.set(rows)),
        this.inventoryService.loadFromFirestore().catch(() => null),
        this.routesService.loadFromFirestore().catch(() => null),
        this.customersService.loadFromFirestore().catch(() => null),
        this.financeService.loadAll(),
      ]);
      this.lastUpdatedAt.set(new Date());
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
    const month = this.selectedMonth();
    try {
      await this.financeService.saveCut({
        business_id: this.activeBusinessId(),
        label: this.cutLabel().trim() || `Corte ${start} a ${end}`,
        route_id: this.selectedRouteId(),
        start_at: start,
        end_at: end,
        snapshot: {
          ingresos: month.collected,
          egresos: month.expenses + month.cashRefunds,
          utilidad_bruta: month.netSales - month.merchandiseCost,
          utilidad_neta: month.netProfit,
          por_cobrar: month.receivablesClosing,
          caja: this.summary().cajaActual,
          mercancia_transito: this.summary().mercanciaTransito,
          inventario: month.inventoryClosing,
        },
      });
      this.cutLabel.set("");
      this.cutDialogOpen.set(false);
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

  editAccount(row: FinanceAccount) {
    if (!this.canEditAccounts()) return;
    this.startEditAccount(row);
    this.movementDialogKind.set("account");
    this.movementDialogOpen.set(true);
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
        business_id: this.activeBusinessId(),
        account_id: editingId || undefined,
        name,
        balance: this.accountBalance(),
        notes: this.accountNotes().trim() || null,
      });
      this.resetAccountForm();
      this.movementDialogOpen.set(false);
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
    this.expenseAmountInput.set(this.formatCurrencyInput(row.amount));
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
    this.expenseAmountInput.set("");
    this.expenseDate.set(this.offsetDate(0));
    this.expenseRouteId.set(this.selectedRouteId() || "general");
    this.expenseAccountId.set(this.defaultFinanceAccountId());
    this.expenseInstallmentTotal.set(null);
    this.expenseInstallmentIndex.set(null);
    this.expenseNotes.set("");
  }

  setExpenseCategory(value: unknown) {
    const raw = String(value || "").trim();
    if (EXPENSE_CATEGORY_ORDER.includes(raw as FinanceExpenseCategory)) {
      this.expenseCategory.set(raw as FinanceExpenseCategory);
    }
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
    if (this.expenseAccountId() === "none") {
      this.error.set("Selecciona la cuenta de donde salió el dinero.");
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveExpense({
        business_id: this.activeBusinessId(),
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
      this.movementDialogOpen.set(false);
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
    this.withdrawalAccountId.set(this.defaultFinanceAccountId());
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
    if (this.withdrawalAccountId() === "none") {
      this.error.set("Selecciona la cuenta de donde salió el dinero.");
      return;
    }

    this.error.set(null);
    this.success.set(null);
    try {
      await this.financeService.saveWithdrawal({
        business_id: this.activeBusinessId(),
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
      this.movementDialogOpen.set(false);
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
      drilldown: this.activeView() === 'socios' ? 'profit-audit' : active?.id || null,
    };
    this.closeDrilldown();
    this.router.navigate(["/main/pedidos", orderId], { state });
  }

  expenseCategoryLabel(key: FinanceExpenseCategory): string {
    return EXPENSE_CATEGORY_LABEL[key];
  }

  expenseCategoryHint(key: FinanceExpenseCategory): string {
    return EXPENSE_CATEGORY_HINT[key] || "";
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
      minimumFractionDigits: 2,
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
    if (token === 'profit-audit') {
      this.setView('socios');
      return;
    }
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
    withdrawals: FinanceWithdrawal[];
    inventory: InventoryItem[];
    accounts: FinanceAccount[];
    projectionDays: number;
    averageWindowDays: number;
    stagnationDays: number;
  }): FinanceSummary {
    const expensesTotal = this.operatingExpenseTotal(input.expenses);
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
      .filter((row) => row.category !== "compra_inversion")
      .filter((row) => this.isDateWithinWindow(row.occurred_at, averageWindowDays))
      .reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);
    const promedioEgresoDiario = recentExpenses / averageWindowDays;

    const inventarioRecuperable = input.inventory.reduce(
      (sum, row) => sum + this.inventoryRecoverableQty(row) * this.resolveInventoryCostUnit(row, avgCostUnit),
      0,
    );

    // Un producto sin costo capturado toma el costo promedio de los pedidos.
    // Es mejor que valuarlo en cero, pero es un estimado y tiene que verse.
    let inventarioCostoImputado = 0;
    let inventarioPiezasSinCosto = 0;
    for (const row of input.inventory) {
      if (this.toSafeNumber(row.unit_price) > 0) continue;
      const qty = this.inventoryRecoverableQty(row);
      if (qty <= 0) continue;
      inventarioPiezasSinCosto += qty;
      inventarioCostoImputado += qty * this.resolveInventoryCostUnit(row, avgCostUnit);
    }

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

    // Lo que ya tiene comprador apartado no se puede vender otra vez: separarlo
    // del stock libre es la diferencia entre dinero que llega pronto y dinero
    // que solo llega si se vende.
    const inventarioReservado = Math.max(0, inventarioRecuperable - inventarioCosto);
    const retirosSocios = input.withdrawals
      .filter((row) => this.resolveWithdrawalPartner(row) !== null)
      .reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);
    const retirosSinClasificar = input.withdrawals
      .filter((row) => this.resolveWithdrawalPartner(row) === null)
      .reduce((sum, row) => sum + this.toSafeNumber(row.amount), 0);

    const position = calculateBusinessPosition({
      collectedRevenue: withdrawalProfit.collectedRevenue,
      pendingCollection: withdrawalProfit.pendingCollection,
      deliveredNetCost: withdrawalProfit.deliveredNetCost,
      inventoryReservedAtCost: inventarioReservado,
      inventoryAvailableAtCost: inventarioCosto,
      merchandiseInTransitAtCost: mercanciaTransito,
      expensesTotal,
      partnerWithdrawals: retirosSocios,
      unclassifiedWithdrawals: retirosSinClasificar,
      accruedNetProfit: withdrawalProfit.accruedNetProfit,
      declaredAccountsBalance: cajaActual,
      accountCount: input.accounts.length,
    });

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
      utilidadCobradaBase: withdrawalProfit.collectedNetProfit,
      gananciaPendienteCobro: withdrawalProfit.pendingProfit,
      capitalPendienteCobro: withdrawalProfit.pendingPrincipal,
      saldoPendienteCobro: withdrawalProfit.pendingCollection,
      costoEntregado: withdrawalProfit.deliveredNetCost,
      dsoDias,
      cajaActual,
      porCobrar,
      mercanciaTransito,
      inventarioCosto,
      inventarioReservado,
      inventarioRecuperable: this.toSafeNumber(inventarioRecuperable),
      inventarioCostoImputado: this.toSafeNumber(inventarioCostoImputado),
      inventarioPiezasSinCosto,
      position,
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
      // "YYYY-MM-DD" se interpreta como medianoche local; new Date() lo tomaría como UTC
      // y en México movería los movimientos del día 1 al mes anterior.
      const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const parsed = dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : new Date(value);
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

  /**
   * Todos los meses con actividad, no una ventana fija: recortar a los ultimos
   * seis escondia el arranque del negocio y dejaba meses en blanco sin motivo.
   */
  private monthWindowCount(): number {
    let earliest: Date | null = null;
    for (const order of this.filteredOrders()) {
      const date = this.toDate(this.orderRecognitionDate(order));
      if (date && (!earliest || date < earliest)) earliest = date;
    }
    if (!earliest) return 6;
    const now = new Date();
    const months = (now.getFullYear() - earliest.getFullYear()) * 12 + (now.getMonth() - earliest.getMonth()) + 1;
    return Math.min(60, Math.max(1, months));
  }

  private buildMonthWindows(count = this.monthWindowCount()): Array<Pick<MonthlyFinanceSnapshot, "id" | "label" | "shortLabel" | "start" | "end">> {
    const formatter = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" });
    const shortFormatter = new Intl.DateTimeFormat("es-MX", { month: "short" });
    const now = new Date();
    const rows = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const start = new Date(now.getFullYear(), now.getMonth() - offset, 1, 0, 0, 0, 0);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      const label = formatter.format(start);
      rows.push({
        id: this.monthId(start),
        label: label.charAt(0).toUpperCase() + label.slice(1),
        shortLabel: shortFormatter.format(start).replace(".", "").replace(/^./, (letter) => letter.toUpperCase()),
        start,
        end,
      });
    }
    return rows;
  }

  private monthId(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
  }

  private localDateKey(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }

  private orderRecognitionDate(order: Order): unknown {
    // El mes comercial del pedido siempre es el mes en que se creó. Entrega y
    // cobranza son relojes distintos y no deben mover la venta de su origen.
    return order.created_at || order.updated_at;
  }

  private orderDeliveryDate(order: Order): unknown {
    // Para cartera y liberación de utilidad sí importa cuándo se entregó. Los
    // históricos sin marca de entrega usan la fecha en que quedaron cobrados,
    // tal como opera el negocio. created_at queda solo como último recurso.
    const confirmedCollectionDate = this.collectionEvents()
      .filter((event) => event.order_id === order.order_id && event.verification_status === "confirmed")
      .map((event) => this.toDate(this.collectionRecognitionDate(event)))
      .filter((date): date is Date => date !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return order.delivered_at
      || order.closed_at
      || order.paid_at
      || confirmedCollectionDate
      || order.created_at
      || order.updated_at;
  }

  private collectedAmountForMonth(
    start: Date,
    end: Date,
    orders: Order[],
    events: OrderCollectionEvent[],
  ): number {
    return this.toSafeNumber(
      orders.reduce(
        (sum, order) => sum + this.collectionEntriesForOrder(order, events)
          .filter((entry) => entry.date >= start && entry.date <= end)
          .reduce((entrySum, entry) => entrySum + entry.amount, 0),
        0,
      ),
    );
  }

  private collectionEntriesForOrder(
    order: Order,
    events: OrderCollectionEvent[],
  ): Array<{ date: Date; amount: number }> {
    const orderEvents = events.filter(
      (event) => event.order_id === order.order_id && event.verification_status !== "rejected",
    );
    const entries = orderEvents
      .filter((event) => event.verification_status === "confirmed")
      .map((event) => ({
        date: this.toDate(this.collectionRecognitionDate(event)),
        amount: Math.max(0, this.toSafeNumber(event.amount)),
      }))
      .filter((entry): entry is { date: Date; amount: number } => Boolean(entry.date && entry.amount > 0));

    // Un evento pendiente ya representa ese dinero, pero no se reconoce como
    // cobrado hasta confirmarse. Así tampoco reaparece como cobro histórico.
    const representedByEvents = orderEvents.reduce(
      (sum, event) => sum + Math.max(0, this.toSafeNumber(event.amount)),
      0,
    );
    const financials = calculateOrderFinancials(order);
    const paid = Math.min(financials.netAmount, Math.max(0, financials.paidAmount));
    const historicalRemainder = Math.max(0, paid - representedByEvents);
    const legacyDate = this.toDate(order.paid_at);
    if (historicalRemainder > 0 && legacyDate) {
      entries.push({ date: legacyDate, amount: historicalRemainder });
    }

    return entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  private appliedCollectionsUntil(
    order: Order,
    events: OrderCollectionEvent[],
    cutoff: Date,
    collectibleAmount = calculateOrderFinancials(order).netAmount,
  ): number {
    const received = this.collectionEntriesForOrder(order, events)
      .filter((entry) => entry.date <= cutoff)
      .reduce((sum, entry) => sum + entry.amount, 0);
    return this.toSafeNumber(Math.min(Math.max(0, collectibleAmount), Math.max(0, received)));
  }

  private cohortCollectedToDate(orders: Order[], events: OrderCollectionEvent[]): number {
    return this.toSafeNumber(orders.reduce(
      (sum, order) => sum + this.knownCollectedToDate(order, events),
      0,
    ));
  }

  /**
   * El acumulado por cohorte puede usar paid_amount aunque el histórico no
   * conserve el día exacto. Los eventos reportados, todavía sin confirmar, no
   * se consideran dinero cobrado.
   */
  private knownCollectedToDate(order: Order, events: OrderCollectionEvent[]): number {
    const financials = calculateOrderFinancials(order);
    const orderEvents = events.filter(
      (event) => event.order_id === order.order_id && event.verification_status !== "rejected",
    );
    const representedByEvents = orderEvents.reduce(
      (sum, event) => sum + Math.max(0, this.toSafeNumber(event.amount)),
      0,
    );
    const confirmedByEvents = orderEvents
      .filter((event) => event.verification_status === "confirmed")
      .reduce((sum, event) => sum + Math.max(0, this.toSafeNumber(event.amount)), 0);
    const persistedPaid = Math.min(financials.netAmount, Math.max(0, financials.paidAmount));
    const undatedHistoricalPaid = Math.max(0, persistedPaid - representedByEvents);
    return this.toSafeNumber(Math.min(financials.netAmount, confirmedByEvents + undatedHistoricalPaid));
  }

  private collectionFlowForMonth(
    start: Date,
    end: Date,
    orders: Order[],
    events: OrderCollectionEvent[],
  ): { currentPeriod: number; priorPeriods: number } {
    let currentPeriod = 0;
    let priorPeriods = 0;

    for (const order of orders) {
      const createdAt = this.toDate(this.orderRecognitionDate(order));
      const amount = this.collectionEntriesForOrder(order, events)
        .filter((entry) => entry.date >= start && entry.date <= end)
        .reduce((sum, entry) => sum + entry.amount, 0);
      if (amount <= 0) continue;

      if (createdAt && createdAt < start) priorPeriods += amount;
      else currentPeriod += amount;
    }

    return {
      currentPeriod: this.toSafeNumber(currentPeriod),
      priorPeriods: this.toSafeNumber(priorPeriods),
    };
  }

  private receivablesAt(
    cutoff: Date,
    orders: Order[],
    events: OrderCollectionEvent[],
    returns: ReturnRecord[],
  ): number {
    return this.toSafeNumber(orders.reduce((sum, order) => {
      const recognizedAt = this.toDate(this.orderDeliveryDate(order));
      if (!recognizedAt || recognizedAt > cutoff) return sum;

      // El pedido guarda el neto actual. Para reconstruir un cierre anterior,
      // se reincorporan las devoluciones que ocurrieron despues de ese corte.
      const laterReturnAdjustments = returns
        .filter((row) => row.order_id === order.order_id)
        .filter((row) => {
          const returnedAt = this.toDate(row.created_at);
          return Boolean(returnedAt && returnedAt > cutoff);
        })
        .reduce((returnSum, row) => returnSum + this.returnRevenueAmount(row), 0);
      const collectibleAtCutoff = this.toSafeNumber(
        calculateOrderFinancials(order).netAmount + laterReturnAdjustments,
      );
      const collectedAtCutoff = this.appliedCollectionsUntil(order, events, cutoff, collectibleAtCutoff);
      return sum + Math.max(0, collectibleAtCutoff - collectedAtCutoff);
    }, 0));
  }

  /**
   * Cada abono libera la misma proporcion de utilidad que representa dentro del
   * pedido. Es aditivo: la suma de todos los meses da la utilidad total.
   */
  private collectedProfitForMonth(
    start: Date,
    end: Date,
    orders: Order[],
    events: OrderCollectionEvent[],
    returns: ReturnRecord[],
  ): number {
    const released = orders.reduce((sum, order) => {
      const financials = originalOrderFinancials(order);
      if (financials.netAmount <= 0) return sum;
      const profitRatio = financials.grossProfit / financials.netAmount;
      const recognizedAt = this.toDate(this.orderDeliveryDate(order));
      if (!recognizedAt) return sum;
      let collectibleRemaining = financials.netAmount;
      let collected = 0;
      for (const entry of this.collectionEntriesForOrder(order, events)) {
        if (collectibleRemaining <= 0) break;
        const applied = Math.min(collectibleRemaining, entry.amount);
        collectibleRemaining -= applied;
        // Un cobro registrado antes de la entrega es efectivo, pero no libera
        // utilidad hasta que la venta se reconoce al entregar el pedido.
        const profitReleaseDate = entry.date > recognizedAt ? entry.date : recognizedAt;
        if (profitReleaseDate >= start && profitReleaseDate <= end) collected += applied;
      }
      return sum + collected * profitRatio;
    }, 0);
    const returnProfitReversal = returns.reduce((sum, row) => sum + this.returnProfitImpact(row), 0);
    return this.toSafeNumber(released - returnProfitReversal);
  }

  private recoveredCapitalForMonth(
    start: Date,
    end: Date,
    orders: Order[],
    events: OrderCollectionEvent[],
  ): number {
    return this.toSafeNumber(orders.reduce((sum, order) => {
      const financials = calculateOrderFinancials(order);
      if (financials.netAmount <= 0) return sum;
      const costRatio = financials.netCost / financials.netAmount;
      const collected = this.collectionEntriesForOrder(order, events)
        .filter((entry) => entry.date >= start && entry.date <= end)
        .reduce((entrySum, entry) => entrySum + entry.amount, 0);
      return sum + collected * costRatio;
    }, 0));
  }

  private operatingExpenseTotal(rows: FinanceExpense[]): number {
    return this.toSafeNumber(rows
      .filter((row) => isOperatingExpense(row.category))
      .reduce((sum, row) => sum + Math.max(0, this.toSafeNumber(row.amount)), 0));
  }

  private returnOrderItem(row: ReturnRecord): OrderItem | null {
    const order = this.filteredOrders().find((candidate) => candidate.order_id === row.order_id)
      ?? this.orders().find((candidate) => candidate.order_id === row.order_id);
    return order?.items?.find((item) => item.item_id === row.order_item_id || item.inventory_id === row.inventory_id) ?? null;
  }

  private isFinancialReturn(row: ReturnRecord): boolean {
    const stage = String(row.stage_at_return || "").trim().toLowerCase();
    if (!stage) return true;
    return new Set([
      "entregado", "pago_pendiente",
      "pagado_parcial", "pagado", "closed",
    ]).has(stage);
  }

  private returnRevenueAmount(row: ReturnRecord): number {
    const direct = Math.max(0, this.toSafeNumber(row.net_return_amount));
    if (direct > 0) return direct;
    const item = this.returnOrderItem(row);
    const priceCandidates = [
      row.unit_price_customer,
      item?.price_clienta,
      row.unit_price_public,
      item?.price_public,
    ].map((value) => Math.max(0, this.toSafeNumber(value)));
    const unitPrice = priceCandidates.find((value) => value > 0) || 0;
    const gross = Math.max(0, this.toSafeNumber(row.qty)) * unitPrice;
    return Math.max(0, this.toSafeNumber(gross - this.toSafeNumber(row.discount_share)));
  }

  private returnRecoverableCost(row: ReturnRecord): number {
    if (row.disposition === "damaged" || row.status === "damaged") return 0;
    const direct = Math.max(0, this.toSafeNumber(row.returned_cost_amount));
    if (direct > 0) return direct;
    const item = this.returnOrderItem(row);
    const unitCost = Math.max(0, this.toSafeNumber(row.unit_cost))
      || Math.max(0, this.toSafeNumber(item?.price_cost));
    return this.toSafeNumber(Math.max(0, this.toSafeNumber(row.qty)) * unitCost);
  }

  private returnProfitImpact(row: ReturnRecord): number {
    const direct = this.toSafeNumber(row.profit_impact);
    if (direct !== 0) return Math.max(0, direct);
    return Math.max(0, this.returnRevenueAmount(row) - this.returnRecoverableCost(row));
  }

  private averageReceivableAge(orders: Order[]): number {
    const now = new Date();
    let weightedDays = 0;
    let balanceTotal = 0;
    for (const order of orders) {
      const balance = Math.max(0, calculateOrderFinancials(order).balanceDue);
      if (balance <= 0) continue;
      const recognizedAt = this.toDate(this.orderDeliveryDate(order));
      if (!recognizedAt) continue;
      weightedDays += balance * Math.max(0, this.daysSince(recognizedAt, now));
      balanceTotal += balance;
    }
    return balanceTotal > 0 ? Math.round(weightedDays / balanceTotal) : 0;
  }

  private collectionRecognitionDate(event: OrderCollectionEvent): unknown {
    return event.cash_occurred_at
      || (event.source_location === "durango" ? event.verified_at || event.created_at : event.created_at);
  }

  private isWithinMonth(value: unknown, start: Date, end: Date): boolean {
    const date = this.toDate(value);
    return Boolean(date && date >= start && date <= end);
  }

  private inventoryRecoverableQty(item: InventoryItem): number {
    const onHand = item.on_hand_qty;
    return Math.max(0, this.toSafeNumber(onHand) - this.toSafeNumber(item.damaged_qty));
  }

  private inventoryMovementCapitalDelta(movement: InventoryMovement): number {
    const recoverableDelta = this.toSafeNumber(movement.delta_on_hand) - this.toSafeNumber(movement.delta_damaged);
    return recoverableDelta * this.inventoryMovementCost(movement);
  }

  private inventoryMovementCost(movement: InventoryMovement): number {
    const order = movement.order_id ? this.orders().find((row) => row.order_id === movement.order_id) : null;
    const orderItem = order?.items?.find((row) => row.item_id === movement.order_item_id || row.inventory_id === movement.inventory_id);
    const orderCost = this.toSafeNumber(orderItem?.price_cost);
    if (orderCost > 0) return orderCost;
    const inventory = this.inventoryItems().find((row) => row.inventory_id === movement.inventory_id);
    return Math.max(0, this.toSafeNumber(inventory?.unit_price));
  }

  private movementCapitalByType(movements: InventoryMovement[], type: InventoryMovement["type"]): number {
    return movements
      .filter((row) => row.type === type)
      .reduce((sum, row) => sum + this.inventoryMovementCapitalDelta(row), 0);
  }

  private inventoryStagnantCapitalAt(end: Date): number {
    return this.inventoryItems().reduce((sum, item) => {
      const reference = this.pickBestDate(item.updated_at, item.created_at);
      if (!reference || reference > end) return sum;
      const age = Math.max(0, Math.floor((end.getTime() - reference.getTime()) / 86_400_000));
      if (age < this.stagnationDays()) return sum;
      return sum + this.inventoryAvailableQty(item) * this.resolveInventoryCostUnit(item, 0);
    }, 0);
  }

  private inventoryAgingCapital(minDays: number, maxDays: number): number {
    const end = this.selectedMonth().end;
    return this.inventoryItems().reduce((sum, item) => {
      const reference = this.pickBestDate(item.updated_at, item.created_at);
      if (!reference || reference > end) return sum;
      const age = Math.max(0, Math.floor((end.getTime() - reference.getTime()) / 86_400_000));
      if (age < minDays || age > maxDays) return sum;
      return sum + this.inventoryAvailableQty(item) * this.resolveInventoryCostUnit(item, 0);
    }, 0);
  }

  private emptyMonthSnapshot(): MonthlyFinanceSnapshot {
    const now = new Date();
    return {
      id: this.monthId(now), label: "Mes actual", shortLabel: "Mes", start: now, end: now,
      investment: 0, generatedSales: 0, cohortCurrentSales: 0, cohortReturnsToDate: 0,
      generatedOrderCount: 0, netSales: 0, salesBeforeReturns: 0,
      deliveredSales: 0, deliveredCost: 0, returnedInventoryCost: 0, damagedWriteOff: 0,
      cashRefunds: 0, netCashCollections: 0, periodStatus: "open",
      collected: 0, merchandiseCost: 0, expenses: 0,
      returnsImpact: 0, distributionAdjustments: 0,
      netProfit: 0, collectedProfit: 0, inProcessProfit: 0, pendingCollectionProfit: 0, projectedProfit: 0,
      inProcessOrderCount: 0, pendingCollectionOrderCount: 0, cohortCollectedToDate: 0, cohortPendingToday: 0,
      cohortProfit: 0, cohortCollectedProfit: 0, cohortPendingProfit: 0,
      cohortCollectedAfterPeriod: 0, collectedFromCurrentPeriod: 0, collectedFromPriorPeriods: 0,
      receivablesOpening: 0, receivablesClosing: 0,
      distributableProfit: 0, overdue: 0, dso: 0, partnerOneWithdrawn: 0,
      partnerTwoWithdrawn: 0, inventoryOpening: 0, inventoryReceipts: 0, returnedToInventory: 0,
      inventoryReleased: 0, inventoryRecovered: 0, inventoryWriteOff: 0, inventoryClosing: 0,
      stagnantCapital: 0,
    };
  }

  private percentageDelta(current: number, previous: number): number {
    return previous > 0 ? ((current - previous) / previous) * 100 : 0;
  }

  private safeRatio(value: number, total: number): number {
    return total > 0 ? value / total : 0;
  }

  private roundChartMax(value: number): number {
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
    const step = magnitude >= 10_000 ? 10_000 : magnitude;
    return Math.ceil(value / step) * step;
  }

  private offsetDate(offsetDays: number): string {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }
}
