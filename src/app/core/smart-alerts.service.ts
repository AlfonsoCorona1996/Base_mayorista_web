import { Injectable, computed, inject, signal } from "@angular/core";
import { OrdersService, Order, OrderStatus } from "./orders.service";
import { CustomersService, Customer } from "./customers.service";
import { RoutesService } from "./routes.service";
import { NormalizedListingsService } from "./normalized-listings.service";
import { FIRESTORE } from "./firebase.providers";
import { doc, onSnapshot } from "firebase/firestore";
import { calculateOrderFinancials } from "./order-financials";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "urgent" | "warning" | "opportunity";

export type AlertCategory =
  | "routes"
  | "orders"
  | "products"
  | "customers"
  | "finance"
  | "data_quality"
  | "ai_insight";

export interface SmartAlert {
  /** ID determinístico: mismo dato = mismo id (para deduplicación) */
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  icon: string;                // Material Symbols name
  title: string;
  body: string;
  /** Ruta de navegación de la acción primaria */
  actionUrl?: string;
  actionLabel?: string;
  /** Datos de contexto para usar en el template */
  meta?: Record<string, unknown>;
  /** Timestamp de creación (ms) */
  createdAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de umbrales (ajustables sin tocar lógica)
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  /** Horas sin movimiento para considerar un pedido "olvidado" */
  ORDER_STALE_HOURS: 48,
  /** Días sin pedir para considerar a una clienta "en riesgo de churn" */
  CUSTOMER_CHURN_DAYS: 21,
  /** Días con pago pendiente para considerar un adeudo vencido */
  PAYMENT_OVERDUE_DAYS: 7,
  /** Pedidos listos en una ruta para disparar alerta de ruta sin programar */
  ROUTE_QUEUE_MIN_ORDERS: 2,
  /** Días de un producto activo sin venderse para considerarlo estancado */
  PRODUCT_STALE_DAYS: 45,
};

// Estados terminales que NO deben generar alertas de pedido olvidado
const TERMINAL_STATUSES = new Set<OrderStatus>([
  "pagado", "pagado_parcial", "cancelado", "devuelto", "closed",
  "entregado", "delivered", "delivered_partial",
]);

// Estados operativos que se consideran "en progreso"
const IN_PROGRESS_STATUSES = new Set<OrderStatus>([
  "borrador", "confirmando_proveedor", "reservado_inventario",
  "solicitado_proveedor", "supplier_processing", "inbound_in_transit",
  "en_transito", "recibido_qa", "packing", "empaque",
  "ready_for_route", "assigned_to_run", "in_transit", "en_ruta",
  "pago_pendiente",
]);

