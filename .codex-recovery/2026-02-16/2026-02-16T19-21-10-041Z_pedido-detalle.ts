import { Component, ElementRef, HostListener, OnInit, ViewChild, computed, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { CustomersService } from "../../core/customers.service";
import { SuppliersService } from "../../core/suppliers.service";
import { OrdersService, Order, OrderEvent, OrderItem, OrderItemState, OrderStatus, PackageRecord, Incident, IncidentSeverity } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { InventoryService, InventoryItem } from "../../core/inventory.service";
import { NormalizedListingsService, NormalizedListingDoc } from "../../core/normalized-listings.service";

@Component({
  standalone: true,
  selector: "app-pedido-detalle",
  imports: [FormsModule, RouterLink, DatePipe],
  templateUrl: "./pedido-detalle.html",
  styleUrls: ["./pedido-detalle.css"],
})
export default class PedidoDetallePage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private suppliers = inject(SuppliersService);
  private rutas = inject(RoutesService);
  private inventory = inject(InventoryService);
  private catalog = inject(NormalizedListingsService);

  @ViewChild("incidentsSection") incidentsSection?: ElementRef<HTMLElement>;
  @ViewChild("packagesSection") packagesSection?: ElementRef<HTMLElement>;
  @ViewChild("timelineSection") timelineSection?: ElementRef<HTMLElement>;

  orderId = signal<string>("");
  error = signal<string | null>(null);

  order = computed<Order | null>(() => this.orders.getById(this.orderId()));
  incidents = signal<Incident[]>([]);
  events = signal<OrderEvent[]>([]);
  eventsCursor = signal<any>(null);
  eventsLoading = signal(false);
  eventsHasMore = signal(true);
  confirmQtyDraft = signal<Record<string, number>>({});
  debugMode = signal(false);
  userRole = signal("admin");
  copiedOrderId = signal(false);
  showStickyFooter = signal(false);
  productStockFilter = signal<"all" | "insufficient">("all");
  showStockFab = signal(false);
  quickMenuItemId = signal<string | null>(null);
  quickConfirming = signal<Record<string, boolean>>({});

  incidentModalOpen = signal(false);
  incidentType = signal("GENERAL");
  incidentSeverity = signal<IncidentSeverity>("medium");
  incidentTitle = signal("");
  incidentReason = signal("");
  incidentAssignee = signal("");
  incidentSaving = signal(false);
  showResolvedIncidents = signal(false);

  resolveModalOpen = signal(false);
  resolveNote = signal("");
  resolveTarget = signal<Incident | null>(null);
  assignModalOpen = signal(false);
  assignTarget = signal<Incident | null>(null);

  uploadingEvidence = signal<Record<string, boolean>>({});

  plannedModalOpen = signal(false);
  plannedPackagesInput = signal(1);
  actionModalOpen = signal(false);
  actionContext = signal<{ actionId: string; label: string } | null>(null);
  actionError = signal<string | null>(null);
  actionSaving = signal(false);
  lateChangeApproved = signal(false);
  selectedPackageId = signal<string | null>(null);
  supplierEta = signal("");
  addItemModalOpen = signal(false);
  newItemSupplierId = signal<string | null>(null);
  newItemProductId = signal<string | null>(null);
  selectedPreviewHasColorImage = signal(true);

  pendingItems = computed(() => (this.order()?.items || []).filter((item) => item.state !== "entregado" && item.state !== "pagado"));
  totals = computed(() => {
    const items = this.order()?.items || [];
    let totalClienta = 0;
    let totalCost = 0;
    for (const item of items) {
      const qty = item.quantity || 0;
      const priceClienta = item.price_clienta ?? item.price_public ?? 0;
      const priceCost = item.price_cost ?? 0;
      totalClienta += priceClienta * qty;
      totalCost += priceCost * qty;
    }
    const ganancia = totalClienta - totalCost;
    return {
      totalClienta,
      totalCost,
      ganancia,
    };
  });

  newItemTitle = signal("");
  newItemSearch = signal("");
  newItemSource = signal<"catalogo" | "inventario">("catalogo");
  newItemVariant = signal("");
  newItemColor = signal("");
  newItemInventoryId = signal<string | null>(null);
  newItemQty = signal(1);
  newItemPricePublic = signal<number | null>(null);
  newItemPriceCost = signal<number | null>(null);
  newItemPriceClienta = signal<number | null>(null);
  newItemDiscount = signal<number | null>(null);
  priceInputFocused = signal<"final" | "clienta" | "costo" | null>(null);
  priceInputDraft = signal<{ final: string; clienta: string; costo: string }>({
    final: "",
    clienta: "",
    costo: "",
  });
  supplierDiscountPct = signal<number | null>(null);
  supplierDiscountLabel = signal<string | null>(null);
  selectedPreview = signal<{ title: string; variant: string; color: string; image: string | null; source: string } | null>(null);
  selectedCatalogDoc = signal<NormalizedListingDoc | null>(null);
  inventoryLoaded = signal(false);
  catalogLoaded = signal(false);
  showProductList = signal(false);
  suppressProductBlur = signal(false);
  lockItemFields = signal(false);
  catalogVariantOptions = signal<string[]>([]);
  catalogColorOptions = signal<string[]>([]);
  assigneeOptions = computed(() =>
    this.customers
      .getActive()
      .map((c) => `${c.first_name} ${c.last_name}`.trim())
      .filter(Boolean)
  );
  supplierOptions = computed(() => this.suppliers.getActive());
  inventoryById = computed(() => {
    const map = new Map<string, InventoryItem>();
    for (const row of this.inventory.items()) map.set(row.inventory_id, row);
    return map;
  });

  inventorySuggestions = computed(() => {
    if (this.newItemSource() !== "inventario") return [];
    const term = this.newItemSearch().trim().toLowerCase();
    if (term.length < 2) return [];
    return this.inventory.items()
      .filter((item) => {
        const blob = [item.title, item.color_name || "", item.variant_name || "", item.size_label || ""]
          .join(" ")
          .toLowerCase();
        return blob.includes(term);
      })
      .slice(0, 6);
  });
  catalogSuggestions = computed(() => {
    if (this.newItemSource() !== "catalogo") return [];
    const term = this.newItemSearch().trim().toLowerCase();
    if (term.length < 2) return [];
    const matches: { doc: NormalizedListingDoc; variant: any; color: string; image: string | null }[] = [];
    for (const doc of this.catalogRows || []) {
      const listing: any = doc.listing || { items: [] };
      const title = (listing.title || "").toLowerCase();
      const cat = (listing.category_hint || "").toLowerCase();
      const variants = listing.items || [];
      for (const v of variants) {
        const colors = this.getVariantColors(v);
        const blob = [title, cat, v.variant_name || "", colors.join(" ")].join(" ").toLowerCase();
        if (!blob.includes(term)) continue;
        const colorHit = colors.find((c) => c.toLowerCase().includes(term)) || colors[0] || "";
        const colorImage = this.resolveColorImage(doc, colorHit);
        const image = colorImage || v?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
        matches.push({ doc, variant: v, color: colorHit, image });
        break; // first variant hit is enough per doc for now
      }
    }
    return matches.slice(0, 6);
  });

  private catalogRows: NormalizedListingDoc[] = [];

  ngOnInit() {
    this.orderId.set(this.route.snapshot.paramMap.get("id") || "");
    Promise.all([
      this.orders.loadFromFirestore(),
      this.customers.loadFromFirestore().catch(() => null),
      this.suppliers.loadFromFirestore().catch(() => null),
      this.rutas.loadFromFirestore().catch(() => null),
      this.inventory.loadFromFirestore().catch(() => null),
      this.catalog.listValidated(120).then((page) => {
        this.catalogRows = page.docs;
        this.catalogLoaded.set(true);
      }).catch(() => null),
    ]).then(() => {
      this.inventoryLoaded.set(true);
      if (!this.orders.getById(this.orderId())) {
        this.error.set("Pedido no encontrado");
        return;
      }
      this.loadIncidents();
      this.refreshEvents();
    });

    this.route.queryParamMap.subscribe((params) => {
      const focus = params.get("focus");
      this.debugMode.set(params.get("debug") === "1");
      if (!focus) return;
      setTimeout(() => this.applyFocus(focus), 60);
    });
  }

  async loadIncidents() {
    const orderId = this.orderId();
    if (!orderId) return;
    const list = await this.orders.listIncidents(orderId).catch(() => []);
    this.incidents.set(list);
  }

  openIncidents(): Incident[] {
    return this.incidents().filter((inc) => inc.status === "open");
  }

  resolvedIncidents(): Incident[] {
    return this.incidents().filter((inc) => inc.status === "resolved");
  }

  itemHasOpenIncident(itemId: string): boolean {
    return this.incidents().some((inc) => inc.status === "open" && inc.itemId === itemId);
  }

  toggleResolved() {
    this.showResolvedIncidents.update((current) => !current);
  }

  async loadEvents() {
    const orderId = this.orderId();
    if (!orderId) return;
    if (this.eventsLoading() || !this.eventsHasMore()) return;
    this.eventsLoading.set(true);
    try {
      const page = await this.orders.listEventsPage(orderId, 20, this.eventsCursor()).catch(() => ({ events: [], cursor: null }));
      this.events.update((current) => [...current, ...page.events]);
      this.eventsCursor.set(page.cursor ?? null);
      if (!page.events.length) this.eventsHasMore.set(false);
    } finally {
      this.eventsLoading.set(false);
    }
  }

  async refreshEvents() {
    this.events.set([]);
    this.eventsCursor.set(null);
    this.eventsHasMore.set(true);
    await this.loadEvents();
  }

  customerName(order: Order | null): string {
    if (!order) return "";
    const row = this.customers.getById(order.customer_id);
    if (!row) return "Cliente sin nombre";
    return `${row.first_name} ${row.last_name}`.trim();
  }

  routeName(order: Order | null): string {
    if (!order || !order.route_id) return "Sin ruta";
    return this.rutas.getById(order.route_id)?.name || order.route_id;
  }

  statusLabel(status: OrderStatus): string {
    const map: Record<OrderStatus, string> = {
      borrador: "Borrador",
      confirmando_proveedor: "Confirmando",
      reservado_inventario: "Reservado",
      solicitado_proveedor: "Solicitado",
      en_transito: "En trÃƒÂ¡nsito",
      recibido_qa: "Recibido/QA",
      empaque: "Empaque",
      en_ruta: "En ruta",
      entregado: "Entregado",
      pago_pendiente: "Pago pendiente",
      pagado: "Pagado",
      cancelado: "Cancelado",
      devuelto: "Devuelto",
    };
    return map[status];
  }

  statusClass(status: OrderStatus): string {
    switch (status) {
      case "entregado":
      case "pagado":
        return "chip success";
      case "cancelado":
      case "devuelto":
        return "chip danger";
      case "pago_pendiente":
        return "chip warning";
      case "empaque":
      case "en_ruta":
      case "en_transito":
        return "chip accent";
      default:
        return "chip info";
    }
  }

  eventActor(event: any): string {
    if (!event) return "Usuario";
    if (typeof event.actor === "string" && event.actor.trim()) return event.actor;
    if (event.actor?.name) return event.actor.name;
    if (event.meta?.system) return "Sistema";
    return "Usuario";
  }

  relativeTime(value: string | Date | null | undefined): string {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.round(Math.abs(diffMs) / 60000);
    if (diffMin < 1) return "Justo ahora";
    if (diffMin < 60) return `Hace ${diffMin} min`;
    const diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return `Hace ${diffHours} h`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) return `Hace ${diffDays} d`;
    const diffWeeks = Math.round(diffDays / 7);
    if (diffWeeks < 5) return `Hace ${diffWeeks} sem`;
    const diffMonths = Math.round(diffDays / 30);
    if (diffMonths < 12) return `Hace ${diffMonths} mes`;
    const diffYears = Math.round(diffDays / 365);
    return `Hace ${diffYears} a`;
  }

  allowedCapabilities(order: Order | null, userRole: string) {
    if (!order) {
      return {
        canEditItems: false,
        canConfirmItems: false,
        canRegisterReception: false,
        canCreatePackages: false,
        canAssignItemsToPackages: false,
        canPrintLabels: false,
        canDeliverByPackage: false,
        canRegisterPayment: false,
        canPack: false,
        limitedEdit: false,
      };
    }
    if (userRole === "viewer") {
      return {
        canEditItems: false,
        canConfirmItems: false,
        canRegisterReception: false,
        canCreatePackages: false,
        canAssignItemsToPackages: false,
        canPrintLabels: false,
        canDeliverByPackage: false,
        canRegisterPayment: false,
        canPack: false,
        limitedEdit: false,
      };
    }
    switch (order.status) {
      case "borrador":
        return {
          canEditItems: true,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: false,
        };
      case "confirmando_proveedor":
      case "reservado_inventario":
      case "solicitado_proveedor":
      case "en_transito":
        return {
          canEditItems: true,
          canConfirmItems: true,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: true,
        };
      case "recibido_qa":
      case "empaque":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: true,
          canCreatePackages: true,
          canAssignItemsToPackages: true,
          canPrintLabels: true,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: true,
          limitedEdit: false,
        };
      case "en_ruta":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: true,
          canDeliverByPackage: true,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: true,
        };
      case "pagado":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: false,
        };
      case "pago_pendiente":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: true,
          canPack: false,
          limitedEdit: false,
        };
      case "entregado":
      default:
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: false,
        };
    }
  }

  phaseAction(order: Order | null): { actionId: string; label: string } | null {
    if (!order) return null;
    switch (order.status) {
      case "borrador":
      case "confirmando_proveedor":
      case "reservado_inventario":
      case "solicitado_proveedor":
      case "en_transito":
        return { actionId: "confirm_items", label: "Confirmar existencias" };
      case "recibido_qa":
        return { actionId: "pack", label: "Empacar" };
      case "empaque":
        return { actionId: "dispatch", label: "Preparar salida" };
      case "en_ruta":
        return { actionId: "deliver", label: "Registrar entrega" };
      case "pago_pendiente":
        return { actionId: "register_payment", label: "Registrar pago/conciliar" };
      default:
        return null;
    }
  }

  openActionModal(order: Order | null) {
    const action = this.phaseAction(order);
    if (!order || !action) return;
    if (action.actionId === "confirm_items" && order.items.length === 0) {
      this.actionContext.set(action);
      this.actionError.set("No hay items en el pedido.");
      this.actionModalOpen.set(true);
      return;
    }
    this.actionContext.set(action);
    this.actionError.set(null);
    this.actionModalOpen.set(true);
  }

  closeActionModal() {
    this.actionModalOpen.set(false);
  }

  closedPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => ["armado", "en_ruta", "entregado"].includes(pkg.state)).length;
  }

  deliveredPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => pkg.state === "entregado").length;
  }

  unassignedConfirmedItems(order: Order): number {
    const assigned = new Set<string>();
    for (const pkg of order.packages || []) {
      for (const id of pkg.item_ids || []) assigned.add(id);
    }
    return (order.items || []).filter((item) => {
      const isConfirmed = !["entregado", "pagado", "cancelado", "devuelto"].includes(item.state);
      return isConfirmed && !assigned.has(item.item_id);
    }).length;
  }

  canDispatch(order: Order): boolean {
    const planned = this.plannedPackages(order);
    if (planned === null) return false;
    if (this.closedPackagesCount(order) < planned) return false;
    if (this.unassignedConfirmedItems(order) > 0) return false;
    return true;
  }

  supplierNameById(supplierId: string | null | undefined): string {
    if (!supplierId) return "Sin proveedor";
    return this.suppliers.getById(supplierId)?.display_name || supplierId;
  }

  itemImage(item: OrderItem): string | null {
    if (item.image_url) return item.image_url;

    if (item.source === "inventario" && item.inventory_id) {
      return this.inventory.items().find((row) => row.inventory_id === item.inventory_id)?.image_urls?.[0] || null;
    }

    if (item.source === "catalogo" && item.product_id) {
      const doc = this.catalogRows.find((row) => row.normalized_id === item.product_id) || null;
      if (!doc) return null;
      const listing: any = doc.listing || { items: [] };
      const variant = (listing.items || []).find((v: any) => (v.variant_name || "") === (item.variant || "")) || null;
      return variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    }

    return null;
  }

  groupedItemsBySupplier(order: Order): { supplierId: string | null; supplierName: string; items: OrderItem[] }[] {
    const groups = new Map<string | null, OrderItem[]>();
    for (const item of order.items || []) {
      const key = item.supplier_id ?? null;
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    return Arraâ€¦6053 tokens truncatedâ€¦"en_transito");
      await this.orders.logEvent(order.order_id, "MARKED_INBOUND", "Pedido marcado en trÃƒÂ¡nsito", { eta });
      await this.refreshEvents();
      this.actionError.set(null);
      this.closeActionModal();
    } finally {
      this.actionSaving.set(false);
    }
  }

  async confirmExistences(order: Order) {
    if (!this.allItemsResolved(order)) {
      this.actionError.set("AÃƒÂºn hay items sin resolver.");
      return;
    }
    if (this.actionSaving()) return;
    this.actionSaving.set(true);
    try {
      await this.orders.updateStatus(order.order_id, "recibido_qa");
      await this.orders.logEvent(order.order_id, "EXISTENCES_CONFIRMED", "Existencias confirmadas", {
        items: order.items.length,
        nextStatus: "recibido_qa",
      });
      await this.refreshEvents();
      this.actionError.set(null);
      this.closeActionModal();
    } finally {
      this.actionSaving.set(false);
    }
  }

  openIncidentModal() {
    this.incidentType.set("GENERAL");
    this.incidentSeverity.set("medium");
    this.incidentTitle.set("Incidencia general");
    this.incidentReason.set("");
    this.incidentAssignee.set("");
    this.incidentModalOpen.set(true);
  }

  closeIncidentModal() {
    this.incidentModalOpen.set(false);
  }

  async createIncident() {
    const order = this.order();
    if (!order) return;
    const reason = this.incidentReason().trim();
    if (!reason) return;
    this.incidentSaving.set(true);
    try {
      await this.orders.createIncident(order.order_id, {
        orderId: order.order_id,
        packageId: null,
        itemId: null,
        type: this.incidentType(),
        severity: this.incidentSeverity(),
        title: this.incidentTitle().trim() || this.incidentType(),
        reason,
        assigneeId: this.incidentAssignee().trim() || null,
        evidenceUrls: [],
        createdBy: "admin",
      });
      await this.loadIncidents();
      await this.refreshEvents();
      this.incidentModalOpen.set(false);
    } finally {
      this.incidentSaving.set(false);
    }
  }

  openResolveModal(incident: Incident) {
    this.resolveTarget.set(incident);
    this.resolveNote.set("");
    this.resolveModalOpen.set(true);
  }

  closeResolveModal() {
    this.resolveModalOpen.set(false);
  }

  async confirmResolve() {
    const order = this.order();
    const incident = this.resolveTarget();
    if (!order || !incident) return;
    await this.orders.resolveIncident(order.order_id, incident.id, this.resolveNote().trim(), "admin");
    await this.loadIncidents();
    await this.refreshEvents();
    this.resolveModalOpen.set(false);
  }

  async attachEvidence(incident: Incident, event: Event) {
    const order = this.order();
    if (!order) return;
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.uploadingEvidence.update((current) => ({ ...current, [incident.id]: true }));
    try {
      await this.orders.uploadIncidentEvidence(order.order_id, incident.id, file, "admin");
      await this.loadIncidents();
      await this.refreshEvents();
    } finally {
      this.uploadingEvidence.update((current) => ({ ...current, [incident.id]: false }));
      input.value = "";
    }
  }

  openAssignModal(incident: Incident) {
    this.assignTarget.set(incident);
    this.incidentAssignee.set(incident.assigneeId || "");
    this.assignModalOpen.set(true);
  }

  closeAssignModal() {
    this.assignModalOpen.set(false);
  }

  async confirmAssign() {
    const order = this.order();
    const incident = this.assignTarget();
    if (!order || !incident) return;
    const assignee = this.incidentAssignee().trim();
    if (!assignee) return;
    await this.orders.updateIncident(order.order_id, incident.id, {
      assigneeId: assignee,
    }, "admin");
    await this.loadIncidents();
    await this.refreshEvents();
    this.assignModalOpen.set(false);
  }

  scrollToTimeline() {
    this.timelineSection?.nativeElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  @HostListener("window:scroll")
  onWindowScroll() {
    this.showStickyFooter.set(window.scrollY > 260);
    this.showStockFab.set(window.innerWidth <= 640 && window.scrollY > 360);
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.closeQuickMenu();
  }

  async copyOrderId(orderId: string) {
    const value = (orderId || "").trim();
    if (!value) return;
    await navigator.clipboard.writeText(value).catch(() => null);
    this.copiedOrderId.set(true);
    setTimeout(() => this.copiedOrderId.set(false), 1200);
  }

  isConfirmItemsPhase(order: Order | null): boolean {
    return this.phaseAction(order)?.actionId === "confirm_items";
  }

  scrollToSection(sectionId: "incidencias" | "productos" | "paquetes" | "bitacora") {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  applyFocus(focus: string) {
    if (focus === "incidents" || focus === "incidents:new") {
      this.incidentsSection?.nativeElement.scrollIntoView({ behavior: "smooth", block: "start" });
      if (focus === "incidents:new") this.openIncidentModal();
    } else if (focus === "packages") {
      this.packagesSection?.nativeElement.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  packageCode(order: Order, pkg: PackageRecord): string {
    return JSON.stringify(
      {
        orderId: order.order_id,
        packageId: pkg.package_id,
        seq: pkg.sequence,
        total: pkg.total_packages,
        amountDue: pkg.amount_due,
      },
      null,
      0,
    );
  }

  qrPlaceholder(order: Order, pkg: PackageRecord): string {
    return `QR:${order.order_id}:${pkg.package_id}:${pkg.sequence}/${pkg.total_packages}`;
  }

  backToList() {
    this.router.navigate(["/main/pedidos"]);
  }

  addItem(order: Order | null) {
    if (!order) return;
    const caps = this.allowedCapabilities(order, this.userRole());
    const canLateChange = order.status === "en_ruta" && this.lateChangeApproved();
    if (!caps.canEditItems && !canLateChange) return;
    if (!this.selectedPreview()) {
      this.error.set("Selecciona un producto del catÃƒÂ¡logo o inventario.");
      return;
    }
    const title = this.newItemTitle().trim();
    if (!title) {
      this.error.set("Escribe el nombre del producto");
      return;
    }
    const qty = Math.max(1, this.newItemQty());
    if (this.isClientaBelowCosto()) {
      alert("Precio clienta no puede ser menor a precio costo.");
      return;
    }
    const item: OrderItem = {
      item_id: "",
      title,
      variant: this.newItemVariant().trim() || null,
      color: this.newItemColor().trim() || null,
      quantity: qty,
      source: this.newItemSource(),
      state: "reservado_inventario",
      confirmation_state: "pending",
      supplier_id: this.newItemSupplierId(),
      product_id: this.newItemProductId(),
      price_clienta: this.newItemPriceClienta(),
      price_public: this.newItemPricePublic(),
      price_cost: this.newItemPriceCost(),
      discount_pct: this.newItemDiscount(),
      inventory_id: this.newItemInventoryId(),
      image_url: this.selectedPreview()?.image || null,
    };
    this.orders.addItem(order.order_id, item);
    this.orders.logEvent(order.order_id, "ITEM_ADDED", `Item agregado: ${item.title}`, {
      itemId: item.item_id,
    });
    if (item.source === "inventario" && item.inventory_id) {
      this.inventory.adjustQuantity(item.inventory_id, -qty).catch(() => null);
    }
    this.newItemTitle.set("");
    this.newItemVariant.set("");
    this.newItemColor.set("");
    this.newItemQty.set(1);
    this.newItemPricePublic.set(null);
    this.newItemPriceCost.set(null);
    this.newItemPriceClienta.set(null);
    this.priceInputFocused.set(null);
    this.priceInputDraft.set({ final: "", clienta: "", costo: "" });
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.newItemSearch.set("");
    this.newItemInventoryId.set(null);
    this.newItemSupplierId.set(null);
    this.newItemProductId.set(null);
    this.lockItemFields.set(false);
    this.catalogVariantOptions.set([]);
    this.catalogColorOptions.set([]);
    this.selectedPreview.set(null);
    this.selectedCatalogDoc.set(null);
  }

  async removeItem(order: Order | null, item: OrderItem) {
    if (!order) return;
    const caps = this.allowedCapabilities(order, this.userRole());
    const canLateChange = order.status === "en_ruta" && this.lateChangeApproved();
    if (!caps.canEditItems && !canLateChange) return;
    const ok = confirm(`Quitar "${item.title}" del pedido?`);
    if (!ok) return;

    if (item.source === "inventario" && item.inventory_id) {
      await this.inventory.adjustQuantity(item.inventory_id, item.quantity).catch(() => null);
    }

    const nextItems = order.items.filter((row) => row.item_id !== item.item_id);
    await this.orders.updateItems(order.order_id, nextItems);
    await this.orders.logEvent(order.order_id, "ITEM_REMOVED", `Item removido: ${item.title}`, {
      itemId: item.item_id,
    });
  }

  pickInventory(item: InventoryItem) {
    const image = item.image_urls?.[0] || null;
    const costo = item.unit_price || null;
    const final = costo !== null ? Number((costo * 2).toFixed(2)) : null;
    this.newItemTitle.set(item.title);
    this.newItemVariant.set(item.variant_name || item.size_label || "");
    this.newItemColor.set(item.color_name || "");
    this.newItemPricePublic.set(final);
    this.newItemPriceClienta.set(this.computeClientaPrice(final));
    this.newItemPriceCost.set(costo);
    this.updatePriceDraftFromSignals();
    this.newItemSource.set("inventario");
    this.newItemInventoryId.set(item.inventory_id);
    this.newItemSupplierId.set(item.supplier_id || null);
    this.newItemProductId.set(item.inventory_id || null);
    this.showProductList.set(false);
    this.lockItemFields.set(true);
    this.catalogVariantOptions.set([]);
    this.catalogColorOptions.set([]);
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.selectedPreviewHasColorImage.set(Boolean(image));
    this.selectedPreview.set({
      title: item.title,
      variant: this.newItemVariant(),
      color: this.newItemColor(),
      image,
      source: "Inventario",
    });
    this.selectedCatalogDoc.set(null);
  }

  pickCatalog(doc: NormalizedListingDoc, variant: any, color: string) {
    const listing = doc.listing || { items: [] } as any;
    const variants = (listing.items || []).map((it: any) => it.variant_name || "Sin variante");
    const colors = this.getVariantColors(variant);
    const selectedColor = color || colors[0] || "";
    const prices = this.getVariantPriceSet(variant);
    const colorImage = this.resolveColorImage(doc, selectedColor);
    const image = colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    this.newItemTitle.set(listing.title || "Producto sin nombre");
    this.newItemVariant.set(variant?.variant_name || variants[0] || "");
    this.newItemColor.set(selectedColor);
    this.newItemPricePublic.set(prices.final);
    this.newItemPriceClienta.set(this.computeClientaPrice(prices.final));
    this.newItemPriceCost.set(prices.costo);
    this.updatePriceDraftFromSignals();
    this.newItemSource.set("catalogo");
    this.newItemInventoryId.set(null);
    this.newItemSupplierId.set(doc.supplier_id || null);
    this.newItemProductId.set(doc.normalized_id || null);
    this.showProductList.set(false);
    this.lockItemFields.set(true);
    this.catalogVariantOptions.set([...new Set(variants)]);
    this.catalogColorOptions.set(colors);
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.selectedPreviewHasColorImage.set(Boolean(colorImage));
    this.selectedPreview.set({
      title: this.newItemTitle(),
      variant: this.newItemVariant(),
      color: this.newItemColor(),
      image,
      source: "CatÃƒÂ¡logo",
    });
    this.selectedCatalogDoc.set(doc);
  }

  closeProductListSoon() {
    if (this.suppressProductBlur()) {
      this.suppressProductBlur.set(false);
      return;
    }
    setTimeout(() => this.showProductList.set(false), 120);
  }

  beginProductPick() {
    this.suppressProductBlur.set(true);
  }

  onVariantChange(value: string) {
    this.newItemVariant.set(value);
    const doc = this.selectedCatalogDoc();
    if (!doc) return;
    const listing: any = doc.listing || { items: [] };
    const variant = (listing.items || []).find((it: any) => it.variant_name === value) || null;
    if (!variant) return;
    const prices = this.getVariantPriceSet(variant);
    this.newItemPricePublic.set(prices.final);
    this.newItemPriceClienta.set(this.computeClientaPrice(prices.final));
    this.newItemPriceCost.set(prices.costo);
    this.updatePriceDraftFromSignals();

    const colors = this.getVariantColors(variant);
    this.catalogColorOptions.set(colors);
    const currentColor = this.newItemColor().trim();
    if (colors.length > 0) {
      const nextColor = colors.find((c: string) => c.toLowerCase() === currentColor.toLowerCase()) || colors[0];
      this.newItemColor.set(nextColor);
    }
    const selectedColor = this.newItemColor().trim();
    const colorImage = this.resolveColorImage(doc, selectedColor);
    const image = colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    const hasColorImage = Boolean(colorImage);
    this.selectedPreviewHasColorImage.set(hasColorImage);
    this.selectedPreview.update((prev) =>
      prev
        ? {
            ...prev,
            variant: value,
            color: selectedColor,
            image,
          }
        : prev
    );
  }

  onColorChange(value: string) {
    this.newItemColor.set(value);
    const doc = this.selectedCatalogDoc();
    if (!doc) return;
    const listing: any = doc.listing || { items: [] };
    const variant = (listing.items || []).find((it: any) => (it.variant_name || "") === this.newItemVariant()) || null;
    const colorImage = this.resolveColorImage(doc, value);
    const image = colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    const hasColorImage = Boolean(colorImage);
    this.selectedPreviewHasColorImage.set(hasColorImage);
    this.selectedPreview.update((prev) =>
      prev
        ? {
            ...prev,
            color: value,
            image,
          }
        : prev
    );
  }

  private getVariantColors(variant: any): string[] {
    const fromColorStock = (variant?.color_stock || []).map((entry: any) => entry?.color_name);
    const fromColorNames = Array.isArray(variant?.color_names) ? variant.color_names : [];
    const fromLegacy = Array.isArray(variant?.colors) ? variant.colors : [];
    const all = [...fromColorStock, ...fromColorNames, ...fromLegacy]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    return Array.from(new Set(all));
  }

  private resolveColorImage(doc: NormalizedListingDoc, colorName: string | null | undefined): string | null {
    const target = (colorName || "").trim().toLowerCase();
    if (!target) return null;
    return (
      (doc.product_colors || []).find((c) => (c.name || "").trim().toLowerCase() === target)?.image_url || null
    );
  }

  private getVariantPriceSet(variant: any): { final: number | null; clienta: number | null; costo: number | null } {
    const prices = variant?.prices;
    if (Array.isArray(prices)) {
      const amount = prices[0]?.amount;
      return {
        final: typeof amount === "number" ? amount : null,
        clienta: null,
        costo: null,
      };
    }
    if (prices && typeof prices === "object") {
      return {
        final: typeof prices.precio_final === "number" ? prices.precio_final : null,
        clienta: typeof prices.precio_clienta === "number" ? prices.precio_clienta : null,
        costo: typeof prices.precio_costo === "number" ? prices.precio_costo : null,
      };
    }
    return { final: null, clienta: null, costo: null };
  }

  priceDisplayValue(field: "final" | "clienta" | "costo"): string {
    if (this.priceInputFocused() === field) {
      return this.priceInputDraft()[field];
    }
    const value = this.getPriceValue(field);
    return this.formatThousands(value);
  }

  onPriceInputFocus(field: "final" | "clienta" | "costo") {
    this.priceInputFocused.set(field);
    const current = this.getPriceValue(field);
    this.priceInputDraft.update((draft) => ({
      ...draft,
      [field]: current === null ? "" : String(current),
    }));
  }

  onPriceInputChange(field: "final" | "clienta" | "costo", raw: string) {
    this.priceInputDraft.update((draft) => ({ ...draft, [field]: raw }));
    this.setPriceValue(field, this.parseMoney(raw));
  }

  onPriceInputBlur(field: "final" | "clienta" | "costo") {
    const raw = this.priceInputDraft()[field];
    this.setPriceValue(field, this.parseMoney(raw));
    this.priceInputFocused.set(null);
    this.updatePriceDraftFromSignals();
    if (field === "final" || field === "costo") {
      this.warnIfClientaBelowCosto();
    }
  }

  priceRuleInvalid(): boolean {
    return this.isClientaBelowCosto();
  }

  private updatePriceDraftFromSignals() {
    this.priceInputDraft.set({
      final: this.newItemPricePublic() === null ? "" : String(this.newItemPricePublic()),
      clienta: this.newItemPriceClienta() === null ? "" : String(this.newItemPriceClienta()),
      costo: this.newItemPriceCost() === null ? "" : String(this.newItemPriceCost()),
    });
  }

  private getPriceValue(field: "final" | "clienta" | "costo"): number | null {
    if (field === "final") return this.newItemPricePublic();
    if (field === "clienta") return this.newItemPriceClienta();
    return this.newItemPriceCost();
  }

  private setPriceValue(field: "final" | "clienta" | "costo", value: number | null) {
    if (field === "final") {
      this.newItemPricePublic.set(value);
      this.newItemPriceClienta.set(this.computeClientaPrice(value));
      return;
    }
    if (field === "clienta") {
      this.newItemPriceClienta.set(value);
      return;
    }
    this.newItemPriceCost.set(value);
  }

  private parseMoney(raw: string): number | null {
    const normalized = (raw || "").replace(/,/g, "").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Number(parsed.toFixed(2));
  }

  private formatThousands(value: number | null): string {
    if (value === null || value === undefined || Number.isNaN(value)) return "";
    return new Intl.NumberFormat("es-MX", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  }

  private computeClientaPrice(finalPrice: number | null): number | null {
    if (finalPrice === null || finalPrice === undefined || Number.isNaN(finalPrice)) return null;
    return Number((finalPrice * 0.75).toFixed(2));
  }

  private isClientaBelowCosto(): boolean {
    const clienta = this.newItemPriceClienta();
    const costo = this.newItemPriceCost();
    if (clienta === null || costo === null) return false;
    return clienta < costo;
  }

  private warnIfClientaBelowCosto() {
    if (!this.isClientaBelowCosto()) return;
    alert("Precio clienta no puede ser menor a precio costo.");
  }

  formatCurrency(value: number | null): string {
    if (value === null || value === undefined || Number.isNaN(value)) return "";
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(value);
  }

  itemPriceLabel(item: OrderItem): string {
    const value = item.price_clienta ?? item.price_public ?? item.price_cost ?? null;
    if (value === null || value === undefined || Number.isNaN(value)) return "Sin precio";
    return this.formatCurrency(value);
  }
}


