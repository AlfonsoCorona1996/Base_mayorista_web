import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { CustomersService } from "../../core/customers.service";
import { LocalitiesService } from "../../core/localities.service";
import { Order, OrdersService } from "../../core/orders.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { RoutesService } from "../../core/routes.service";
import {
  Shipment,
  ShipmentBusinessSummary,
  ShipmentItem,
  ShipmentLooseInstruction,
  ShipmentsService,
} from "../../core/shipments.service";
import { BusinessId, businessShortLabel, normalizeBusinessId } from "../../core/rbac.constants";
import { ShipmentDetailComponent } from "./shipment-detail.component";

type ShipmentStatusFilter = "all" | "draft" | "sent" | "partial_received" | "received" | "incident";
type ShipmentDateFilter = "all" | "today" | "7d" | "30d";
type ShipmentSortOrder = "recent" | "oldest";

type CandidateOrder = Order & {
  customerName: string;
  routeName: string;
  localityName: string;
  packageCount: number;
  balanceDue: number;
  saleTotal: number;
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-embarques-page",
  imports: [FormsModule, ShipmentDetailComponent],
  templateUrl: "./embarques.page.html",
  styleUrl: "./embarques.page.css",
})
export default class EmbarquesPage {
  private shipments = inject(ShipmentsService);
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private routes = inject(RoutesService);
  private localities = inject(LocalitiesService);
  private router = inject(Router);

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  toast = signal<string | null>(null);
  createOpen = signal(false);
  selectedOrders = signal<Record<string, boolean>>({});
  shipmentTitle = signal("");
  shipmentNotes = signal("");
  looseOrderId = signal("");
  looseOrderItemId = signal("");
  looseInstruction = signal<ShipmentLooseInstruction>("add_to_package");
  looseNotes = signal("");
  looseDrafts = signal<ShipmentItem[]>([]);
  routeFilter = signal("all");
  searchTerm = signal("");
  statusFilter = signal<ShipmentStatusFilter>("all");
  dateFilter = signal<ShipmentDateFilter>("all");
  originFilter = signal("all");
  destinationFilter = signal("all");
  businessFilter = signal<"all" | BusinessId>("all");
  sortOrder = signal<ShipmentSortOrder>("recent");
  filterSheetOpen = signal(false);
  detailShipmentId = signal<string | null>(null);
  actionMenuShipmentId = signal<string | null>(null);

  readonly shipmentRows = computed(() => this.shipments.rows());
  readonly activeShipments = computed(() => this.shipmentRows().filter((row) => row.status !== "closed"));
  readonly completedShipments = computed(() => this.shipmentRows().filter((row) => row.status === "closed").slice(0, 20));
  readonly moneyFormatter = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
  readonly dateTimeFormatter = new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  readonly activeShipmentOrderIds = computed(() => {
    const ids = new Set<string>();
    for (const shipment of this.activeShipments()) {
      for (const item of shipment.items || []) {
        if (item.order_id) ids.add(item.order_id);
      }
    }
    return ids;
  });

  readonly locationOptions = computed(() => {
    const origins = new Set<string>();
    const destinations = new Set<string>();
    for (const shipment of this.activeShipments()) {
      if (shipment.origin_location) origins.add(shipment.origin_location);
      if (shipment.destination_location) destinations.add(shipment.destination_location);
    }
    return {
      origins: Array.from(origins).sort((a, b) => a.localeCompare(b, "es")),
      destinations: Array.from(destinations).sort((a, b) => a.localeCompare(b, "es")),
    };
  });

