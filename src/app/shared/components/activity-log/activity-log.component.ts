import { CommonModule } from "@angular/common";
import { Component, computed, input, output, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { OrderEvent } from "../../../core/orders.service";

type ActivityCategory = "proveedor" | "inventario" | "estado" | "pagos" | "entrega" | "incidencias" | "sistema";
type ActivityTone = "success" | "warning" | "info" | "danger" | "neutral";

type ActivityEventVM = {
  id: string;
  type: string;
  category: ActivityCategory;
  title: string;
  summary: string;
  absoluteTime: string;
  relativeTime: string;
  userLabel: string;
  tone: ActivityTone;
  icon: string;
  badge: string | null;
  meta: Record<string, any>;
  createdAtDate: Date;
};

type DayGroup = { label: string; items: ActivityEventVM[] };

@Component({
  selector: "app-activity-log",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./activity-log.component.html",
  styleUrl: "./activity-log.component.css",
})
export class ActivityLogComponent {
  events = input<OrderEvent[]>([]);
  hasMore = input(false);
  loading = input(false);
  loadMoreRequested = output<void>();

  selectedCategory = signal<"todos" | ActivityCategory>("todos");
  searchQuery = signal("");
  expandedEventIds = signal<Set<string>>(new Set());
  visibleCount = signal(20);

  readonly filters: Array<{ id: "todos" | ActivityCategory; label: string }> = [
    { id: "todos", label: "Todos" },
    { id: "proveedor", label: "Proveedor" },
    { id: "inventario", label: "Inventario" },
    { id: "estado", label: "Estados" },
    { id: "pagos", label: "Pagos" },
    { id: "entrega", label: "Entrega" },
    { id: "incidencias", label: "Incidencias" },
    { id: "sistema", label: "Sistema" },
  ];

  mappedEvents = computed<ActivityEventVM[]>(() => {
    const rows = this.events() || [];
    return rows
      .map((event) => this.mapEvent(event))
      .sort((a, b) => b.createdAtDate.getTime() - a.createdAtDate.getTime());
  });

  filteredEvents = computed<ActivityEventVM[]>(() => {
    const category = this.selectedCategory();
    const query = this.searchQuery().trim().toLowerCase();
    const rows = this.mappedEvents();

    return rows.filter((row) => {
      if (category !== "todos" && row.category !== category) return false;
      if (!query) return true;

      const metaText = Object.values(row.meta || {})
        .map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : ""))
        .join(" ")
        .toLowerCase();

      const haystack = `${row.title} ${row.summary} ${row.userLabel} ${row.type} ${metaText}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  visibleEvents = computed<ActivityEventVM[]>(() => this.filteredEvents().slice(0, this.visibleCount()));

  groupedVisibleEvents = computed<DayGroup[]>(() => {
    const groups = new Map<string, ActivityEventVM[]>();
    const order: string[] = [];

    for (const event of this.visibleEvents()) {
      const key = this.dayKey(event.createdAtDate);
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(event);
    }

    return order.map((key) => ({
      label: this.dayLabelFromKey(key),
      items: groups.get(key) || [],
    }));
  });

  canShowMoreLocal = computed(() => this.filteredEvents().length > this.visibleCount());

  canRequestMoreRemote = computed(() => !this.canShowMoreLocal() && this.hasMore() && !this.loading());

  onSearchChange(value: string) {
    this.searchQuery.set(value || "");
    this.visibleCount.set(20);
  }

  setCategory(category: "todos" | ActivityCategory) {
    this.selectedCategory.set(category);
    this.visibleCount.set(20);
  }

  toggleDetails(eventId: string) {
    const next = new Set(this.expandedEventIds());
    if (next.has(eventId)) next.delete(eventId);
    else next.add(eventId);
    this.expandedEventIds.set(next);
  }

  isExpanded(eventId: string): boolean {
    return this.expandedEventIds().has(eventId);
  }

  hasMetaDetails(event: ActivityEventVM): boolean {
    return this.detailEntries(event).length > 0;
  }

  detailEntries(event: ActivityEventVM): Array<{ key: string; value: string }> {
    const meta = event.meta || {};
    return Object.entries(meta)
      .filter(([_, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => ({
        key: this.prettyMetaKey(key),
        value: this.prettyMetaValue(value),
      }));
  }

  onLoadMore() {
    if (this.canShowMoreLocal()) {
      this.visibleCount.update((current) => current + 20);
      return;
    }
    if (this.canRequestMoreRemote()) {
      this.loadMoreRequested.emit();
    }
  }

  private mapEvent(event: OrderEvent): ActivityEventVM {
    const createdAt = this.toDate(event.createdAt);
    const normalizedType = this.inferType(event.type, event.message, event.meta);
    const category = this.categoryForType(normalizedType);
    const tone = this.toneForType(normalizedType);

    return {
      id: event.id,
      type: normalizedType,
      category,
      title: this.titleForType(normalizedType),
      summary: this.summaryForEvent(event, normalizedType),
      absoluteTime: this.formatAbsolute(createdAt),
      relativeTime: this.formatRelative(createdAt),
      userLabel: event.actor?.name ? `por ${event.actor.name}` : "por Sistema",
      tone,
      icon: this.iconForType(normalizedType),
      badge: this.badgeForType(normalizedType, event.meta),
      meta: (event.meta || {}) as Record<string, any>,
      createdAtDate: createdAt,
    };
  }

  private inferType(type: string, message: string, meta?: any): string {
    const raw = String(type || "").trim().toLowerCase();
    const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (normalized) {
      if (normalized === "existences_confirmed") return "existence_confirmed";
      if (normalized === "item_packed") return "package_updated";
      if (normalized === "item_received_qa") return "inventory_received";
      if (normalized === "item_missing") return "out_of_stock_marked";
      if (normalized === "item_damaged") return "out_of_stock_marked";
      if (normalized === "procurement_created") return "supplier_state_changed";
      if (normalized === "marked_inbound") return "supplier_state_changed";
      if (normalized === "inventory_inbound_received") return "inbound_received_partial";
      if (normalized === "dispatch_ready") return "package_updated";
      if (normalized === "payment_registered") return "payment_registered";
      if (normalized === "late_change_requested") return "warning";
      return normalized;
    }

    const text = `${message || ""} ${(meta && JSON.stringify(meta)) || ""}`.toLowerCase();
    if (text.includes("item agregado")) return "item_added";
    if (text.includes("item removido") || text.includes("item eliminado")) return "item_removed";
    if (text.includes("cantidad")) return "item_updated_qty";
    if (text.includes("existencias confirmadas")) return "existence_confirmed";
    if (text.includes("faltante") || text.includes("dañado") || text.includes("daniado")) return "out_of_stock_marked";
    if (text.includes("proveedor") && text.includes("estado")) return "supplier_state_changed";
    if (text.includes("reserva inventario")) return "inventory_reserved";
    if (text.includes("recepcion inventario")) return "inventory_received";
    if (text.includes("paquete") && text.includes("creado")) return "package_created";
    if (text.includes("paquete") && text.includes("entregado")) return "delivered";
    if (text.includes("pago")) return "payment_registered";
    if (text.includes("incidencia") && text.includes("creada")) return "incident_created";
    if (text.includes("incidencia") && text.includes("resuelta")) return "incident_resolved";
    if (text.includes("error")) return "system_error";
    return "note_added";
  }

  private categoryForType(type: string): ActivityCategory {
    if (["supplier_state_changed", "procurement_created", "marked_inbound", "inbound_received_partial"].includes(type)) return "proveedor";
    if (["inventory_reserved", "inventory_released", "inventory_received", "inventory_inbound_received"].includes(type)) return "inventario";
    if (["item_added", "item_removed", "item_updated_qty", "existence_confirmed", "out_of_stock_marked", "state_changed"].includes(type)) return "estado";
    if (["payment_registered", "payment_failed", "payment_refunded"].includes(type)) return "pagos";
    if (["package_created", "package_updated", "package_closed", "delivered", "package_delivered", "dispatch_ready"].includes(type)) return "entrega";
    if (["incident_created", "incident_resolved", "warning"].includes(type)) return "incidencias";
    return "sistema";
  }

  private toneForType(type: string): ActivityTone {
    if (["item_added", "existence_confirmed", "inventory_reserved", "inventory_received", "delivered", "payment_registered", "incident_resolved"].includes(type)) return "success";
    if (["out_of_stock_marked", "inbound_received_partial", "warning", "payment_failed"].includes(type)) return "warning";
    if (["supplier_state_changed", "package_created", "package_updated", "item_updated_qty", "note_added"].includes(type)) return "info";
    if (["system_error", "incident_created", "payment_refunded"].includes(type)) return "danger";
    return "neutral";
  }

  private iconForType(type: string): string {
    if (["item_added", "inventory_reserved"].includes(type)) return "+";
    if (["item_removed", "inventory_released"].includes(type)) return "-";
    if (["existence_confirmed", "delivered", "incident_resolved", "payment_registered", "inventory_received"].includes(type)) return "\u2713";
    if (["supplier_state_changed", "item_updated_qty", "package_updated"].includes(type)) return "?";
    if (["out_of_stock_marked", "warning", "incident_created", "payment_failed"].includes(type)) return "!";
    if (["system_error"].includes(type)) return "?";
    if (["package_created", "inbound_received_partial"].includes(type)) return "??";
    return "•";
  }

  private badgeForType(type: string, meta?: any): string | null {
    if (type === "supplier_state_changed") {
      const next = meta?.nextStatus || meta?.to || meta?.next_status;
      return next ? this.prettyMetaValue(next) : "Proveedor";
    }
    if (type === "payment_registered") return "Pago";
    if (type === "delivered") return "Entregado";
    if (type === "inventory_reserved") return "Reservado";
    if (type === "inbound_received_partial") return "Parcial";
    return null;
  }

  private titleForType(type: string): string {
    const titles: Record<string, string> = {
      item_added: "+ Item agregado",
      item_removed: "- Item eliminado",
      item_updated_qty: "? Cantidad actualizada",
      existence_confirmed: "\u2713 Existencias confirmadas",
      out_of_stock_marked: "! Marcado sin stock",
      supplier_state_changed: "? Estado de proveedor actualizado",
      inbound_received_partial: "?? Recepción parcial",
      inventory_reserved: "?? Reservado en inventario",
      inventory_released: "?? Reserva liberada",
      inventory_received: "?? Inventario recibido",
      package_created: "?? Paquete creado",
      package_updated: "?? Paquete actualizado",
      delivered: "\u2713 Entregado",
      payment_registered: "?? Pago registrado",
      payment_failed: "? Pago fallido",
      payment_refunded: "? Reembolso aplicado",
      incident_created: "? Incidencia creada",
      incident_resolved: "\u2713 Incidencia resuelta",
      note_added: "?? Nota agregada",
      system_error: "? Error del sistema",
      warning: "? Advertencia",
    };
    return titles[type] || "?? Evento del sistema";
  }

  private summaryForEvent(event: OrderEvent, type: string): string {
    const meta = (event.meta || {}) as Record<string, any>;
    const fromMeta =
      meta["productName"] ||
      meta["product_name"] ||
      meta["itemTitle"] ||
      meta["item_title"] ||
      meta["itemId"] ||
      meta["item_id"] ||
      meta["supplierName"] ||
      meta["supplier_name"] ||
      meta["orderId"] ||
      meta["order_id"] ||
      meta["packageId"] ||
      meta["package_id"] ||
      null;

    if (fromMeta) return String(fromMeta);

    if (type === "supplier_state_changed" && meta["nextStatus"]) {
      return `Cambio a ${this.prettyMetaValue(meta["nextStatus"])}`;
    }

    return event.message || "Sin detalle";
  }

  private toDate(value: unknown): Date {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
    if (typeof value === "object" && value && "toDate" in (value as any)) {
      const date = (value as any).toDate();
      if (date instanceof Date) return date;
    }
    return new Date();
  }

  private formatAbsolute(date: Date): string {
    const day = date.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const time = date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: true });
    return `${day} · ${time}`;
  }

  private formatRelative(date: Date): string {
    const now = Date.now();
    const diffMs = Math.max(0, now - date.getTime());
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Hace 1 min";
    if (mins < 60) return `Hace ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Hace ${hours} h`;
    const days = Math.floor(hours / 24);
    return `Hace ${days} día${days === 1 ? "" : "s"}`;
  }

  private dayKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private dayLabelFromKey(key: string): string {
    const now = new Date();
    const todayKey = this.dayKey(now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = this.dayKey(yesterday);

    if (key === todayKey) return "Hoy";
    if (key === yesterdayKey) return "Ayer";

    const [year, month, day] = key.split("-").map((value) => Number(value));
    const date = new Date(year, (month || 1) - 1, day || 1);
    const label = date.toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  private prettyMetaKey(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (char) => char.toUpperCase());
  }

  private prettyMetaValue(value: any): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") {
      const normalized = value.replace(/_/g, " ").replace(/\s+/g, " ").trim();
      return normalized.replace(/^./, (char) => char.toUpperCase());
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