// Pedidos a considerar en "pendiente por cobrar" del dashboard
// (desde borrador hasta listo para ruta, inclusive).
const PENDING_COLLECTION_STATUSES = new Set<OrderStatus>([
  "borrador",
  "confirmando_proveedor",
  "reservado_inventario",
  "solicitado_proveedor",
  "supplier_processing",
  "inbound_in_transit",
  "en_transito",
  "recibido_qa",
  "packing",
  "empaque",
  "ready_for_route",
  "assigned_to_run",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hoursSince(isoDate: string | null | undefined): number {
  if (!isoDate) return 0;
  return (Date.now() - new Date(isoDate).getTime()) / 3_600_000;
}

function daysSince(isoDate: string | null | undefined): number {
  return hoursSince(isoDate) / 24;
}

function plural(n: number, singular: string, pluralStr: string): string {
  return `${n} ${n === 1 ? singular : pluralStr}`;
}

function simpleId(...parts: (string | number)[]): string {
  return parts.join(":");
}

function toSafeNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function estimateOrderTotal(order: Order): number {
  return Number(
    (order.items || [])
      .reduce((sum, item) => {
        const qtyRaw = item.confirmed_qty ?? item.quantity ?? 0;
        const qty = Math.max(0, Math.trunc(toSafeNumber(qtyRaw)));
        const unit = Math.max(0, toSafeNumber(item.price_clienta ?? item.price_public ?? 0));
        return sum + qty * unit;
      }, 0)
      .toFixed(2),
  );
}

function pendingAmountForOrder(order: Order): number {
  return calculateOrderFinancials(order).balanceDue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Servicio
// ─────────────────────────────────────────────────────────────────────────────

interface DataQualityIssue {
  type: string;
  title: string;
  detail: string;
  count?: number;
}

interface DataQualitySnapshot {
  issues: DataQualityIssue[];
  aiReport: {
    product_issues?: Array<{ item: string; problem: string; suggestion: string }>;
    category_issues?: Array<{ item: string; problem: string; suggestion: string }>;
    summary?: string;
  } | null;
  totalIssues: number;
  generated_at: string;
}

@Injectable({ providedIn: "root" })
export class SmartAlertsService {
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private routes = inject(RoutesService);
  private listings = inject(NormalizedListingsService);
  private firestore = FIRESTORE;

  /** Snapshot del último análisis semanal de calidad (generado por el backend) */
  readonly dataQualitySnapshot = signal<DataQualitySnapshot | null>(null);

  constructor() {
    // Escuchar el snapshot de calidad en tiempo real (se actualiza 1x/semana en backend)
    onSnapshot(
      doc(this.firestore, "data_quality_snapshots", "latest"),
      (snap) => {
        if (snap.exists()) {
          this.dataQualitySnapshot.set(snap.data() as DataQualitySnapshot);
        }
      },
      (err) => console.warn("[SmartAlerts] No se pudo leer snapshot de calidad:", err.message),
    );
  }

  private getCustomerDisplayName(customerId: string): string {
    const customer = this.customers.getById(customerId);
    const fullName = `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim();
    return fullName || "Clienta";
  }

  // ── Alertas de PEDIDOS ──────────────────────────────────────────────────

  /** Pedidos que llevan más de THRESHOLD horas en el mismo estado no terminal */
  readonly staleOrderAlerts = computed<SmartAlert[]>(() => {
    const alerts: SmartAlert[] = [];
    for (const order of this.orders.list()) {
      if (TERMINAL_STATUSES.has(order.status)) continue;
      const staleHours = hoursSince(order.updated_at);
      if (staleHours < THRESHOLDS.ORDER_STALE_HOURS) continue;

      const daysStale = Math.floor(staleHours / 24);
      const hoursExtra = Math.floor(staleHours % 24);
      const timeLabel = daysStale > 0
        ? `${plural(daysStale, "día", "días")}${hoursExtra > 0 ? ` y ${hoursExtra}h` : ""}`
        : `${Math.floor(staleHours)}h`;

      const statusLabels: Partial<Record<OrderStatus, string>> = {
        borrador: "borrador (sin productos)",
        confirmando_proveedor: "esperando confirmación de proveedor",
        empaque: "en empaque sin avanzar",
        pago_pendiente: "con pago pendiente",
        ready_for_route: "listo para ruta pero sin asignar",
      };
      const statusText = statusLabels[order.status] ?? `en estado "${order.status}"`;

      alerts.push({
        id: simpleId("stale_order", order.order_id),
        severity: staleHours > 96 ? "critical" : "urgent",
        category: "orders",
        icon: "schedule",
        title: "Pedido sin movimiento",
        body: `${this.getCustomerDisplayName(order.customer_id)} lleva ${timeLabel} ${statusText}. ¿Necesita atención?`,
        actionUrl: `/main/pedidos/${order.order_id}`,
        actionLabel: "Ver pedido",
        meta: { orderId: order.order_id, customerId: order.customer_id, staleHours, status: order.status, routeId: order.route_id ?? null },
        createdAt: Date.now(),
      });
    }
    return alerts.slice(0, 10); // máximo 10 para no saturar
  });

  /** Pedidos con pago pendiente que llevan más de THRESHOLD días */
  readonly overduePaymentAlerts = computed<SmartAlert[]>(() => {
    const alerts: SmartAlert[] = [];
    for (const order of this.orders.list()) {
      if (!["pago_pendiente", "pagado_parcial"].includes(order.status)) continue;
      const days = daysSince(order.updated_at);
      if (days < THRESHOLDS.PAYMENT_OVERDUE_DAYS) continue;

      const balance = order.totals?.balance_due ?? 0;
      alerts.push({
        id: simpleId("overdue_payment", order.order_id),
        severity: "critical",
        category: "finance",
        icon: "payments",
        title: "Adeudo vencido",
        body: `${this.getCustomerDisplayName(order.customer_id)} tiene $${balance.toFixed(2)} pendiente hace ${Math.floor(days)} días.`,
        actionUrl: `/main/pedidos/${order.order_id}`,
        actionLabel: "Ver pedido",
        meta: { orderId: order.order_id, customerId: order.customer_id, balance, days },
        createdAt: Date.now(),
      });
    }
    return alerts;
  });

  /** Total de adeudos activos */
  readonly totalBalanceDue = computed<number>(() => {
    return this.orders.list()
      .filter((o) => PENDING_COLLECTION_STATUSES.has(o.status))
      .reduce((sum, o) => sum + pendingAmountForOrder(o), 0);
  });

  // ── Alertas de RUTAS ───────────────────────────────────────────────────

  /** Rutas con pedidos "listos" pero sin salida programada para hoy */
  readonly unscheduledRouteAlerts = computed<SmartAlert[]>(() => {
    const alerts: SmartAlert[] = [];
    const readyOrders = this.orders.list().filter(
      (o) => ["ready_for_route", "assigned_to_run"].includes(o.status)
    );

    if (readyOrders.length === 0) return [];

    // Agrupar por ruta
    const byRoute = new Map<string | null, Order[]>();
    for (const order of readyOrders) {
      const key = order.route_id ?? "__sin_ruta__";
      const group = byRoute.get(key) ?? [];
      group.push(order);
      byRoute.set(key, group);
    }

    for (const [routeId, orders] of byRoute.entries()) {
      if (orders.length < THRESHOLDS.ROUTE_QUEUE_MIN_ORDERS) continue;
      const route = routeId !== "__sin_ruta__" && routeId != null
        ? this.routes.getById(routeId)
        : null;
      const routeName = route?.name ?? "Sin ruta asignada";

      alerts.push({
        id: simpleId("unscheduled_route", routeId ?? "none"),
        severity: orders.length >= 5 ? "critical" : "urgent",
        category: "routes",
        icon: "local_shipping",
        title: "Ruta con pedidos en cola",
        body: `La ruta "${routeName}" tiene ${plural(orders.length, "pedido listo", "pedidos listos")} esperando salida. ¿Ya está programada?`,
        actionUrl: "/main/salidas",
        actionLabel: "Ver salidas",
        meta: { routeId, routeName, orderCount: orders.length },
        createdAt: Date.now(),
      });
    }

    return alerts;
  });

  // ── Alertas de CLIENTAS ────────────────────────────────────────────────

  /** Clientas con historial de compra que llevan más de THRESHOLD días sin pedir */
  readonly churnRiskAlerts = computed<SmartAlert[]>(() => {
    const atRisk: Array<{ customer: Customer; daysSinceOrder: number }> = [];

    for (const customer of this.customers.getActive()) {
      const insights = customer.insights;
      if (!insights?.total_orders || insights.total_orders < 2) continue;
      if (!insights.last_order_at) continue;

      const days = daysSince(insights.last_order_at);
      if (days < THRESHOLDS.CUSTOMER_CHURN_DAYS) continue;

      atRisk.push({ customer, daysSinceOrder: Math.floor(days) });
    }

    if (atRisk.length === 0) return [];

    // Una sola alerta agrupada con la lista
    atRisk.sort((a, b) => b.daysSinceOrder - a.daysSinceOrder);
    const top5 = atRisk.slice(0, 5);
    const names = top5
      .map(({ customer, daysSinceOrder }) =>
        `${customer.first_name} ${customer.last_name} (${daysSinceOrder}d)`
      )
      .join(", ");

    return [{
      id: "churn_risk_batch",
      severity: atRisk.length >= 5 ? "urgent" : "warning",
      category: "customers",
      icon: "person_off",
      title: `${plural(atRisk.length, "clienta ausente", "clientas ausentes")}`,
      body: `Llevan más de ${THRESHOLDS.CUSTOMER_CHURN_DAYS} días sin pedir: ${names}${atRisk.length > 5 ? ` y ${atRisk.length - 5} más.` : "."}`,
      actionUrl: "/main/clientas",
      actionLabel: "Ver clientas",
      meta: { atRiskCustomers: atRisk.map(x => x.customer.customer_id) },
      createdAt: Date.now(),
    }];
  });

  // ── Alertas de PRODUCTOS ───────────────────────────────────────────────

  /** Productos del catálogo sin ventas en los últimos THRESHOLD días */
  readonly staleProductAlerts = computed<SmartAlert[]>(() => {
    const rows = this.listings.liveFirstPage();
    if (!rows || rows.length === 0) return [];

    const stale = rows.filter((listing: any) => {
      const updatedAt = (listing as any).updated_at ?? (listing as any).created_at;
      if (!updatedAt) return false;
      const iso = typeof updatedAt === "string"
        ? updatedAt
        : updatedAt?.toDate?.()?.toISOString?.() ?? null;
      return daysSince(iso) > THRESHOLDS.PRODUCT_STALE_DAYS;
    });

    if (stale.length === 0) return [];

    return [{
      id: "stale_products_batch",
      severity: "warning",
      category: "products",
      icon: "inventory_2",
      title: `${plural(stale.length, "producto estancado", "productos estancados")} en catálogo`,
      body: `${plural(stale.length, "producto lleva", "productos llevan")} más de ${THRESHOLDS.PRODUCT_STALE_DAYS} días sin actualización. Considera desactivarlos o buscar restock.`,
      actionUrl: "/main/catalogo",
      actionLabel: "Ver catálogo",
      meta: { count: stale.length },
      createdAt: Date.now(),
    }];
  });

  /** Pedidos por empaque sin movimiento > 24h */
  readonly packingStuckAlerts = computed<SmartAlert[]>(() => {
    const stuck = this.orders.list().filter(
      (o) => ["packing", "empaque"].includes(o.status) && hoursSince(o.updated_at) > 24
    );
    if (stuck.length === 0) return [];

    return [{
      id: "packing_stuck",
      severity: "urgent",
      category: "orders",
      icon: "inventory",
      title: `${plural(stuck.length, "pedido", "pedidos")} estancado${stuck.length > 1 ? "s" : ""} en empaque`,
      body: `${plural(stuck.length, "pedido lleva", "pedidos llevan")} más de 24h en empaque sin avanzar. ¿Hay algún problema?`,
      actionUrl: "/main/pedidos",
      actionLabel: "Ver pedidos",
      meta: { orderIds: stuck.map(o => o.order_id) },
      createdAt: Date.now(),
    }];
  });

  // ── Resumen de KPIs para el dashboard ─────────────────────────────────

  readonly kpis = computed(() => {
    const orders = this.orders.list();
    const now = Date.now();

    const byPacking = orders.filter(o => ["packing", "empaque"].includes(o.status)).length;
    const readyForRoute = orders.filter(o => ["ready_for_route", "assigned_to_run"].includes(o.status)).length;
    const inRoute = orders.filter(o => ["in_transit", "en_ruta"].includes(o.status)).length;
    const pendingPayment = orders.filter((o) => {
      if (!PENDING_COLLECTION_STATUSES.has(o.status)) return false;
      return pendingAmountForOrder(o) > 0;
    }).length;
    const totalBalance = this.totalBalanceDue();

    const activeCustomers = this.customers.getActive().length;
    const churnRisk = this.customers.getActive().filter(c => {
      if (!c.insights?.last_order_at || (c.insights?.total_orders ?? 0) < 2) return false;
      return daysSince(c.insights.last_order_at) > THRESHOLDS.CUSTOMER_CHURN_DAYS;
    }).length;

    return {
      byPacking,
      readyForRoute,
      inRoute,
      pendingPayment,
      totalBalance,
      activeCustomers,
      churnRisk,
      now,
    };
  });

  // ── Alertas de CALIDAD DE DATOS (snapshot semanal del backend) ────────

  readonly dataQualityAlerts = computed<SmartAlert[]>(() => {
    const snap = this.dataQualitySnapshot();
    if (!snap || snap.totalIssues === 0) return [];

    const alerts: SmartAlert[] = [];
    const generatedAt = snap.generated_at
      ? new Date(snap.generated_at).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })
      : "esta semana";

    // Problemas de lógica pura (duplicados, datos faltantes, etc.)
    for (const issue of snap.issues ?? []) {
      alerts.push({
        id: `dq:${issue.type}`,
        severity: ["duplicate_phone", "orphan_orders"].includes(issue.type) ? "urgent" : "warning",
        category: "data_quality",
        icon: issue.type === "duplicate_phone" ? "phone_missed"
            : issue.type === "no_phone"        ? "phone_disabled"
            : issue.type === "no_route"        ? "wrong_location"
            : issue.type === "orphan_orders"   ? "link_off"
            : issue.type.startsWith("name_")   ? "text_fields"
            : "data_alert",
        title: issue.title,
        body: issue.detail,
        actionUrl: issue.type.startsWith("name_") || issue.type.includes("phone") || issue.type.includes("route")
          ? "/main/clientas"
          : issue.type.includes("product") || issue.type.includes("category")
          ? "/main/catalogo"
          : undefined,
        actionLabel: "Revisar",
        meta: { count: issue.count },
        createdAt: Date.now(),
      });
    }

    // Problemas de ortografía detectados por IA
    const productIssues = snap.aiReport?.product_issues ?? [];
    const categoryIssues = snap.aiReport?.category_issues ?? [];
    const aiTotal = productIssues.length + categoryIssues.length;

    if (aiTotal > 0) {
      const examples = [
        ...productIssues.slice(0, 2).map(p => `"${p.item}" → "${p.suggestion}"`),
        ...categoryIssues.slice(0, 1).map(c => `"${c.item}" → "${c.suggestion}"`),
      ].join(", ");

      alerts.push({
        id: "dq:ai_spelling",
        severity: "warning",
        category: "data_quality",
        icon: "spellcheck",
        title: `${aiTotal} problema${aiTotal > 1 ? "s" : ""} de ortografía/consistencia`,
        body: `IA detectó el ${generatedAt}: ${examples}${aiTotal > 3 ? ` y ${aiTotal - 3} más.` : "."}`,
        actionUrl: "/main/catalogo",
        actionLabel: "Ver catálogo",
        meta: { productIssues, categoryIssues },
        createdAt: Date.now(),
      });
    }

    return alerts;
  });

  // ── Lista completa ordenada por severidad ──────────────────────────────

  readonly allAlerts = computed<SmartAlert[]>(() => {
    const raw = [
      ...this.overduePaymentAlerts(),
      ...this.staleOrderAlerts(),
      ...this.unscheduledRouteAlerts(),
      ...this.packingStuckAlerts(),
      ...this.churnRiskAlerts(),
      ...this.staleProductAlerts(),
      ...this.dataQualityAlerts(),
    ];

    const severityOrder: Record<AlertSeverity, number> = {
      critical: 0,
      urgent: 1,
      warning: 2,
      opportunity: 3,
    };

    return raw.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  });

  readonly criticalCount = computed(() =>
    this.allAlerts().filter(a => a.severity === "critical").length
  );

  readonly urgentCount = computed(() =>
    this.allAlerts().filter(a => a.severity === "urgent" || a.severity === "critical").length
  );
}