  readonly filteredShipments = computed(() => {
    const term = this.searchTerm().trim().toLocaleLowerCase("es");
    const status = this.statusFilter();
    const dateFilter = this.dateFilter();
    const origin = this.originFilter();
    const destination = this.destinationFilter();
    const business = this.businessFilter();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const minimumDate =
      dateFilter === "today"
        ? startOfToday
        : dateFilter === "7d"
          ? now.getTime() - 7 * 24 * 60 * 60 * 1000
          : dateFilter === "30d"
            ? now.getTime() - 30 * 24 * 60 * 60 * 1000
            : null;

    return this.activeShipments()
      .filter((shipment) => {
        if (!term) return true;
        const searchable = [
          shipment.origin_location,
          shipment.destination_location,
          ...shipment.items.flatMap((item) => [item.customer_name, item.order_id]),
        ]
          .join(" ")
          .toLocaleLowerCase("es");
        return searchable.includes(term);
      })
      .filter((shipment) => {
        if (status === "all") return true;
        if (status === "incident") return this.hasShipmentIncident(shipment);
        return shipment.status === status;
      })
      .filter((shipment) => {
        if (minimumDate === null) return true;
        const value = shipment.sent_at || shipment.created_at;
        const timestamp = new Date(value).getTime();
        return !Number.isNaN(timestamp) && timestamp >= minimumDate;
      })
      .filter((shipment) => origin === "all" || shipment.origin_location === origin)
      .filter((shipment) => destination === "all" || shipment.destination_location === destination)
      .filter(
        (shipment) => business === "all" || shipment.items.some((item) => item.business_id === business),
      )
      .sort((a, b) => {
        const aTime = new Date(a.sent_at || a.created_at).getTime();
        const bTime = new Date(b.sent_at || b.created_at).getTime();
        return this.sortOrder() === "recent" ? bTime - aTime : aTime - bTime;
      });
  });

  readonly selectedShipment = computed(() => {
    const shipmentId = this.detailShipmentId();
    return shipmentId ? this.activeShipments().find((shipment) => shipment.shipment_id === shipmentId) || null : null;
  });

  readonly hasActiveFilters = computed(
    () =>
      !!this.searchTerm().trim() ||
      this.statusFilter() !== "all" ||
      this.dateFilter() !== "all" ||
      this.originFilter() !== "all" ||
      this.destinationFilter() !== "all" ||
      this.businessFilter() !== "all",
  );

  readonly routeOptions = computed(() => {
    const activeIds = new Set(this.allCandidates().map((order) => order.route_id || "sin_ruta"));
    const options = Array.from(activeIds).map((routeId) => ({
      routeId,
      name: routeId === "sin_ruta" ? "Sin ruta" : this.routes.getById(routeId)?.name || "Ruta sin nombre",
    }));
    return options.sort((a, b) => a.name.localeCompare(b.name, "es"));
  });

  readonly allCandidates = computed<CandidateOrder[]>(() =>
    this.orders
      .list()
      .filter((order) => this.canShipOrder(order))
      .filter((order) => !this.activeShipmentOrderIds().has(order.order_id))
      .map((order) => {
        const customer = this.customers.getById(order.customer_id);
        const financials = calculateOrderFinancials(order);
        const routeName = order.route_id ? this.routes.getById(order.route_id)?.name || "Ruta sin nombre" : "Sin ruta";
        const localityName = customer?.locality_id ? this.localities.getById(customer.locality_id)?.name || "Localidad sin nombre" : "Sin localidad";
        const closedPackagesCount = (order.packages || []).filter((pkg) => pkg.status === "closed" || pkg.state === "armado" || pkg.state === "closed").length;
        return {
          ...order,
          customerName: customer ? `${customer.first_name} ${customer.last_name}`.trim() || "Clienta" : "Clienta",
          routeName,
          localityName,
          packageCount: Math.max(1, closedPackagesCount),
          balanceDue: financials.balanceDue,
          saleTotal: financials.netAmount,
        };
      }),
  );

  readonly candidates = computed<CandidateOrder[]>(() => {
    const routeId = this.routeFilter();
    return this.allCandidates().filter((order) => routeId === "all" || (order.route_id || "sin_ruta") === routeId);
  });

  readonly selectedCandidateOrders = computed(() =>
    this.candidates().filter((order) => this.selectedOrders()[order.order_id]),
  );

