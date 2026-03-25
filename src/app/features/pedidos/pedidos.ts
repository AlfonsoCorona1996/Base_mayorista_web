import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, QueryList, ViewChildren, computed, inject, signal, ChangeDetectionStrategy, DestroyRef } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { CurrencyPipe, DatePipe, NgClass } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { CustomersService } from "../../core/customers.service";
import { OrdersService, Order, OrderStatus, IncidentSeverity } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { ActionChecklist, PrimaryAction, getActionChecklist, getPrimaryAction } from "./order-primary-action.mapper";

type IntentFilter =
  | "hoy"
  | "por_confirmar"
  | "en_transito"
  | "en_empaque"
  | "listos_ruta"
  | "en_ruta"
  | "con_incidencias"
  | "cobranza_pendiente"
  | "cerrados";

type OrderAlert = { label: string; tone: "danger" | "warning" };

type OrderCardMeta = {
  customerName: string;
  routeName: string;
  primaryAlert: OrderAlert | null;
  hiddenAlertsCount: number;
  packagesMetaLabel: string;
  updatedAtRelative: string;
  visibleItems: Order["items"];
  hiddenItemsCount: number;
  ariaLabel: string;
};

type SalesNoteRow = {
  title: string;
  variant: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-pedidos",
  imports: [FormsModule, DatePipe, CurrencyPipe, NgClass],
  templateUrl: "./pedidos.html",
  styleUrl: "./pedidos.css",
})
export default class PedidosPage implements OnInit, AfterViewInit, OnDestroy {
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private routes = inject(RoutesService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  search = signal("");
  intentFilter = signal<IntentFilter>("por_confirmar");
  routeFilter = signal<string>("todos");
  creating = signal(false);
  newCustomerId = signal<string>("");
  customerQuery = signal<string>("");
  showCustomerList = signal(false);
  newNotes = signal<string>("");
  error = signal<string | null>(null);
  loading = computed(() => this.orders.loading());
  actionSheetOpen = signal(false);
  sheetOrder = signal<Order | null>(null);
  sheetAction = signal<PrimaryAction | null>(null);
  sheetChecklist = signal<ActionChecklist | null>(null);
  resolveFocus = signal<"incidents" | "packages">("packages");
  plannedModalOpen = signal(false);
  plannedOrder = signal<Order | null>(null);
  plannedPackagesInput = signal(1);
  partialReason = signal("");
  partialReasonError = signal<string | null>(null);
  bulkNoteMode = signal(false);
  bulkNotesLoading = signal(false);
  bulkSelected = signal<Record<string, boolean>>({});
  bulkNotesMessage = signal<string | null>(null);

  // ── Vista tabla ────────────────────────────────────────────────────
  viewMode = signal<"cards" | "table">("cards");
  tableSortCol = signal<"updated_at" | "created_at" | "status" | "customer" | "route" | "total">("updated_at");
  tableSortDir = signal<"asc" | "desc">("desc");
  tableDateFrom = signal<string>("");
  tableDateTo   = signal<string>("");
  private visiblePillsByOrder = signal<Record<string, number>>({});
  private pillsResizeObserver: ResizeObserver | null = null;
  private pillMeasureEl: HTMLSpanElement | null = null;
  @ViewChildren("pillsRow", { read: ElementRef }) pillsRows!: QueryList<ElementRef<HTMLElement>>;
  private readonly intentsForCount: IntentFilter[] = [
    "hoy",
    "por_confirmar",
    "en_transito",
    "en_empaque",
    "listos_ruta",
    "en_ruta",
    "con_incidencias",
    "cobranza_pendiente",
    "cerrados",
  ];
  private readonly orderMetaCache = new Map<
    string,
    {
      orderRef: Order;
      visibleCount: number;
      customerName: string;
      routeName: string;
      meta: OrderCardMeta;
    }
  >();

  list = computed(() => this.orders.list());
  intentCounts = computed(() => {
    const term = this.normalizeSearchTerm(this.search());
    const route = this.routeFilter();
    const counts: Record<IntentFilter, number> = {
      hoy: 0,
      por_confirmar: 0,
      en_transito: 0,
      en_empaque: 0,
      listos_ruta: 0,
      en_ruta: 0,
      con_incidencias: 0,
      cobranza_pendiente: 0,
      cerrados: 0,
    };

    for (const order of this.list()) {
      if (route !== "todos" && order.route_id !== route) continue;
      if (!this.matchesSearchTerm(order, term)) continue;

      for (const intent of this.intentsForCount) {
        if (this.matchesIntent(order, intent)) counts[intent] += 1;
      }
    }

    return counts;
  });

  filtered = computed(() => {
    const term = this.normalizeSearchTerm(this.search());
    const intent = this.intentFilter();
    const route = this.routeFilter();

    return this.list()
      .filter((order) => {
        if (!this.matchesIntent(order, intent)) return false;
        if (route !== "todos" && order.route_id !== route) return false;
        return this.matchesSearchTerm(order, term);
      })
      .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  });
  private filteredById = computed(() => {
    const map = new Map<string, Order>();
    for (const order of this.filtered()) {
      map.set(order.order_id, order);
    }
    return map;
  });

  /** Filas de la vista tabla: aplica filtro de fechas y ordenamiento */
  tableRows = computed(() => {
    const col  = this.tableSortCol();
    const dir  = this.tableSortDir();
    const from = this.tableDateFrom();
    const to   = this.tableDateTo();
    const term = this.normalizeSearchTerm(this.search());
    const route = this.routeFilter();

    let rows = this.list().filter(order => {
      if (route !== "todos" && order.route_id !== route) return false;
      if (!this.matchesSearchTerm(order, term)) return false;
      if (from && order.created_at < from) return false;
      if (to   && order.created_at > to + "T23:59:59") return false;
      return true;
    });

    rows = [...rows].sort((a, b) => {
      let va: string | number = "";
      let vb: string | number = "";
      switch (col) {
        case "updated_at":  va = a.updated_at  || ""; vb = b.updated_at  || ""; break;
        case "created_at":  va = a.created_at  || ""; vb = b.created_at  || ""; break;
        case "status":      va = a.status      || ""; vb = b.status      || ""; break;
        case "customer":    va = this.customers.getById(a.customer_id)?.first_name || ""; vb = this.customers.getById(b.customer_id)?.first_name || ""; break;
        case "route":       va = this.routes.getById(a.route_id || "")?.name || ""; vb = this.routes.getById(b.route_id || "")?.name || ""; break;
        case "total":       va = a.totals?.total_amount ?? 0; vb = b.totals?.total_amount ?? 0; break;
      }
      if (va < vb) return dir === "asc" ? -1 : 1;
      if (va > vb) return dir === "asc" ?  1 : -1;
      return 0;
    });

    return rows;
  });

  toggleTableSort(col: "updated_at" | "created_at" | "status" | "customer" | "route" | "total"): void {
    if (this.tableSortCol() === col) {
      this.tableSortDir.update(d => d === "asc" ? "desc" : "asc");
    } else {
      this.tableSortCol.set(col);
      this.tableSortDir.set("desc");
    }
  }

  tableStatusLabel(status: string): string {
    const map: Record<string, string> = {
      borrador: "Borrador",
      confirmando_proveedor: "Confirmando",
      en_transito: "En tránsito",
      packing: "Empaque",
      empaque: "Empaque",
      ready_for_route: "Listo ruta",
      assigned_to_run: "Asignado",
      in_transit: "En ruta",
      en_ruta: "En ruta",
      pago_pendiente: "Pago pend.",
      pagado_parcial: "Pago parcial",
      pagado: "Pagado",
      entregado: "Entregado",
      cancelado: "Cancelado",
    };
    return map[status] ?? status;
  }

  tableStatusClass(status: string): string {
    const map: Record<string, string> = {
      borrador: "trow-status--draft",
      pago_pendiente: "trow-status--pay",
      pagado_parcial: "trow-status--partial",
      pagado: "trow-status--paid",
      cancelado: "trow-status--cancel",
      en_ruta: "trow-status--route",
      in_transit: "trow-status--route",
      ready_for_route: "trow-status--ready",
      assigned_to_run: "trow-status--ready",
    };
    return map[status] ?? "trow-status--default";
  }
  canBulkCreateNotes = computed(() => this.intentFilter() === "listos_ruta");
  bulkReadyOrders = computed(() => this.filtered().filter((order) => this.isReadyForRoute(order)));
  bulkSelectedCount = computed(() => this.bulkReadyOrders().filter((order) => this.bulkSelected()[order.order_id]).length);

  routeOptions = computed(() => [{ id: "todos", name: "Todas las rutas" }, ...this.routes.routes().map((r) => ({ id: r.route_id, name: r.name }))]);
  customerOptions = computed(() => this.customers.getActive());
  customerSuggestions = computed(() => {
    const term = this.customerQuery().trim().toLowerCase();
    if (term.length < 2) return [];
    return this.customerOptions()
      .filter((c) => {
        const blob = `${c.first_name} ${c.last_name} ${c.whatsapp}`.toLowerCase();
        return blob.includes(term);
      })
      .slice(0, 6);
  });
  allRoutes = computed(() => this.routes.routes());
  selectedCustomer = computed(() => this.customers.getById(this.newCustomerId() || ""));
  canCreateOrder = computed(() => !!this.selectedCustomer());
  inferredRouteId = computed(() => this.selectedCustomer()?.route_id || "sin_ruta");
  inferredRouteName = computed(() => {
    const id = this.inferredRouteId();
    if (!id || id === "sin_ruta") return "Sin ruta asignada";
    return this.routes.getById(id)?.name || "Ruta sin nombre";
  });

  async ngOnInit() {
    try {
      await Promise.all([
        this.orders.loadFromFirestore(),
        this.customers.loadFromFirestore().catch(() => null),
        this.routes.loadFromFirestore().catch(() => null),
      ]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar pedidos");
    }
  }

  ngAfterViewInit(): void {
    this.pillsResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        const orderId = row.dataset["orderId"];
        if (!orderId) continue;
        this.recomputePillsForRow(row, orderId);
      }
    });

