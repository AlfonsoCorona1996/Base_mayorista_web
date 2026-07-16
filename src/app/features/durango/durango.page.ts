import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { CustomersService } from "../../core/customers.service";
import { CollectionMethod, Order, OrdersService } from "../../core/orders.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { Shipment, ShipmentItem, ShipmentsService } from "../../core/shipments.service";
import { businessShortLabel } from "../../core/rbac.constants";
import { OperationalExpenseCategory, OperationalExpenseReportsService } from "../../core/operational-expense-reports.service";

type DurangoTab = "recibir" | "empacar" | "entregar" | "cobrar" | "dinero" | "historial";
type DeliveryHolderFilter = "todos" | "lupita" | "briselda" | "entregados" | "no_entregados" | "cobros";
type ReceiveRow = { shipment: Shipment; item: ShipmentItem };
type ContentRow = { title: string; quantity: number; detail: string };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-durango-page",
  imports: [FormsModule],
  templateUrl: "./durango.page.html",
  styleUrl: "./durango.page.css",
})
export default class DurangoPage {
  private shipments = inject(ShipmentsService);
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private expenseReports = inject(OperationalExpenseReportsService);
  private router = inject(Router);

  tab = signal<DurangoTab>("recibir");
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  toast = signal<string | null>(null);
  expandedContent = signal<Record<string, boolean>>({});
  deliveryFilter = signal<DeliveryHolderFilter>("todos");
  deliveryIssueOrder = signal<Order | null>(null);
  deliveryIssueReason = signal("");

  collectionOrder = signal<Order | null>(null);
  collectionAmount = signal("");
  collectionMethod = signal<CollectionMethod>("efectivo");
  collectionNote = signal("");
  expenseOpen = signal(false);
  expenseOrder = signal<Order | null>(null);
  expenseCategory = signal<OperationalExpenseCategory>("taxi");
  expenseAmount = signal("");
  expenseNote = signal("");

  readonly moneyFormatter = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

  readonly receiveRows = computed<ReceiveRow[]>(() =>
    this.shipments
      .activeShipments()
      .filter((shipment) => shipment.destination_location === "durango" && (shipment.status === "sent" || shipment.status === "partial_received"))
      .flatMap((shipment) =>
        shipment.items
          .filter((item) => item.status === "pending" || item.status === "sent")
          .map((item) => ({ shipment, item })),
      ),
  );

  readonly durangoOrders = computed(() =>
    this.orders
      .list()
      .filter((order) => !["cancelado", "devuelto", "closed"].includes(order.status))
      .filter((order) => order.current_holder_location === "durango" || order.custody_status === "durango" || order.current_holder_location === "delivery_staff" || order.custody_status === "delivery_staff"),
  );

  readonly packRows = computed(() =>
    this.durangoOrders().filter((order) => order.fulfillment_status !== "packed_durango" && order.delivery_status !== "delivered"),
  );

  readonly deliveryRows = computed(() =>
    this.durangoOrders().filter((order) => order.fulfillment_status === "packed_durango" && order.delivery_status !== "delivered"),
  );

  readonly deliveryRowsFiltered = computed(() => {
    const filter = this.deliveryFilter();
    const rows = this.durangoOrders().filter((order) => order.fulfillment_status === "packed_durango" || order.custody_status === "delivery_staff");
    return rows.filter((order) => {
      if (filter === "todos") return order.delivery_status !== "delivered";
      if (filter === "lupita") return order.delivery_status !== "delivered" && this.currentHolderName(order) !== "Briselda";
      if (filter === "briselda") return order.delivery_status !== "delivered" && this.currentHolderName(order) === "Briselda";
      if (filter === "entregados") return order.delivery_status === "delivered";
      if (filter === "no_entregados") return order.delivery_status === "not_delivered" || order.delivery_status === "incident";
      return Number(order.totals?.paid_amount || 0) > 0 && order.settlement_status !== "reconciled";
    });
  });

  readonly collectionRows = computed(() =>
    this.orders
      .list()
      .filter((order) => !["cancelado", "devuelto", "closed"].includes(order.status))
      .filter((order) => ["durango", "delivery_staff", "customer"].includes(order.current_holder_location || ""))
      .filter((order) => calculateOrderFinancials(order).balanceDue > 0),
  );

  readonly moneyRows = computed(() =>
    this.orders
      .list()
      .filter((order) => Number(order.totals?.paid_amount || 0) > 0)
      .filter((order) => order.settlement_status === "pending" || order.settlement_status === "difference")
      .filter((order) => ["durango", "delivery_staff", "customer"].includes(order.current_holder_location || "") || order.custody_status === "customer"),
  );