  readonly kpis = computed(() => {
    const active = this.activeShipments();
    const inTransit = active.filter((row) => row.status === "sent" || row.status === "partial_received").length;
    const pendingReceive = active.filter((row) => row.status === "partial_received").length;
    const packages = active.reduce((sum, row) => sum + row.items.filter((item) => item.type === "package").length, 0);
    const incidents = active.reduce(
      (sum, row) => sum + row.items.filter((item) => item.status === "incident").length,
      0,
    );
    return { active: active.length, inTransit, pendingReceive, packages, incidents };
  });

  constructor() {
    this.refresh().catch(() => null);
  }

  async refresh() {
    this.loading.set(true);
    this.error.set(null);
    try {
      await Promise.all([
        this.orders.loadFromFirestore(),
        this.customers.loadFromFirestore(),
        this.routes.loadFromFirestore(),
        this.localities.loadFromFirestore(),
      ]);
      this.shipments.watch();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar embarques.");
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.selectedOrders.set({});
    this.shipmentTitle.set("");
    this.shipmentNotes.set("");
    this.looseDrafts.set([]);
    this.looseOrderId.set("");
    this.looseOrderItemId.set("");
    this.looseNotes.set("");
    this.routeFilter.set("all");
    this.createOpen.set(true);
  }

  closeCreate() {
    if (this.saving()) return;
    this.createOpen.set(false);
  }

  toggleOrder(orderId: string, checked: boolean) {
    this.selectedOrders.update((current) => ({ ...current, [orderId]: checked }));
  }

  selectedOrderItems(): Order["items"] {
    const order = this.candidates().find((row) => row.order_id === this.looseOrderId());
    return order?.items || [];
  }

  addLooseItem() {
    const order = this.candidates().find((row) => row.order_id === this.looseOrderId());
    const item = order?.items.find((row) => row.item_id === this.looseOrderItemId());
    if (!order || !item) {
      this.error.set("Selecciona pedido y artículo suelto.");
      return;
    }
    this.looseDrafts.update((current) => [
      ...current,
      {
        item_id: `loose-${order.order_id}-${item.item_id}-${Date.now()}`,
        type: "loose_item",
        status: "pending",
        order_id: order.order_id,
        business_id: order.business_id,
        customer_id: order.customer_id,
        customer_name: order.customerName,
        title: item.title,
        quantity: Number(item.quantity || 1),
        instruction: this.looseInstruction(),
        notes: this.looseNotes().trim() || null,
      },
    ]);
    this.looseOrderItemId.set("");
    this.looseNotes.set("");
  }

  removeLooseItem(itemId: string) {
    this.looseDrafts.update((current) => current.filter((item) => item.item_id !== itemId));
  }

  async createShipment() {
    if (this.saving()) return;
    const selected = this.selectedCandidateOrders();
    const loose = this.looseDrafts();
    if (selected.length === 0 && loose.length === 0) {
      this.error.set("Selecciona al menos un pedido o artículo suelto.");
      return;
    }
    const blockedOrderIds = new Set<string>();
    for (const order of selected) {
      if (this.activeShipmentOrderIds().has(order.order_id)) blockedOrderIds.add(order.order_id);
    }
    for (const item of loose) {
      if (item.order_id && this.activeShipmentOrderIds().has(item.order_id)) blockedOrderIds.add(item.order_id);
    }
    if (blockedOrderIds.size > 0) {
      this.error.set("Uno de los pedidos ya está en un embarque activo. Actualiza la lista y revisa el embarque existente.");
      this.selectedOrders.update((current) => {
        const next = { ...current };
        for (const orderId of blockedOrderIds) delete next[orderId];
        return next;
      });
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const items = [...selected.flatMap((order) => this.packageItemsForOrder(order)), ...loose];
      if (items.length === 0) {
        this.error.set("No hay paquetes cerrados ni artículos sueltos para embarcar.");
        return;
      }
      const summaries = this.businessSummariesFor(selected, loose);
      const shipmentId = await this.shipments.createShipment({
        title: this.shipmentTitle(),
        notes: this.shipmentNotes(),
        destination_location: "durango",
        items,
        business_summaries: summaries,
      });
      await Promise.all(
        Array.from(new Set(items.map((item) => item.order_id).filter(Boolean))).map((orderId) =>
          this.orders.updateOperationalState(
            orderId,
            { shipment_id: shipmentId },
            "Pedido preparado en embarque GDL-Durango",
          ),
        ),
      );
      this.toast.set("Embarque creado en proceso.");
      this.createOpen.set(false);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo crear el embarque.");
    } finally {
      this.saving.set(false);
    }
  }

  async sendShipment(shipment: Shipment) {
    if (this.saving()) return;
    if (this.isShipmentDuplicate(shipment)) {
      this.error.set("Este embarque tiene un pedido que ya está en otro embarque activo. Cierra el duplicado o usa el embarque original.");
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const items = shipment.items.map((item) => ({ ...item, status: item.status === "pending" ? "sent" as const : item.status }));
      await this.shipments.saveItems(shipment.shipment_id, items);
      await this.shipments.updateStatus(shipment.shipment_id, "sent");
      await Promise.all(
        Array.from(new Set(items.map((item) => item.order_id).filter(Boolean))).map((orderId) =>
          this.orders.updateOperationalState(
            orderId,
            {
              shipment_id: shipment.shipment_id,
              custody_status: "shipment",
              current_holder_location: "in_transit",
            },
            "Embarque enviado GDL-Durango",
          ),
        ),
      );
      this.toast.set("Embarque marcado como enviado.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo enviar el embarque.");
    } finally {
      this.saving.set(false);
    }
  }

  async receiveShipment(shipment: Shipment) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const items = shipment.items.map((item) => ({
        ...item,
        status: item.status === "pending" || item.status === "sent" ? "received" as const : item.status,
      }));
      await this.shipments.saveItems(shipment.shipment_id, items);
      await this.shipments.updateStatus(shipment.shipment_id, "received");
      await Promise.all(
        Array.from(new Set(items.map((item) => item.order_id).filter(Boolean))).map((orderId) =>
          this.orders.updateOperationalState(
            orderId,
            {
              custody_status: "durango",
              current_holder_location: "durango",
            },
            "Embarque recibido en Durango",
          ),
        ),
      );
      this.toast.set("Embarque recibido en Durango.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo recibir el embarque.");
    } finally {
      this.saving.set(false);
    }
  }

  async closeShipment(shipment: Shipment) {
    await this.shipments.updateStatus(shipment.shipment_id, "closed");
    this.toast.set("Embarque cerrado.");
  }

  isShipmentDuplicate(shipment: Shipment): boolean {
    return this.duplicatedOrderIdsForShipment(shipment).length > 0;
  }

  duplicatedOrderIdsForShipment(shipment: Shipment): string[] {
    const orderIds = Array.from(new Set((shipment.items || []).map((item) => item.order_id).filter(Boolean)));
    return orderIds.filter((orderId) => this.primaryShipmentIdForOrder(orderId) !== shipment.shipment_id);
  }

  duplicateLabel(shipment: Shipment): string {
    const count = this.duplicatedOrderIdsForShipment(shipment).length;
    return count === 1 ? "Pedido duplicado" : `${count} pedidos duplicados`;
  }

  openOrder(orderId: string) {
    this.router.navigateByUrl(`/main/pedidos/${orderId}`).catch(() => null);
  }

  money(value: number): string {
    return this.moneyFormatter.format(Number(value || 0));
  }

  openDetail(shipment: Shipment): void {
    this.actionMenuShipmentId.set(null);
    this.detailShipmentId.set(shipment.shipment_id);
  }

  closeDetail(): void {
    this.detailShipmentId.set(null);
  }

  toggleActionMenu(shipmentId: string, event: Event): void {
    event.stopPropagation();
    this.actionMenuShipmentId.update((current) => (current === shipmentId ? null : shipmentId));
  }

  closeActionMenu(): void {
    this.actionMenuShipmentId.set(null);
  }

  clearFilters(): void {
    this.searchTerm.set("");
    this.statusFilter.set("all");
    this.dateFilter.set("all");
    this.originFilter.set("all");
    this.destinationFilter.set("all");
    this.businessFilter.set("all");
    this.sortOrder.set("recent");
  }

  removeStatusFilter(): void {
    this.statusFilter.set("all");
  }

  removeDestinationFilter(): void {
    this.destinationFilter.set("all");
  }

  primaryShipmentItem(shipment: Shipment): ShipmentItem | null {
    return shipment.items[0] || null;
  }

  shipmentCustomerName(shipment: Shipment): string {
    return this.primaryShipmentItem(shipment)?.customer_name || "Clienta sin nombre";
  }

  shipmentOrderLabel(shipment: Shipment): string {
    const orderId = this.primaryShipmentItem(shipment)?.order_id?.trim();
    return orderId ? `Pedido ${orderId}` : "Pedido sin número";
  }

  shipmentOrderCount(shipment: Shipment): number {
    return new Set(shipment.items.map((item) => item.order_id).filter(Boolean)).size;
  }

  shipmentPackageCount(shipment: Shipment): number {
    return shipment.items.filter((item) => item.type === "package").length;
  }

  shipmentLooseCount(shipment: Shipment): number {
    return shipment.items
      .filter((item) => item.type === "loose_item")
      .reduce((total, item) => total + Number(item.quantity || 0), 0);
  }

  shipmentContentSummary(shipment: Shipment): string {
    return [
      this.countLabel(this.shipmentOrderCount(shipment), "pedido", "pedidos"),
      this.countLabel(this.shipmentPackageCount(shipment), "paquete", "paquetes"),
      this.countLabel(this.shipmentLooseCount(shipment), "artículo suelto", "artículos sueltos"),
    ].join(" · ");
  }

  shipmentBusinessLabels(shipment: Shipment): string[] {
    return Array.from(new Set(shipment.items.map((item) => this.businessLabel(item.business_id))));
  }

  shipmentDepartureDate(shipment: Shipment): string {
    const value = shipment.sent_at;
    if (!value) return "Sin fecha de salida";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Sin fecha de salida" : this.dateTimeFormatter.format(date);
  }

  locationLabel(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "gdl") return "GDL";
    if (normalized === "durango") return "Durango";
    return value || "Sin ubicación";
  }

  shipmentStatusIcon(status: Shipment["status"]): string {
    const icons: Record<Shipment["status"], string> = {
      draft: "inventory_2",
      sent: "local_shipping",
      partial_received: "move_to_inbox",
      received: "check_circle",
      closed: "task_alt",
    };
    return icons[status];
  }

  shipmentDisplayStatusLabel(shipment: Shipment): string {
    if (this.hasShipmentIncident(shipment)) return "Con incidencia";
    return this.statusLabel(shipment.status);
  }

  shipmentDisplayStatusClass(shipment: Shipment): string {
    return this.hasShipmentIncident(shipment) ? "status-incident" : this.statusClass(shipment.status);
  }

  shipmentDisplayStatusIcon(shipment: Shipment): string {
    return this.hasShipmentIncident(shipment) ? "warning" : this.shipmentStatusIcon(shipment.status);
  }

  businessLabel(value: BusinessId): string {
    return businessShortLabel(value);
  }

  statusLabel(status: Shipment["status"]): string {
    const labels: Record<Shipment["status"], string> = {
      draft: "Preparando",
      sent: "En tránsito",
      partial_received: "Por recibir",
      received: "Recibido en Durango",
      closed: "Cerrado",
    };
    return labels[status];
  }

  itemStatusLabel(status: ShipmentItem["status"]): string {
    const labels: Record<ShipmentItem["status"], string> = {
      pending: "Pendiente",
      sent: "Enviado",
      received: "Recibido",
      packed: "Empacado",
      delivered: "Entregado",
      incident: "Incidencia",
    };
    return labels[status] || "Pendiente";
  }

  statusClass(status: Shipment["status"]): string {
    return `status-${status}`;
  }

  private hasShipmentIncident(shipment: Shipment): boolean {
    return shipment.items.some((item) => item.status === "incident");
  }

  private countLabel(value: number, singular: string, plural: string): string {
    return `${value} ${value === 1 ? singular : plural}`;
  }

  private primaryShipmentIdForOrder(orderId: string): string | null {
    const candidates = this.activeShipments()
      .filter((shipment) => (shipment.items || []).some((item) => item.order_id === orderId))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return candidates[0]?.shipment_id || null;
  }

  private canShipOrder(order: Order): boolean {
    if (["cancelado", "devuelto", "closed"].includes(order.status)) return false;
    if (order.delivery_status === "delivered") return false;
    if (order.custody_status === "customer") return false;
    if ((order.packages || []).length > 0) {
      return (order.packages || []).some((pkg) => pkg.status === "closed" || pkg.state === "armado" || pkg.state === "closed");
    }
    return order.packing?.status === "done" || ["ready_for_route", "assigned_to_run", "packing", "empaque"].includes(order.status);
  }

  private packageItemsForOrder(order: CandidateOrder): ShipmentItem[] {
    const sourcePackages = (order.packages || []).filter((pkg) => pkg.status === "closed" || pkg.state === "armado" || pkg.state === "closed");
    if (!sourcePackages.length && (order.packages || []).length > 0) return [];
    if (!sourcePackages.length) {
      return [
        {
          item_id: `pkg-${order.order_id}-full`,
          type: "package",
          status: "pending",
          order_id: order.order_id,
          business_id: order.business_id,
          customer_id: order.customer_id,
          customer_name: order.customerName,
          package_id: null,
          package_label: "Pedido completo",
          title: "Pedido completo",
          quantity: 1,
          contents: (order.items || []).map((item) => ({
            title: item.title,
            quantity: Number(item.quantity || 1),
            variant: item.variant || null,
            color: item.color || null,
          })),
        },
      ];
    }
    return sourcePackages.map((pkg) => ({
      item_id: `pkg-${order.order_id}-${pkg.package_id}`,
      type: "package",
      status: "pending",
      order_id: order.order_id,
      business_id: order.business_id,
      customer_id: order.customer_id,
      customer_name: order.customerName,
      package_id: pkg.package_id,
      package_label: pkg.label,
      title: pkg.label || "Paquete",
      quantity: 1,
      contents: (pkg.items || []).map((item) => ({
        title: item.name,
        quantity: Number(item.qty || 1),
        variant: item.size || item.variant || null,
        color: item.color || null,
      })),
    }));
  }

  private businessSummariesFor(orders: CandidateOrder[], looseItems: ShipmentItem[]): ShipmentBusinessSummary[] {
    const byBusiness = new Map<BusinessId, ShipmentBusinessSummary>();
    for (const id of ["bm", "catalogo"] as BusinessId[]) {
      byBusiness.set(id, {
        business_id: id,
        orders_total: 0,
        packages_total: 0,
        loose_items_total: 0,
        sale_total: 0,
        balance_due: 0,
      });
    }
    for (const order of orders) {
      const id = normalizeBusinessId(order.business_id);
      const row = byBusiness.get(id)!;
      row.orders_total += 1;
      row.packages_total += Math.max(1, order.packageCount);
      row.sale_total += order.saleTotal;
      row.balance_due += order.balanceDue;
    }
    for (const item of looseItems) {
      const id = normalizeBusinessId(item.business_id);
      const row = byBusiness.get(id)!;
      row.loose_items_total += Number(item.quantity || 0);
      if (!orders.some((order) => order.order_id === item.order_id && order.business_id === id)) {
        row.orders_total += 1;
      }
    }
    return Array.from(byBusiness.values())
      .map((row) => ({ ...row, sale_total: Number(row.sale_total.toFixed(2)), balance_due: Number(row.balance_due.toFixed(2)) }))
      .filter((row) => row.orders_total || row.packages_total || row.loose_items_total || row.sale_total || row.balance_due);
  }
}
