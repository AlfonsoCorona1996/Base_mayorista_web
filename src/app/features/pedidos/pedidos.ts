import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, QueryList, ViewChildren, computed, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
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

@Component({
  standalone: true,
  selector: "app-pedidos",
  imports: [FormsModule, DatePipe],
  templateUrl: "./pedidos.html",
  styleUrl: "./pedidos.css",
})
export default class PedidosPage implements OnInit, AfterViewInit, OnDestroy {
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private routes = inject(RoutesService);
  private router = inject(Router);

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

    this.pillsRows.changes.subscribe(() => this.observePillRows());
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
    { id: "en_transito" as const, label: "En tr\u00e1nsito/por recibir" },
    { id: "en_empaque" as const, label: "En empaque" },
    { id: "listos_ruta" as const, label: "Listos para ruta" },
    { id: "en_ruta" as const, label: "En ruta" },
    { id: "con_incidencias" as const, label: "Con incidencias" },
    { id: "cobranza_pendiente" as const, label: "Cobranza pendiente" },
    { id: "cerrados" as const, label: "Cerrados" },
  ];

  setIntentFilter(id: IntentFilter) {
    this.intentFilter.set(id);
  }

  intentCount(intent: IntentFilter): number {
    return this.intentCounts()[intent] ?? 0;
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

  visibleItems(order: Order) {
    const visible = this.visiblePillsByOrder()[order.order_id];
    const count = typeof visible === "number" ? visible : Math.min(3, order.items.length);
    return order.items.slice(0, Math.max(0, count));
  }

  hiddenItemsCount(order: Order): number {
    return Math.max(0, order.items.length - this.visibleItems(order).length);
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
    return count === 1 ? "\u26a0 1 incidencia" : `\u26a0 ${count} incidencias`;
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

  primaryAlert(order: Order): { label: string; tone: "danger" | "warning" } | null {
    const alerts = this.orderAlerts(order);
    return alerts.length > 0 ? alerts[0] : null;
  }

  hiddenAlertsCount(order: Order): number {
    return Math.max(0, this.orderAlerts(order).length - 1);
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
      inbound_in_transit: "En camino proveedor",
      en_transito: "En tr\u00e1nsito",
      packing: "Empacando",
      recibido_qa: "Recibido/QA",
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
    const order = this.filtered().find((entry) => entry.order_id === orderId);
    if (!order) return;

    const available = row.clientWidth;
    if (!available || order.items.length === 0) {
      this.visiblePillsByOrder.update((map) => ({ ...map, [orderId]: 0 }));
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
    this.visiblePillsByOrder.update((map) => ({ ...map, [orderId]: visible }));
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