  readonly historyRows = computed(() =>
    this.orders
      .list()
      .filter((order) => order.delivery_status === "delivered" || order.settlement_status === "sent_to_gdl" || order.settlement_status === "reconciled")
      .slice(0, 30),
  );

  readonly counts = computed(() => ({
    recibir: this.receiveRows().length,
    empacar: this.packRows().length,
    entregar: this.deliveryRowsFiltered().length,
    cobrar: this.collectionRows().length,
    dinero: this.moneyRows().length,
    historial: this.historyRows().length,
  }));

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
        this.expenseReports.loadAll().catch(() => null),
      ]);
      this.shipments.watch();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar operación Durango.");
    } finally {
      this.loading.set(false);
    }
  }

  setTab(tab: DurangoTab) {
    this.tab.set(tab);
  }

  async markReceived(row: ReceiveRow) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.shipments.updateItemStatus(row.shipment.shipment_id, row.item.item_id, "received");
      await this.orders.updateOperationalState(
        row.item.order_id,
        {
          custody_status: "durango",
          current_holder_location: "durango",
          current_holder_name: "Lupita",
          shipment_id: row.shipment.shipment_id,
        },
        "Artículo/paquete recibido en Durango",
      );
      this.toast.set("Recibido en Durango.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo marcar recibido.");
    } finally {
      this.saving.set(false);
    }
  }

  async markPacked(order: Order) {
    await this.updateOrderState(order, {
      fulfillment_status: "packed_durango",
      custody_status: "durango",
      current_holder_location: "durango",
      current_holder_name: "Lupita",
    }, "Pedido empacado en Durango", "Pedido marcado como empacado.");
  }

  async assignDelivery(order: Order) {
    await this.updateOrderState(order, {
      custody_status: "delivery_staff",
      current_holder_location: "delivery_staff",
      current_holder_name: "Briselda",
    }, "Pedido entregado a Briselda", "Pedido en custodia de Briselda.");
  }

  async returnToLupita(order: Order) {
    await this.updateOrderState(order, {
      custody_status: "durango",
      current_holder_location: "durango",
      current_holder_name: "Lupita",
    }, "Pedido regresó a Lupita", "Pedido regresó a custodia de Lupita.");
  }

  async markDelivered(order: Order) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.orders.markOrderDelivered(order.order_id, "Entregado por operación Durango");
      this.toast.set("Entregado. El cobro sigue separado.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo marcar entregado.");
    } finally {
      this.saving.set(false);
    }
  }

  openNotDelivered(order: Order) {
    this.deliveryIssueOrder.set(order);
    this.deliveryIssueReason.set("");
  }

  closeNotDelivered() {
    if (this.saving()) return;
    this.deliveryIssueOrder.set(null);
    this.deliveryIssueReason.set("");
  }

  async markNotDelivered(order: Order, reason = this.deliveryIssueReason()) {
    if (this.saving()) return;
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) {
      this.error.set("Agrega el motivo de no entrega.");
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.orders.markOrderDeliveryIssue(order.order_id, "not_delivered", `No entregado por operación Durango: ${cleanReason}`);
      this.deliveryIssueOrder.set(null);
      this.toast.set("Pedido marcado como no entregado.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo marcar no entregado.");
    } finally {
      this.saving.set(false);
    }
  }

  openCollection(order: Order) {
    const balance = calculateOrderFinancials(order).balanceDue;
    this.collectionOrder.set(order);
    this.collectionAmount.set(balance > 0 ? String(balance) : "");
    this.collectionMethod.set("efectivo");
    this.collectionNote.set("");
  }

  closeCollection() {
    if (this.saving()) return;
    this.collectionOrder.set(null);
    this.collectionAmount.set("");
    this.collectionNote.set("");
  }

  async saveCollection() {
    const order = this.collectionOrder();
    if (!order || this.saving()) return;
    const amount = Number(String(this.collectionAmount()).replace(/,/g, "").trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      this.error.set("Ingresa el monto cobrado.");
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.orders.registerCustomerCollection(
        order.order_id,
        amount,
        this.collectionMethod(),
        this.currentHolderName(order) || "Durango",
        this.collectionNote().trim() || null,
        {
          sourceLocation: "durango",
          verificationStatus: "reported",
          reportedByName: this.currentHolderName(order) || "Durango",
        },
      );
      this.collectionOrder.set(null);
      this.toast.set("Cobro reportado. Falta validar dinero en GDL.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo registrar el cobro.");
    } finally {
      this.saving.set(false);
    }
  }

  openExpense(order?: Order | null) {
    this.expenseOrder.set(order || null);
    this.expenseCategory.set("taxi");
    this.expenseAmount.set("");
    this.expenseNote.set("");
    this.expenseOpen.set(true);
  }

  closeExpense() {
    this.expenseOpen.set(false);
    this.expenseOrder.set(null);
    this.expenseAmount.set("");
    this.expenseNote.set("");
  }

  async saveExpenseReport() {
    if (this.saving()) return;
    const amount = Number(String(this.expenseAmount()).replace(/,/g, "").trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      this.error.set("Ingresa el monto del gasto.");
      return;
    }
    const order = this.expenseOrder();
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.expenseReports.createReport({
        business_id: order?.business_id,
        category: this.expenseCategory(),
        amount,
        order_id: order?.order_id || null,
        shipment_id: order?.shipment_id || null,
        route_id: order?.route_id || null,
        note: this.expenseNote().trim() || null,
        reported_by_name: "Durango",
      });
      this.closeExpense();
      this.toast.set("Gasto reportado. Queda pendiente de aprobación GDL.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo registrar gasto.");
    } finally {
      this.saving.set(false);
    }
  }

  async markMoneySent(order: Order) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.orders.markSettlement(order.order_id, "sent_to_gdl", "Dinero enviado desde Durango");
      this.toast.set("Dinero marcado como enviado a GDL.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo marcar dinero enviado.");
    } finally {
      this.saving.set(false);
    }
  }

  openOrder(orderId: string) {
    this.router.navigateByUrl(`/main/pedidos/${orderId}`).catch(() => null);
  }

  customerName(order: Order | null | undefined): string {
    if (!order) return "Clienta";
    const customer = this.customers.getById(order.customer_id);
    return customer ? `${customer.first_name} ${customer.last_name}`.trim() || "Clienta" : "Clienta";
  }

  money(value: number): string {
    return this.moneyFormatter.format(Number(value || 0));
  }

  orderBalance(order: Order): number {
    return calculateOrderFinancials(order).balanceDue;
  }

  orderPaid(order: Order): number {
    return Number(order.totals?.paid_amount || 0);
  }

  businessLabel(order: Order | ShipmentItem): string {
    return businessShortLabel(order.business_id);
  }

  toggleContent(key: string) {
    this.expandedContent.update((current) => ({ ...current, [key]: !current[key] }));
  }

  isContentOpen(key: string): boolean {
    return !!this.expandedContent()[key];
  }

  receiveContent(row: ReceiveRow): ContentRow[] {
    return this.itemContent(row.item);
  }

  orderContent(order: Order): ContentRow[] {
    return (order.items || []).map((item) => ({
      title: item.title || "Producto",
      quantity: Number(item.quantity || 1),
      detail: [item.variant, item.color].filter(Boolean).join(" · "),
    }));
  }

  itemContent(item: ShipmentItem): ContentRow[] {
    if (Array.isArray(item.contents) && item.contents.length > 0) {
      return item.contents.map((row) => ({
        title: row.title || "Producto",
        quantity: Number(row.quantity || 1),
        detail: [row.variant, row.color].filter(Boolean).join(" · "),
      }));
    }
    return [{ title: item.title || "Artículo", quantity: Number(item.quantity || 1), detail: item.notes || "" }];
  }

  currentHolderName(order: Order): string {
    return (order.current_holder_name || (order.custody_status === "durango" ? "Lupita" : "")).trim();
  }

  holderLabel(order: Order): string {
    if (order.delivery_status === "delivered") return "Clienta recibió";
    const holder = this.currentHolderName(order);
    if (holder === "Briselda") return "Con Briselda";
    if (holder === "Lupita" || order.custody_status === "durango") return "En Durango / Lupita";
    return holder ? `Con ${holder}` : "En Durango";
  }

  categoryLabel(category: OperationalExpenseCategory): string {
    return this.expenseReports.categoryLabel(category);
  }

  expenseSubtitle(): string {
    const order = this.expenseOrder();
    return order ? `${this.customerName(order)} · ${this.businessLabel(order)}` : "Gasto operativo Durango";
  }

  private async updateOrderState(
    order: Order,
    patch: Parameters<OrdersService["updateOperationalState"]>[1],
    eventMessage: string,
    toast: string,
  ) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.orders.updateOperationalState(order.order_id, patch, eventMessage);
      this.toast.set(toast);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar pedido.");
    } finally {
      this.saving.set(false);
    }
  }
}
