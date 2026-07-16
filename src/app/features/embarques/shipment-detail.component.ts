import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { Shipment, ShipmentItem } from "../../core/shipments.service";
import { businessShortLabel } from "../../core/rbac.constants";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-shipment-detail",
  templateUrl: "./shipment-detail.component.html",
  styleUrl: "./shipment-detail.component.css",
})
export class ShipmentDetailComponent {
  readonly shipment = input.required<Shipment>();
  readonly saving = input(false);

  readonly close = output<void>();
  readonly receive = output<Shipment>();
  readonly send = output<Shipment>();
  readonly openOrder = output<string>();

  private readonly dateTimeFormatter = new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  primaryItem(): ShipmentItem | null {
    return this.shipment().items[0] || null;
  }

  customerName(): string {
    return this.primaryItem()?.customer_name || "Clienta sin nombre";
  }

  orderLabel(): string {
    const orderId = this.primaryItem()?.order_id?.trim();
    return orderId ? `Pedido ${orderId}` : "Pedido sin número";
  }

  locationLabel(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "gdl") return "GDL";
    if (normalized === "durango") return "Durango";
    return value.trim() || "Sin definir";
  }

  orderCount(): number {
    return new Set(this.shipment().items.map((item) => item.order_id).filter(Boolean)).size;
  }

  packageCount(): number {
    return this.shipment().items.filter((item) => item.type === "package").length;
  }

  looseCount(): number {
    return this.shipment()
      .items.filter((item) => item.type === "loose_item")
      .reduce((total, item) => total + Number(item.quantity || 0), 0);
  }

  contentSummary(): string {
    return [
      this.countLabel(this.orderCount(), "pedido", "pedidos"),
      this.countLabel(this.packageCount(), "paquete", "paquetes"),
      this.countLabel(this.looseCount(), "artículo suelto", "artículos sueltos"),
    ].join(" · ");
  }

  businessLabels(): string {
    const labels = new Set(this.shipment().items.map((item) => businessShortLabel(item.business_id)));
    return Array.from(labels).join(" · ") || "Sin tipo";
  }

  statusLabel(): string {
    if (this.shipment().items.some((item) => item.status === "incident")) return "Con incidencia";
    const labels: Record<Shipment["status"], string> = {
      draft: "Preparando",
      sent: "En tránsito",
      partial_received: "Por recibir",
      received: "Recibido en Durango",
      closed: "Cerrado",
    };
    return labels[this.shipment().status];
  }

  statusClass(): string {
    if (this.shipment().items.some((item) => item.status === "incident")) return "status-incident";
    return `status-${this.shipment().status}`;
  }

  statusIcon(): string {
    if (this.shipment().items.some((item) => item.status === "incident")) return "warning";
    const icons: Record<Shipment["status"], string> = {
      draft: "inventory_2",
      sent: "local_shipping",
      partial_received: "move_to_inbox",
      received: "check_circle",
      closed: "task_alt",
    };
    return icons[this.shipment().status];
  }

  departureDate(): string {
    return this.formatDate(this.shipment().sent_at, "Sin fecha de salida");
  }

  preparedDate(): string {
    return this.formatDate(this.shipment().created_at, "Sin fecha");
  }

  receivedDate(): string {
    return this.formatDate(this.shipment().received_at, "Sin fecha de recepción");
  }

  canReceive(): boolean {
    return this.shipment().status === "sent" || this.shipment().status === "partial_received";
  }

  canSend(): boolean {
    return this.shipment().status === "draft";
  }

  openPrimaryOrder(): void {
    const orderId = this.primaryItem()?.order_id;
    if (orderId) this.openOrder.emit(orderId);
  }

  private formatDate(value: string | null | undefined, fallback: string): string {
    if (!value) return fallback;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : this.dateTimeFormatter.format(date);
  }

  private countLabel(value: number, singular: string, plural: string): string {
    return `${value} ${value === 1 ? singular : plural}`;
  }
}