    this.pillsRows.changes
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.observePillRows());
    this.observePillRows();

    queueMicrotask(() => this.recomputeAllPills());
  }

  ngOnDestroy(): void {
    this.pillsResizeObserver?.disconnect();
    this.pillsResizeObserver = null;
    if (this.pillMeasureEl) {
      this.pillMeasureEl.remove();
      this.pillMeasureEl = null;
    }
  }

  pickCustomer(id: string) {
    this.newCustomerId.set(id);
    this.customerQuery.set(this.customerName(id));
    this.showCustomerList.set(false);
  }

  closeCustomerListSoon() {
    setTimeout(() => this.showCustomerList.set(false), 120);
  }

  async createOrder() {
    const customer = this.selectedCustomer();
    if (!customer) {
      this.error.set("Selecciona una clienta existente para el pedido");
      return;
    }

    this.creating.set(true);
    try {
      const orderId = await this.orders.createDraft(customer.customer_id, this.inferredRouteId() || null, this.newNotes());
      this.search.set("");
      this.intentFilter.set("por_confirmar");
      this.routeFilter.set("todos");
      this.newNotes.set("");
      this.customerQuery.set("");
      this.newCustomerId.set("");
      this.router.navigate(["/main/pedidos", orderId]);
    } finally {
      this.creating.set(false);
    }
  }

  intentOptions = [
    { id: "por_confirmar" as const, label: "Por confirmar" },
    { id: "en_transito" as const, label: "En transito proveedor" },
    { id: "en_empaque" as const, label: "En empaque" },
    { id: "listos_ruta" as const, label: "Listos para ruta" },
    { id: "en_ruta" as const, label: "En ruta" },
    { id: "con_incidencias" as const, label: "Con incidencias" },
    { id: "cobranza_pendiente" as const, label: "Cobranza pendiente" },
    { id: "cerrados" as const, label: "Cerrados" },
  ];

  setIntentFilter(id: IntentFilter) {
    this.intentFilter.set(id);
    this.bulkNotesMessage.set(null);
    if (id !== "listos_ruta") {
      this.cancelBulkNoteMode();
    }
  }

  orderMeta(order: Order): OrderCardMeta {
    const orderId = order.order_id;
    const visibleRaw = this.visiblePillsByOrder()[orderId];
    const visibleCount = typeof visibleRaw === "number" ? visibleRaw : Math.min(3, order.items.length);
    const customerName = this.customerName(order.customer_id);
    const routeName = this.routeName(order.route_id);
    const cached = this.orderMetaCache.get(orderId);
    if (
      cached
      && cached.orderRef === order
      && cached.visibleCount === visibleCount
      && cached.customerName === customerName
      && cached.routeName === routeName
    ) {
      return cached.meta;
    }

    const alerts = this.orderAlerts(order);
    const visibleItems = order.items.slice(0, Math.max(0, visibleCount));
    const meta: OrderCardMeta = {
      customerName,
      routeName,
      primaryAlert: alerts[0] ?? null,
      hiddenAlertsCount: Math.max(0, alerts.length - 1),
      packagesMetaLabel: this.packagesMetaLabel(order),
      updatedAtRelative: this.updatedAtRelative(order.updated_at),
      visibleItems,
      hiddenItemsCount: Math.max(0, order.items.length - visibleItems.length),
      ariaLabel: `Abrir pedido ${order.order_id} de ${customerName}`,
    };

    this.orderMetaCache.set(orderId, {
      orderRef: order,
      visibleCount,
      customerName,
      routeName,
      meta,
    });
    return meta;
  }

  isToday(dateInput: string): boolean {
    const value = new Date(dateInput);
    if (Number.isNaN(value.getTime())) return false;
    const today = new Date();
    return value.getFullYear() === today.getFullYear()
      && value.getMonth() === today.getMonth()
      && value.getDate() === today.getDate();
  }

  matchesIntent(order: Order, intent: IntentFilter): boolean {
    switch (intent) {
      case "hoy":
        return this.isToday(order.updated_at);
      case "por_confirmar":
        return ["borrador", "confirmando_proveedor", "reservado_inventario", "solicitado_proveedor"].includes(order.status);
      case "en_transito":
        return ["supplier_processing", "inbound_in_transit", "en_transito"].includes(order.status);
      case "en_empaque":
        return this.isPackingStage(order);
      case "listos_ruta":
        return this.isReadyForRoute(order);
      case "en_ruta":
        return order.status === "en_ruta";
      case "con_incidencias":
        return this.hasIncidents(order);
      case "cobranza_pendiente":
        return order.status === "pago_pendiente";
      case "cerrados":
        return ["pagado", "entregado", "cancelado", "devuelto"].includes(order.status);
      default:
        return true;
    }
  }

  plannedPackagesCount(order: Order): number | null {
    const planned = order.planned_packages;
    if (planned === null || planned === undefined) return null;
    return Math.max(1, Number(planned));
  }

  closedPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => this.isClosedPackage(pkg)).length;
  }

  deliveredPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => pkg.state === "entregado").length;
  }

  packagesSummary(order: Order): string {
    const planned = this.plannedPackagesCount(order);
    const closed = this.closedPackagesCount(order);
    return planned === null ? `${closed}/-` : `${closed}/${planned}`;
  }

  packagesSummarySafe(order: Order | null): string {
    if (!order) return "0/-";
    return this.packagesSummary(order);
  }

  packagesMetaLabel(order: Order): string {
    const summary = this.packagesSummary(order);
    if (summary === "0/-") return "Sin paquetes";
    if (summary.endsWith("/-")) return summary.replace("/-", "");
    return summary;
  }

  hasIncompletePackages(order: Order): boolean {
    const planned = this.plannedPackagesCount(order);
    if (planned === null) return false;
    if (["cancelado", "devuelto"].includes(order.status)) return false;
    const isReady = this.statusRank(order.status) >= this.statusRank("recibido_qa");
    return isReady && this.closedPackagesCount(order) < planned;
  }

  hasPaymentPending(order: Order): boolean {
    return order.status === "pago_pendiente";
  }

  hasIncidents(order: Order): boolean {
    return (order.open_incidents_count ?? 0) > 0;
  }

  private isClosedPackage(pkg: Order["packages"][number]): boolean {
    const status = String((pkg as any).status || "").toLowerCase();
    const state = String(pkg.state || "").toLowerCase();
    if (status === "closed") return true;
    if ((pkg as any).closed_at) return true;
    return ["armado", "closed", "en_ruta", "entregado"].includes(state);
  }

  private isReadyForRoute(order: Order): boolean {
    if (order.status === "ready_for_route") return true;
    if (order.status === "assigned_to_run") return false;
    if (order.status !== "empaque") return false;
    const planned = this.plannedPackagesCount(order);
    if (planned === null) return false;
    if (this.closedPackagesCount(order) < planned) return false;
    return this.unassignedConfirmedItems(order) === 0;
  }

  private isPackingStage(order: Order): boolean {
    if (order.status === "recibido_qa" || order.status === "packing") return true;
    if (order.status !== "empaque") return false;
    return !this.isReadyForRoute(order);
  }

  incidentsLabel(order: Order): string {
    const count = order.open_incidents_count ?? 0;
    return count === 1 ? "1 incidencia" : `${count} incidencias`;
  }

  private normalizeSearchTerm(value: string): string {
    return (value || "").trim().toLowerCase();
  }

  private compactSearchValue(value: string): string {
    return this.normalizeSearchTerm(value).replace(/[^a-z0-9]/g, "");
  }

  private matchesSearchTerm(order: Order, term: string): boolean {
    if (!term) return true;
    const searchableParts = [
      order.order_id,
      this.customerName(order.customer_id),
      order.route_id || "",
      order.items.map((i) => i.title).join(" "),
    ];
    const blob = this.normalizeSearchTerm(searchableParts.join(" "));
    if (blob.includes(term)) return true;

    // Also match IDs even when users type without separators (e.g. P2401 vs P-2401).
    const compactTerm = this.compactSearchValue(term);
    if (!compactTerm) return false;
    const compactBlob = this.compactSearchValue(searchableParts.join(" "));
    return compactBlob.includes(compactTerm);
  }

  updatedAtRelative(dateInput: string): string {
    const value = new Date(dateInput);
    if (Number.isNaN(value.getTime())) return "sin fecha";
    const diffMs = Date.now() - value.getTime();
    const diffMin = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMin < 1) return "hace menos de 1 min";
    if (diffMin < 60) return `hace ${diffMin} min`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `hace ${diffHours} h`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `hace ${diffDays} d`;
    return value.toLocaleDateString("es-MX");
  }

  statusRank(status: OrderStatus): number {
    const flow: OrderStatus[] = [
      "borrador",
      "confirmando_proveedor",
      "reservado_inventario",
      "solicitado_proveedor",
      "supplier_processing",
      "inbound_in_transit",
      "en_transito",
      "recibido_qa",
      "empaque",
      "en_ruta",
      "entregado",
      "pago_pendiente",
      "pagado",
      "cancelado",
      "devuelto",
    ];
    const idx = flow.indexOf(status);
    return idx === -1 ? 0 : idx;
  }

  needsPlannedPackages(order: Order): boolean {
    const planned = this.plannedPackagesCount(order);
    return planned === null && (order.status === "recibido_qa" || order.status === "empaque");
  }

  openPlannedPackages(order: Order) {
    this.plannedOrder.set(order);
    this.plannedPackagesInput.set(1);
    this.plannedModalOpen.set(true);
  }

  savePlannedPackages() {
    const order = this.plannedOrder();
    if (!order) return;
    const planned = Math.max(1, Number(this.plannedPackagesInput() || 1));
    this.orders.updatePlannedPackages(order.order_id, planned);
    this.plannedModalOpen.set(false);
    this.openActionSheet(order);
  }

  closePlannedPackages() {
    this.plannedModalOpen.set(false);
  }

  isPartialDelivery(order: Order | null): boolean {
    if (!order) return false;
    const planned = this.plannedPackagesCount(order);
    if (planned === null) return false;
    return this.deliveredPackagesCount(order) < planned;
  }

  openActionSheet(order: Order) {
    const action = getPrimaryAction(order);
    if (action.disabled) return;
    if (this.needsPlannedPackages(order)) {
      this.openPlannedPackages(order);
      return;
    }
    this.sheetOrder.set(order);
    this.sheetAction.set(action);
    this.sheetChecklist.set(getActionChecklist(order, action.actionId));
    this.resolveFocus.set(this.focusForAction(order, action.actionId));
    this.partialReason.set("");
    this.partialReasonError.set(null);
    this.actionSheetOpen.set(true);
  }

  closeActionSheet() {
    this.actionSheetOpen.set(false);
  }

  async continuePrimary() {
    const action = this.sheetAction();
    const checklist = this.sheetChecklist();
    const order = this.sheetOrder();
    if (!action || !checklist || !order) return;
    const allowPartial = action.actionId === "register_delivery_payment" && this.isPartialDelivery(order);
    if (checklist.blocking && !allowPartial) return;
    if (action.actionId === "register_delivery_payment" && this.isPartialDelivery(order)) {
      const reason = this.partialReason().trim();
      if (!reason) {
        this.partialReasonError.set("Explica el motivo de la entrega parcial.");
        return;
      }
    }
    this.actionSheetOpen.set(false);
    if (action.actionId === "register_delivery_payment" && this.isPartialDelivery(order)) {
      await this.orders.createIncident(order.order_id, {
        orderId: order.order_id,
        packageId: null,
        itemId: null,
        type: "PARTIAL_DELIVERY",
        title: "Entrega parcial",
        severity: "high",
        reason: this.partialReason().trim(),
        evidenceUrls: [],
        createdBy: "admin",
      });
      const url = this.router.createUrlTree([action.route], {
        queryParams: { partialDeliveryReason: this.partialReason().trim() },
      });
      this.router.navigateByUrl(url);
      return;
    }
    this.router.navigateByUrl(action.route);
  }

  resolveNow() {
    const order = this.sheetOrder();
    const action = this.sheetAction();
    if (!order || !action) return;
    this.actionSheetOpen.set(false);
    this.router.navigate(["/main/pedidos", order.order_id], {
      queryParams: { focus: this.resolveFocus() },
    });
  }

  private missingChecklistReasons(): string[] {
    const checklist = this.sheetChecklist();
    if (!checklist) return [];
    return checklist.items.filter((row) => !row.ok).map((row) => row.text);
  }

  private incidentSeverityForAction(actionId: string, blocking: boolean): IncidentSeverity {
    if (actionId === "register_delivery_payment") return blocking ? "high" : "medium";
    if (actionId === "prepare_dispatch") return blocking ? "medium" : "low";
    return blocking ? "medium" : "low";
  }

  private incidentTypeFromOrder(order: Order, actionId: string): string {
    const planned = this.plannedPackagesCount(order);
    const closed = this.closedPackagesCount(order);
    const delivered = this.deliveredPackagesCount(order);
    const unassigned = this.unassignedConfirmedItems(order);
    if (actionId === "register_delivery_payment" && planned !== null && delivered < planned) {
      return "PARTIAL_DELIVERY";
    }
    if (planned === null || closed < (planned ?? 0)) {
      return "PACKAGE_INCOMPLETE";
    }
    if (unassigned > 0) {
      return "MISSING_ITEMS";
    }
    return "CHECKLIST_BLOCKED";
  }

  private incidentTitleFromType(type: string): string {
    switch (type) {
      case "PARTIAL_DELIVERY":
        return "Entrega parcial";
      case "PACKAGE_INCOMPLETE":
        return "Paquetes incompletos";
      case "MISSING_ITEMS":
        return "Items sin asignar";
      default:
        return "Incidencia por bloqueo";
    }
  }

  private focusForAction(order: Order, actionId: string): "incidents" | "packages" {
    const planned = this.plannedPackagesCount(order);
    const closed = this.closedPackagesCount(order);
    const unassigned = this.unassignedConfirmedItems(order);
    if (actionId === "register_delivery_payment" && this.isPartialDelivery(order)) return "incidents";
    if (actionId === "prepare_dispatch" && (planned === null || closed < (planned ?? 0))) return "packages";
    if (unassigned > 0) return "incidents";
    return "packages";
  }

  private unassignedConfirmedItems(order: Order): number {
    const assigned = new Set<string>();
    for (const pkg of order.packages || []) {
      for (const id of pkg.item_ids || []) assigned.add(id);
    }
    return (order.items || []).filter((item) => {
      const isConfirmed = !["entregado", "pagado", "cancelado", "devuelto"].includes(item.state);
      return isConfirmed && !assigned.has(item.item_id);
    }).length;
  }

  async createIncidentFromSheet() {
    const order = this.sheetOrder();
    const action = this.sheetAction();
    const checklist = this.sheetChecklist();
    if (!order || !action || !checklist) return;
    const missing = this.missingChecklistReasons();
    const reason = action.actionId === "register_delivery_payment" && this.partialReason().trim()
      ? this.partialReason().trim()
      : (missing.length > 0 ? missing.join(" \u00b7 ") : action.label);
    const type = this.incidentTypeFromOrder(order, action.actionId);
    const severity = this.incidentSeverityForAction(action.actionId, checklist.blocking);
    await this.orders.createIncident(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: null,
      type,
      title: this.incidentTitleFromType(type),
      severity,
      reason,
      evidenceUrls: [],
      createdBy: "admin",
    });
    this.actionSheetOpen.set(false);
  }

  statusLabel(status: OrderStatus): string {
    const map: Record<OrderStatus, string> = {
      borrador: "Borrador",
      confirmando_proveedor: "Confirmando",
      reservado_inventario: "Reservado",
      solicitado_proveedor: "Solicitado",
      supplier_processing: "Proveedor",
      inbound_in_transit: "En transito proveedor",
      en_transito: "En transito proveedor",
      packing: "Empacando",
      recibido_qa: "En transito proveedor",
      empaque: "Empaque",
      ready_for_route: "Listo para ruta",
      assigned_to_run: "Asignado a salida",
      in_transit: "En transito",
      en_ruta: "En ruta",
      delivered: "Entregado",
      delivered_partial: "Entrega parcial",
      entregado: "Entregado",
      closed: "Cerrado",
      pago_pendiente: "Pago pendiente",
      pagado_parcial: "Pago parcial",
      pagado: "Pagado",
      cancelado: "Cancelado",
      devuelto: "Devuelto",
    };
    return map[status];
  }

  statusClass(status: OrderStatus): string {
    switch (status) {
      case "borrador":
        return "chip neutral";
      case "reservado_inventario":
      case "confirmando_proveedor":
        return "chip info";
      case "packing":
      case "empaque":
      case "ready_for_route":
      case "assigned_to_run":
      case "in_transit":
      case "en_transito":
      case "inbound_in_transit":
      case "en_ruta":
        return "chip accent";
      case "delivered":
      case "closed":
      case "entregado":
      case "pagado":
        return "chip success";
      case "pago_pendiente":
        return "chip warning";
      default:
        return "chip danger";
    }
  }

  customerName(customerId: string): string {
    const row = this.customers.getById(customerId);
    if (!row) return "Cliente sin nombre";
    return [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Cliente sin nombre";
  }

  routeName(routeId: string | null): string {
    if (!routeId || routeId === "sin_ruta") return "Sin ruta";
    return this.routes.getById(routeId)?.name || routeId;
  }

  startBulkNoteMode() {
    if (!this.canBulkCreateNotes()) {
      this.bulkNotesMessage.set("Disponible solo en la vista Listos para ruta.");
      return;
    }
    if (this.bulkReadyOrders().length === 0) {
      this.bulkNotesMessage.set("No hay pedidos listos para ruta para generar nota.");
      return;
    }
    this.bulkSelected.set({});
    this.bulkNoteMode.set(true);
    this.bulkNotesMessage.set("Selecciona los pedidos para generar notas.");
  }

  cancelBulkNoteMode() {
    this.bulkNoteMode.set(false);
    this.bulkSelected.set({});
  }

  onOrderCardActivate(order: Order, event?: Event) {
    if (event instanceof KeyboardEvent && (event.key === " " || event.key === "Spacebar" || event.key === "Enter")) {
      event.preventDefault();
    }
    if (this.bulkNoteMode()) {
      event?.preventDefault();
      event?.stopPropagation();
      if (!this.canSelectForBulkNote(order)) return;
      this.toggleOrderForBulkNote(order.order_id, !this.isSelectedForBulkNote(order.order_id));
      return;
    }
    this.open(order.order_id);
  }

  toggleOrderForBulkNote(orderId: string, checked: boolean) {
    this.bulkSelected.update((current) => ({
      ...current,
      [orderId]: checked,
    }));
  }

  isSelectedForBulkNote(orderId: string): boolean {
    return !!this.bulkSelected()[orderId];
  }

  canSelectForBulkNote(order: Order): boolean {
    return this.canBulkCreateNotes() && this.isReadyForRoute(order);
  }

  async generateBulkNotes() {
    if (!this.canBulkCreateNotes()) {
      this.bulkNotesMessage.set("Filtra primero en Listos para ruta.");
      return;
    }
    const selectedOrders = this.bulkReadyOrders().filter((order) => this.bulkSelected()[order.order_id]);
    if (selectedOrders.length === 0) {
      this.bulkNotesMessage.set("Selecciona al menos un pedido.");
      return;
    }
    if (this.bulkNotesLoading()) return;

    this.bulkNotesLoading.set(true);
    this.bulkNotesMessage.set(null);
    let generated = 0;
    let failed = 0;

    for (const order of selectedOrders) {
      try {
        const rows = this.salesNoteRows(order);
        if (rows.length === 0) {
          failed += 1;
          continue;
        }
        const blob = await this.buildSalesNoteImage(order, rows);
        this.downloadBlob(blob, `nota-${order.order_id}-${Date.now()}.png`);
        generated += 1;
        await this.orders.logEvent(order.order_id, "SALES_NOTE_GENERATED", "Nota de venta generada (lote)", {
          rows: rows.length,
          total: rows.reduce((sum, row) => sum + row.lineTotal, 0),
          mode: "bulk",
        }).catch(() => null);
        await this.sleep(120);
      } catch (error) {
        failed += 1;
        console.warn("[pedidos] No se pudo generar nota en lote", { orderId: order.order_id, error });
      }
    }

    this.bulkNotesLoading.set(false);
    this.cancelBulkNoteMode();
    if (failed === 0) {
      this.bulkNotesMessage.set(`Se generaron ${generated} nota(s).`);
    } else if (generated > 0) {
      this.bulkNotesMessage.set(`Se generaron ${generated} nota(s). ${failed} pedido(s) no se pudieron procesar.`);
    } else {
      this.bulkNotesMessage.set("No se pudo generar ninguna nota con la selección actual.");
    }
  }

  open(orderId: string) {
    this.router.navigate(["/main/pedidos", orderId]);
  }

  primaryAction(order: Order): PrimaryAction {
    return getPrimaryAction(order);
  }

  private orderAlerts(order: Order): Array<{ label: string; tone: "danger" | "warning" }> {
    const alerts: Array<{ label: string; tone: "danger" | "warning" }> = [];
    if (this.hasPaymentPending(order)) alerts.push({ label: "$ pendiente", tone: "warning" });

    const incidents = order.open_incidents_count ?? 0;
    if (incidents > 0) {
      alerts.push({ label: this.incidentsLabel(order), tone: "warning" });
    }
    return alerts;
  }

  newDraft() {
    this.createOrder();
  }

  private itemConfirmedQty(item: Order["items"][number]): number {
    if (item.confirmation_state !== "confirmed") return 0;
    const fallback = Math.max(0, Number(item.quantity || 0));
    const raw = Number(item.confirmed_qty);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(0, Math.min(fallback, Math.trunc(raw)));
  }

  private salesNoteRows(order: Order): SalesNoteRow[] {
    return (order.items || [])
      .filter((item) => !["cancelado", "devuelto"].includes(item.state))
      .map((item) => {
        const qty = this.itemConfirmedQty(item);
        const unitPrice = item.price_clienta ?? item.price_public ?? 0;
        return {
          title: item.title || "Producto",
          variant: `${item.variant || "Unica"} · ${item.color || "N/A"}`,
          qty,
          unitPrice,
          lineTotal: unitPrice * qty,
        };
      })
      .filter((row) => row.qty > 0);
  }

  private async buildSalesNoteImage(order: Order, rows: SalesNoteRow[]): Promise<Blob> {
    const width = 1080;
    const cardX = 40;
    const cardY = 34;
    const cardW = width - (cardX * 2);
    const rowHeight = 84;
    const rowGap = 10;
    const rowsHeight = rows.length > 0 ? (rows.length * rowHeight) + ((rows.length - 1) * rowGap) : 0;
    const cardH = 340 + rowsHeight + 126;
    const height = (cardY * 2) + cardH;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo crear el lienzo para la nota.");

    const customer = this.customerName(order.customer_id);
    const dateText = new Date().toLocaleDateString("es-MX", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const total = rows.reduce((sum, row) => sum + row.lineTotal, 0);

    ctx.fillStyle = "#f2f5fa";
    ctx.fillRect(0, 0, width, height);
    this.drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 32, "#ffffff");
    ctx.fill();

    const titleTop = cardY + 52;
    ctx.fillStyle = "#0f172a";
    ctx.font = "700 50px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText("Nota de venta", cardX + 44, titleTop);

    ctx.fillStyle = "#5f6f85";
    ctx.font = "500 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(customer, cardX + 44, titleTop + 46);
    ctx.fillText(dateText, cardX + 44, titleTop + 82);

    ctx.textAlign = "right";
    ctx.fillStyle = "#4f627d";
    ctx.font = "700 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(`Pedido ${order.order_id}`, cardX + cardW - 44, titleTop + 4);
    ctx.textAlign = "left";

    const headerTop = cardY + 150;
    this.drawRoundedRect(ctx, cardX + 28, headerTop, cardW - 56, 56, 16, "#f5f8fd");
    ctx.fill();

    const qtyX = cardX + cardW - 360;
    const unitX = cardX + cardW - 220;
    const totalX = cardX + cardW - 56;
    ctx.fillStyle = "#4f627d";
    ctx.font = "600 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText("Producto", cardX + 56, headerTop + 36);
    ctx.textAlign = "right";
    ctx.fillText("Cant", qtyX, headerTop + 36);
    ctx.fillText("Unit", unitX, headerTop + 36);
    ctx.fillText("Total", totalX, headerTop + 36);
    ctx.textAlign = "left";

    let y = headerTop + 72;
    for (const row of rows) {
      this.drawRoundedRect(ctx, cardX + 28, y, cardW - 56, rowHeight, 14, "#ffffff");
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      this.drawRoundedRect(ctx, cardX + 28, y, cardW - 56, rowHeight, 14, "#ffffff");
      ctx.strokeStyle = "#dce6f3";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#0f172a";
      ctx.font = "600 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText(this.truncateForNote(ctx, row.title, 480, "600 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"), cardX + 56, y + 36);

      ctx.fillStyle = "#64748b";
      ctx.font = "500 21px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText(this.truncateForNote(ctx, row.variant, 480, "500 21px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"), cardX + 56, y + 66);

      ctx.fillStyle = "#1f2f46";
      ctx.font = "600 25px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(String(row.qty), qtyX, y + 50);
      ctx.fillText(this.formatCurrency(row.unitPrice), unitX, y + 50);
      ctx.fillText(this.formatCurrency(row.lineTotal), totalX, y + 50);
      ctx.textAlign = "left";

      y += rowHeight + rowGap;
    }

    const footerTop = headerTop + 72 + rowsHeight + 20;
    this.drawRoundedRect(ctx, cardX + 28, footerTop, cardW - 56, 90, 16, "#f6f9ff");
    ctx.fillStyle = "#f6f9ff";
    ctx.fill();
    ctx.fillStyle = "#5f6f85";
    ctx.font = "600 29px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText("Total", cardX + 56, footerTop + 55);
    ctx.fillStyle = "#0f172a";
    ctx.font = "700 42px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(this.formatCurrency(total), totalX, footerTop + 58);
    ctx.textAlign = "left";

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("No se pudo exportar la nota."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fillStyle: string,
  ) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
  }

  private truncateForNote(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, font: string): string {
    ctx.font = font;
    if (ctx.measureText(value).width <= maxWidth) return value;
    let text = value;
    while (text.length > 0 && ctx.measureText(`${text}…`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text ? `${text}…` : "…";
  }

  private formatCurrency(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  }

  private downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(ms))));
  }

  private observePillRows() {
    if (!this.pillsResizeObserver) return;
    this.pillsResizeObserver.disconnect();
    for (const rowRef of this.pillsRows.toArray()) {
      const row = rowRef.nativeElement;
      const orderId = row.dataset["orderId"];
      if (!orderId) continue;
      this.pillsResizeObserver.observe(row);
      this.recomputePillsForRow(row, orderId);
    }
  }

  private recomputeAllPills() {
    for (const rowRef of this.pillsRows?.toArray() || []) {
      const row = rowRef.nativeElement;
      const orderId = row.dataset["orderId"];
      if (!orderId) continue;
      this.recomputePillsForRow(row, orderId);
    }
  }

  private recomputePillsForRow(row: HTMLElement, orderId: string) {
    const order = this.filteredById().get(orderId);
    if (!order) return;

    const available = row.clientWidth;
    if (!available || order.items.length === 0) {
      this.visiblePillsByOrder.update((map) => (map[orderId] === 0 ? map : { ...map, [orderId]: 0 }));
      return;
    }

    const styles = getComputedStyle(row);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "5") || 5;
    const maxChipWidth = Math.max(90, Math.floor(available * 0.58));

    let visible = 0;
    let used = 0;
    for (let i = 0; i < order.items.length; i += 1) {
      const itemWidth = Math.min(this.measurePillWidth(order.items[i].title, false), maxChipWidth);
      const nextUsed = used + (visible > 0 ? gap : 0) + itemWidth;
      const remaining = order.items.length - (i + 1);
      let reserveForMore = 0;
      if (remaining > 0) {
        const moreWidth = this.measurePillWidth(`+${remaining}`, true);
        reserveForMore = (visible + 1 > 0 ? gap : 0) + moreWidth;
      }
      if (nextUsed + reserveForMore <= available) {
        used = nextUsed;
        visible += 1;
      } else {
        break;
      }
    }

    if (visible === 0) visible = 1;
    this.visiblePillsByOrder.update((map) => (map[orderId] === visible ? map : { ...map, [orderId]: visible }));
  }

  private measurePillWidth(text: string, isMore: boolean): number {
    if (!this.pillMeasureEl) {
      const node = document.createElement("span");
      node.className = "pill pill-measure";
      document.body.appendChild(node);
      this.pillMeasureEl = node;
    }
    this.pillMeasureEl.className = isMore ? "pill more pill-measure" : "pill pill-measure";
    this.pillMeasureEl.textContent = text;
    return Math.ceil(this.pillMeasureEl.getBoundingClientRect().width);
  }
}

