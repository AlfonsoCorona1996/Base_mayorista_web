import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { CurrencyPipe, DatePipe, NgClass, PercentPipe, UpperCasePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpErrorResponse } from "@angular/common/http";
import { lastValueFrom } from "rxjs";
import { CustomersService, Customer } from "../../core/customers.service";
import { RoutesService } from "../../core/routes.service";
import { Order, OrderStatus, OrdersService } from "../../core/orders.service";
import { calculateItemFinancials, calculateOrderFinancials } from "../../core/order-financials";
import { ApiError, UserAdminApiService } from "../../services/user-admin-api.service";
import { CustomerFollowup, CustomerFollowupType, CustomerFollowupsService } from "../../core/customer-followups.service";

// Tipos de notificación (espejo del backend)
export interface WaNotifType {
  id: string;
  label: string;
  description: string;
  default: boolean;
}

interface TrackLinkAdminState {
  enabled: boolean;
  legacy: boolean;
  version: number | null;
  tracking_url: string | null;
  created_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
  last_access_at: string | null;
}

interface TrackLinkGenerateResult {
  token: string;
  tracking_url: string;
  enabled: boolean;
  version: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos locales
// ─────────────────────────────────────────────────────────────────────────────

export type RfmSegment =
  | "champions"       // alta recencia, alta frecuencia, alto gasto
  | "loyal"           // alta frecuencia, buen gasto
  | "at_risk"         // buena historia pero llevan tiempo sin comprar
  | "needs_attention" // recencia baja, frecuencia media
  | "new"             // menos de 2 pedidos
  | "dormant";        // sin pedido en mucho tiempo
type ClientTab = "summary" | "orders" | "products" | "account" | "followup" | "data";

interface ProductFreqRow {
  title: string;
  sku: string | null;
  variant: string | null;
  count: number;
  totalSpent: number;
  margin: number;
  returns: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 9999;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function computeRfmSegment(orders: Order[]): RfmSegment {
  const paid = orders.filter(o =>
    ["pagado", "pagado_parcial", "entregado", "delivered", "delivered_partial", "pago_pendiente", "closed"].includes(o.status)
  );
  const totalOrders = paid.length;
  if (totalOrders === 0) return "dormant";
  if (totalOrders < 2) return "new";

  const last = paid[0];
  const days = daysSince(last.updated_at || last.created_at);
  const total = paid.reduce((s, o) => s + calculateOrderFinancials(o).netAmount, 0);
  const avg = total / totalOrders;

  if (days < 14 && totalOrders >= 5 && avg > 500) return "champions";
  if (totalOrders >= 4 && days < 30) return "loyal";
  if (days > 45 && totalOrders >= 3) return "at_risk";
  if (days > 30) return "needs_attention";
  return "loyal";
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-clienta-detalle",
  imports: [RouterLink, CurrencyPipe, DatePipe, NgClass, PercentPipe, UpperCasePipe, FormsModule],
  templateUrl: "./clienta-detalle.html",
  styleUrl: "./clienta-detalle.css",
})
export default class ClientaDetallePage implements OnInit {
  private route     = inject(ActivatedRoute);
  private router    = inject(Router);
  private customers = inject(CustomersService);
  private routes    = inject(RoutesService);
  private api       = inject(UserAdminApiService);
  private ordersService = inject(OrdersService);
  private followupsService = inject(CustomerFollowupsService);

  loading    = signal(true);
  customerId = signal("");
  customer   = signal<Customer | null>(null);
  orders     = signal<Order[]>([]);
  error      = signal<string | null>(null);
  activeTab = signal<ClientTab>("summary");
  followUpDraft = signal("");
  followUpType = signal<CustomerFollowupType>("general_note");
  followUpNote = signal("");
  followUpSaving = signal(false);
  assistantCopied = signal<string | null>(null);
  orderHistoryLimit = signal(20);
  creditOrderId = signal("");
  creditApplying = signal(false);

  // ── Link de seguimiento ───────────────────────────────────────────────
  trackLink        = signal<string | null>(null);
  trackLinkLoading = signal(false);
  trackLinkCopied  = signal(false);
  trackLinkMeta = signal<TrackLinkAdminState | null>(null);
  trackLinkError = signal<string | null>(null);
  trackLinkNotice = signal<string | null>(null);

  // ── Notificaciones WhatsApp ───────────────────────────────────────────
  waTypes       = signal<WaNotifType[]>([]);
  waPrefs       = signal<Record<string, boolean>>({});
  waPrefsDirty  = signal(false);
  waPrefsSaving = signal(false);
  waSendLoading = signal<string | null>(null);
  waSendResult  = signal<{ type: string; ok: boolean; msg?: string } | null>(null);

  // ── Computed de análisis ─────────────────────────────────────────────

  paidOrders = computed(() =>
    this.orders().filter(o => ["pagado", "pagado_parcial", "entregado", "delivered", "delivered_partial", "pago_pendiente", "closed"].includes(o.status) && calculateOrderFinancials(o).netUnits > 0)
  );

  activeOrders = computed(() =>
    this.orders().filter(o => !["pagado", "cancelado", "devuelto", "closed"].includes(o.status))
  );

  totalSpent = computed(() =>
    this.paidOrders().reduce((s, o) => s + calculateOrderFinancials(o).netAmount, 0)
  );
  deliveredHistory = computed(() => this.orders().filter((order) =>
    (Boolean(order.delivered_at) || ["pagado", "pagado_parcial", "entregado", "delivered", "delivered_partial", "pago_pendiente", "closed"].includes(order.status))
    && order.status !== "cancelado",
  ));
  unpaidOrders = computed(() => this.orders().filter((order) =>
    calculateOrderFinancials(order).balanceDue > 0
    && !["cancelado", "devuelto"].includes(order.status),
  ));

  totalDebt = computed(() =>
    this.orders()
      .filter(o => !["cancelado", "devuelto"].includes(o.status))
      .reduce((s, o) => s + calculateOrderFinancials(o).balanceDue, 0)
  );
  totalProfit = computed(() => this.paidOrders().reduce((sum, order) => sum + calculateOrderFinancials(order).grossProfit, 0));
  totalReturns = computed(() => this.deliveredHistory().reduce((sum, order) => sum + calculateOrderFinancials(order).returnsAmount, 0));
  totalCollected = computed(() => this.paidOrders().reduce((sum, order) => {
    const row = calculateOrderFinancials(order);
    return sum + Math.min(row.netAmount, row.paidAmount);
  }, 0));
  returnRate = computed(() => {
    const gross = this.deliveredHistory().reduce((sum, order) => sum + calculateOrderFinancials(order).grossClient, 0);
    return gross > 0 ? this.totalReturns() / gross : 0;
  });
  oldestDebtDays = computed(() => {
    const pending = this.orders().filter((order) => calculateOrderFinancials(order).balanceDue > 0);
    if (!pending.length) return 0;
    return Math.floor(daysSince(pending[pending.length - 1].created_at));
  });
  creditMovements = computed(() => this.customers.creditMovementsFor(this.customerId()));
  followups = computed(() => this.followupsService.forCustomer(this.customerId()).sort((a, b) => a.due_at.localeCompare(b.due_at)));
  openFollowups = computed(() => this.followups().filter((row) => row.status === "open" || row.status === "snoozed"));
  overdueFollowups = computed(() => this.openFollowups().filter((row) => this.isOverdue(row.due_at)));
  completedFollowups = computed(() => this.followups().filter((row) => row.status === "done"));
  accountOrders = computed(() => this.orders().filter((order) => calculateOrderFinancials(order).balanceDue > 0 || calculateOrderFinancials(order).paidAmount > 0 || calculateOrderFinancials(order).overpaymentAmount > 0));
  visibleOrderHistory = computed(() => this.orders().slice(0, this.orderHistoryLimit()));
  dataQualityIssues = computed(() => {
    const c = this.customer();
    if (!c) return [];
    const issues: string[] = [];
    if (!c.route_id) issues.push("Ruta pendiente");
    if (!c.birthday) issues.push("Cumpleaños pendiente");
    if (!c.address?.trim()) issues.push("Dirección pendiente");
    if (!c.preferred_sizes?.length && !c.preferred_categories?.length) issues.push("Preferencias pendientes");
    return issues;
  });
  nextAction = computed(() => this.buildNextAction());
  assistantDrafts = computed(() => this.buildAssistantDrafts());

  avgOrderValue = computed(() => {
    const n = this.paidOrders().length;
    return n > 0 ? this.totalSpent() / n : 0;
  });

  monthlyAvg = computed(() => {
    const paid = this.paidOrders();
    if (paid.length < 2) return 0;
    const oldest = paid[paid.length - 1];
    const months = daysSince(oldest.created_at) / 30;
    return months > 0 ? this.totalSpent() / months : 0;
  });

  annualAvg = computed(() => this.monthlyAvg() * 12);

  avgFrequencyDays = computed(() => {
    const paid = this.paidOrders();
    if (paid.length < 2) return null;
    const oldest = paid[paid.length - 1];
    const days = daysSince(oldest.created_at);
    return Math.round(days / paid.length);
  });

  daysSinceLastOrder = computed(() => {
    const paid = this.paidOrders();
    if (paid.length === 0) return null;
    return Math.floor(daysSince(paid[0].updated_at || paid[0].created_at));
  });

  rfmSegment = computed<RfmSegment>(() => this.relativeRfmSegment());

  /** Top 5 productos más comprados */
  topProducts = computed<ProductFreqRow[]>(() => {
    const freq = new Map<string, ProductFreqRow>();
    for (const order of this.paidOrders()) {
      for (const item of order.items ?? []) {
        const key = (item.sku || `${item.title}|${item.variant || ""}`).trim().toLowerCase();
        if (!key) continue;
        const existing = freq.get(key) ?? { title: item.title || key, sku: item.sku || null, variant: item.variant || null, count: 0, totalSpent: 0, margin: 0, returns: 0 };
        const financials = calculateItemFinancials(item);
        existing.count += financials.netQty;
        existing.totalSpent += financials.netClient;
        existing.margin += financials.netClient - financials.netCost;
        existing.returns += financials.returnedQty;
        freq.set(key, existing);
      }
    }
    return Array.from(freq.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  });

  routeName = computed(() => {
    const c = this.customer();
    if (!c?.route_id) return "Sin ruta";
    return this.routes.getById(c.route_id)?.name ?? "Sin ruta";
  });

  // ── Ciclo de vida ────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get("id") || "";
    this.customerId.set(id);

    await Promise.all([
      this.customers.loadFromFirestore().catch(() => null),
      this.routes.loadFromFirestore().catch(() => null),
      this.ordersService.loadFromFirestore().catch(() => null),
      this.followupsService.loadFromFirestore().catch(() => null),
    ]);

    const c = this.customers.getById(id);
    if (!c) {
      this.error.set("Clienta no encontrada");
      this.loading.set(false);
      return;
    }
    this.customer.set(c);
    this.followUpDraft.set(c.follow_up_at ? String(c.follow_up_at).slice(0, 10) : "");

    await Promise.all([
      this.loadOrders(id),
      this.loadWaTypes(),
      this.loadTrackLink(),
    ]);

    this.loading.set(false);
  }

  // ── Link de seguimiento ──────────────────────────────────────────────

  async generateTrackLink(): Promise<void> {
    const rotate = Boolean(this.trackLink());
    if (rotate && !window.confirm("El enlace anterior dejará de funcionar. ¿Quieres generar uno nuevo?")) return;
    this.trackLinkLoading.set(true);
    this.trackLinkError.set(null);
    this.trackLinkNotice.set(null);
    try {
      const result = await lastValueFrom(
        this.api.post<TrackLinkGenerateResult>(
          "/api/admin/track/generate",
          { customer_id: this.customerId(), rotate }
        )
      );
      this.trackLink.set(result.tracking_url);
      this.trackLinkMeta.set({
        enabled: true,
        legacy: false,
        version: result.version,
        tracking_url: result.tracking_url,
        created_at: new Date().toISOString(),
        rotated_at: rotate ? new Date().toISOString() : null,
        revoked_at: null,
        last_access_at: null,
      });
      this.trackLinkNotice.set(rotate ? "Enlace regenerado. El anterior ya no funciona." : "Enlace seguro creado correctamente.");
    } catch (error: unknown) {
      this.trackLinkError.set(this.trackErrorMessage(error, "No se pudo generar el enlace."));
    } finally {
      this.trackLinkLoading.set(false);
    }
  }

  async copyTrackLink(): Promise<void> {
    const link = this.trackLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.trackLinkCopied.set(true);
      this.trackLinkNotice.set("Enlace copiado al portapapeles.");
      this.trackLinkError.set(null);
      setTimeout(() => this.trackLinkCopied.set(false), 2500);
    } catch {
      this.trackLinkError.set("No se pudo copiar automáticamente. Selecciona y copia el enlace manualmente.");
    }
  }

  shareTrackLink(): void {
    const link = this.trackLink();
    const customer = this.customer();
    if (!link || !customer?.whatsapp) {
      this.trackLinkError.set("La clienta no tiene un WhatsApp registrado para compartir el enlace.");
      return;
    }
    const digits = customer.whatsapp.replace(/\D/g, "");
    const phone = digits.length === 10 ? `52${digits}` : digits;
    const message = `Hola ${customer.first_name}, este es tu enlace personal de Base Mayorista para revisar pedidos, pagos y devoluciones: ${link}`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }

  async revokeTrackLink(): Promise<void> {
    if (!this.trackLink() || !window.confirm("¿Revocar este enlace? La clienta dejará de tener acceso inmediatamente.")) return;
    this.trackLinkLoading.set(true);
    this.trackLinkError.set(null);
    this.trackLinkNotice.set(null);
    try {
      await lastValueFrom(this.api.delete<void>(`/api/admin/track/${encodeURIComponent(this.customerId())}`));
      this.trackLink.set(null);
      this.trackLinkMeta.set({ enabled: false, legacy: false, version: null, tracking_url: null, created_at: null, rotated_at: null, revoked_at: new Date().toISOString(), last_access_at: null });
      this.trackLinkNotice.set("Enlace revocado. Ya no puede utilizarse.");
    } catch (error: unknown) {
      this.trackLinkError.set(this.trackErrorMessage(error, "No se pudo revocar el enlace."));
    } finally {
      this.trackLinkLoading.set(false);
    }
  }

  private async loadTrackLink(): Promise<void> {
    this.trackLinkLoading.set(true);
    this.trackLinkError.set(null);
    try {
      const result = await lastValueFrom(
        this.api.get<TrackLinkAdminState>(`/api/admin/track/${encodeURIComponent(this.customerId())}`),
      );
      this.trackLinkMeta.set(result);
      this.trackLink.set(result.enabled ? result.tracking_url : null);
    } catch (error: unknown) {
      this.trackLinkError.set(this.trackErrorMessage(error, "No se pudo consultar el estado del enlace."));
    } finally {
      this.trackLinkLoading.set(false);
    }
  }

  private trackErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError) return error.message || fallback;
    if (error instanceof HttpErrorResponse && error.error && typeof error.error === "object") {
      const payload = error.error as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
    }
    return fallback;
  }

  // ── Notificaciones WA ────────────────────────────────────────────────

  private async loadWaTypes(): Promise<void> {
    try {
      const res = await lastValueFrom(
        this.api.get<{ types: WaNotifType[] }>("/api/wa/types")
      );
      this.waTypes.set(res.types);

      // Inicializar prefs desde el documento de la clienta
      const c = this.customer() as any;
      const storedPrefs: Record<string, boolean> = c?.wa_notifications ?? {};
      const defaults: Record<string, boolean> = {};
      for (const t of res.types) {
        defaults[t.id] = storedPrefs[t.id] ?? t.default;
      }
      this.waPrefs.set(defaults);
    } catch (err) {
      console.error("[WaTypes] Error:", err);
    }
  }

  toggleWaPref(typeId: string): void {
    const current = this.waPrefs();
    this.waPrefs.set({ ...current, [typeId]: !current[typeId] });
    this.waPrefsDirty.set(true);
  }

  async saveWaPrefs(): Promise<void> {
    this.waPrefsSaving.set(true);
    try {
      await lastValueFrom(
        this.api.put(`/api/wa/prefs/${this.customerId()}`, { prefs: this.waPrefs() })
      );
      this.waPrefsDirty.set(false);
    } catch (err) {
      console.error("[WaPrefs] Error guardando:", err);
    } finally {
      this.waPrefsSaving.set(false);
    }
  }

  async sendWaNotif(typeId: string): Promise<void> {
    this.waSendLoading.set(typeId);
    this.waSendResult.set(null);
    try {
      await lastValueFrom(
        this.api.post("/api/wa/notify", {
          customer_id: this.customerId(),
          type: typeId,
          force: true,
        })
      );
      this.waSendResult.set({ type: typeId, ok: true });
    } catch (err: any) {
      const msg = err?.error?.message ?? "No se pudo enviar";
      this.waSendResult.set({ type: typeId, ok: false, msg });
    } finally {
      this.waSendLoading.set(null);
      setTimeout(() => this.waSendResult.set(null), 4000);
    }
  }

  private async loadOrders(customerId: string): Promise<void> {
    const businessId = this.customer()?.business_id;
    this.orders.set(
      this.ordersService.list()
        .filter((order) => order.customer_id === customerId && (!businessId || order.business_id === businessId))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    );
  }

  // ── UI ────────────────────────────────────────────────────────────────

  rfmLabel(seg: RfmSegment): string {
    return {
      champions:       "Clienta estrella",
      loyal:           "Clienta fiel",
      at_risk:         "En riesgo de perder",
      needs_attention: "Necesita atención",
      new:             "Nueva clienta",
      dormant:         "Inactiva",
    }[seg];
  }

  rfmDescription(seg: RfmSegment): string {
    return {
      champions:       "Compra frecuentemente, gasta mucho y compró hace poco.",
      loyal:           "Compra con regularidad y tiene buen historial.",
      at_risk:         "Tenía buen ritmo de compra pero lleva tiempo sin pedir.",
      needs_attention: "Su frecuencia bajó. Vale la pena contactarla.",
      new:             "Tiene pocos pedidos. Tiene potencial a desarrollar.",
      dormant:         "Sin actividad significativa. Considerar reactivación.",
    }[seg];
  }

  statusLabel(status: OrderStatus | string): string {
    const map: Record<string, string> = {
      borrador: "Borrador", confirmando_proveedor: "Confirmando", en_transito: "En tránsito",
      packing: "Empaque", empaque: "Empaque", ready_for_route: "Listo para ruta",
      in_transit: "En ruta", en_ruta: "En ruta", pago_pendiente: "Pago pendiente",
      pagado_parcial: "Pago parcial", pagado: "Pagado", cancelado: "Cancelado",
      entregado: "Entregado",
    };
    return map[status] ?? status;
  }

  statusClass(status: string): string {
    const map: Record<string, string> = {
      pagado: "badge-paid", pagado_parcial: "badge-partial", pago_pendiente: "badge-warn",
      cancelado: "badge-cancel", en_ruta: "badge-route", in_transit: "badge-route",
      ready_for_route: "badge-ready", assigned_to_run: "badge-ready",
    };
    return map[status] ?? "badge-default";
  }

  goBack(): void {
    this.router.navigate(["/main/clientas"]);
  }

  openOrder(orderId: string): void {
    this.router.navigate(["/main/pedidos", orderId]);
  }

  orderNet(order: Order): number {
    return calculateOrderFinancials(order).netAmount;
  }

  orderBalance(order: Order): number {
    return calculateOrderFinancials(order).balanceDue;
  }

  orderPaid(order: Order): number {
    return calculateOrderFinancials(order).paidAmount;
  }

  orderOverpayment(order: Order): number {
    return calculateOrderFinancials(order).overpaymentAmount;
  }

  orderReturns(order: Order): number {
    return calculateOrderFinancials(order).returnsAmount;
  }

  newOrder(): void {
    this.router.navigate(["/main/pedidos"], { queryParams: { customer_id: this.customerId(), business_id: this.customer()?.business_id } });
  }

  async scheduleFollowUp(): Promise<void> {
    const customer = this.customer();
    if (!customer) return;
    if (!this.followUpDraft()) {
      this.error.set("Selecciona una fecha para el seguimiento.");
      return;
    }
    this.followUpSaving.set(true);
    try {
      const type = this.followUpType();
      await this.followupsService.save({
        business_id: customer.business_id,
        customer_id: customer.customer_id,
        type,
        due_at: this.followUpDraft(),
        title: this.followupTypeLabel(type),
        note: this.followUpNote() || null,
        source: "customer_profile",
      });
      await this.customers.save({ ...customer, follow_up_at: this.followUpDraft() || null });
      await this.followupsService.loadFromFirestore();
      this.customer.set(this.customers.getById(customer.customer_id));
      this.followUpNote.set("");
    } finally {
      this.followUpSaving.set(false);
    }
  }

  async completeFollowup(row: CustomerFollowup): Promise<void> {
    await this.followupsService.completeFollowup(row.followup_id);
    if (row.type === "payment_reminder" && row.order_id) {
      await this.ordersService.updateCollectionState(row.order_id, {
        collection_status: "paid",
        collection_reminder_at: null,
        collection_note: "Seguimiento de cobro marcado como resuelto desde ficha 360.",
      }).catch(() => null);
    }
    await Promise.all([
      this.followupsService.loadFromFirestore().catch(() => null),
      this.ordersService.loadFromFirestore().catch(() => null),
    ]);
    await this.loadOrders(this.customerId());
  }

  async snoozeFollowup(row: CustomerFollowup): Promise<void> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await this.followupsService.snoozeFollowup(row.followup_id, tomorrow.toISOString().slice(0, 10));
    await this.followupsService.loadFromFirestore().catch(() => null);
  }

  async applyCredit(): Promise<void> {
    const orderId = this.creditOrderId();
    if (!orderId) return;
    this.creditApplying.set(true);
    try {
      await this.customers.applyCreditToOrder(this.customerId(), orderId);
      this.customer.set(this.customers.getById(this.customerId()));
      await this.ordersService.loadFromFirestore();
      await this.loadOrders(this.customerId());
      this.creditOrderId.set("");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo aplicar el saldo.");
    } finally {
      this.creditApplying.set(false);
    }
  }

  collectionStatusLabel(status: string | null | undefined): string {
    return {
      none: "Sin estado",
      pending: "Cobro pendiente",
      paid: "Ya cobrado",
      remind_later: "Recordar después",
    }[status || "none"] || "Sin estado";
  }

  followupTypeLabel(type: CustomerFollowupType): string {
    return {
      payment_reminder: "Cobro pendiente",
      post_sale: "Postventa",
      birthday: "Cumpleaños",
      reactivation: "Reactivación",
      quote: "Cotización",
      general_note: "Seguimiento general",
    }[type];
  }

  followupIcon(type: CustomerFollowupType): string {
    return {
      payment_reminder: "payments",
      post_sale: "support_agent",
      birthday: "cake",
      reactivation: "campaign",
      quote: "request_quote",
      general_note: "event_note",
    }[type];
  }

  async copyAssistantDraft(id: string, text: string): Promise<void> {
    await navigator.clipboard.writeText(text).catch(() => null);
    this.assistantCopied.set(id);
    setTimeout(() => this.assistantCopied.set(null), 1800);
  }

  private buildNextAction(): { icon: string; title: string; detail: string } {
    const customer = this.customer();
    if (!customer) return { icon: "flag", title: "Sin acción", detail: "No se encontró la clienta." };
    if (this.totalDebt() > 0) {
      return {
        icon: "payments",
        title: "Revisar cobro antes de vender",
        detail: `Debe ${this.money(this.totalDebt())}. Al generar nota conviene decidir si se cobra ahora o se agenda recordatorio.`,
      };
    }
    const overdue = this.overdueFollowups()[0];
    if (overdue) return { icon: this.followupIcon(overdue.type), title: overdue.title, detail: `Vencido desde ${overdue.due_at}.` };
    const birthdayDays = this.daysUntilBirthday(customer.birthday || null);
    if (birthdayDays !== null && birthdayDays <= 7) {
      return { icon: "cake", title: birthdayDays === 0 ? "Felicitar cumpleaños" : "Preparar cumpleaños", detail: birthdayDays === 0 ? "Cumpleaños hoy." : `Cumple en ${birthdayDays} días.` };
    }
    const days = this.daysSinceLastOrder();
    if (days !== null && days > 60) return { icon: "campaign", title: "Reactivar clienta", detail: `${days} días sin compra. Conviene enviar mensaje corto con novedades.` };
    if (this.dataQualityIssues().length) return { icon: "fact_check", title: "Completar datos 360", detail: this.dataQualityIssues().slice(0, 2).join(", ") };
    return { icon: "support_agent", title: "Postventa ligera", detail: "Revisar satisfacción, preferencias y próxima recomendación." };
  }

  private buildAssistantDrafts(): Array<{ id: string; icon: string; title: string; text: string }> {
    const c = this.customer();
    if (!c) return [];
    const name = c.first_name || "amiga";
    const preferred = [...(c.preferred_categories || []), ...(c.preferred_colors || [])].slice(0, 3).join(", ");
    const drafts: Array<{ id: string; icon: string; title: string; text: string }> = [];
    if (this.totalDebt() > 0) {
      drafts.push({
        id: "collection",
        icon: "payments",
        title: "Cobranza amable",
        text: `Hola ${name}, te comparto que tienes un saldo pendiente de ${this.money(this.totalDebt())}. Cuando puedas lo revisamos para dejar tu cuenta al día. Gracias.`,
      });
    }
    drafts.push({
      id: "post_sale",
      icon: "support_agent",
      title: "Postventa",
      text: `Hola ${name}, ¿cómo te fue con tu último pedido? Si algo no te quedó bien o necesitas cambio, dime y lo revisamos.`,
    });
    if (this.daysUntilBirthday(c.birthday || null) !== null && (this.daysUntilBirthday(c.birthday || null) || 0) <= 14) {
      drafts.push({
        id: "birthday",
        icon: "cake",
        title: "Cumpleaños",
        text: `Hola ${name}, espero que tengas un cumpleaños muy bonito. Te mando un abrazo y mis mejores deseos.`,
      });
    }
    if ((this.daysSinceLastOrder() || 0) > 45) {
      drafts.push({
        id: "reactivation",
        icon: "campaign",
        title: "Reactivación",
        text: `Hola ${name}, me llegaron novedades y pensé en ti${preferred ? ` por tus gustos en ${preferred}` : ""}. Si quieres te mando opciones por WhatsApp.`,
      });
    }
    drafts.push({
      id: "recommendation",
      icon: "auto_awesome",
      title: "Recomendación",
      text: `Hola ${name}, por lo que sueles pedir${preferred ? ` (${preferred})` : ""}, creo que estas piezas te pueden funcionar. Te mando fotos y medidas para que elijas con calma.`,
    });
    return drafts.slice(0, 5);
  }

  private isOverdue(date: string | null | undefined): boolean {
    if (!date) return false;
    const today = new Date().toISOString().slice(0, 10);
    return date < today;
  }

  private daysUntilBirthday(value: string | null): number | null {
    if (!value) return null;
    const parts = value.slice(0, 10).split("-").map(Number);
    if (parts.length < 3 || !parts[1] || !parts[2]) return null;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const birthday = new Date(today.getFullYear(), parts[1] - 1, parts[2]);
    if (birthday < start) birthday.setFullYear(today.getFullYear() + 1);
    return Math.ceil((birthday.getTime() - start.getTime()) / 86_400_000);
  }

  private money(value: number): string {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(value || 0);
  }

  private relativeRfmSegment(): RfmSegment {
    const current = this.customer();
    if (!current) return "dormant";
    const completed = new Set(["pagado", "pagado_parcial", "entregado", "delivered", "delivered_partial", "pago_pendiente", "closed"]);
    const metrics = this.customers.customers()
      .filter((customer) => customer.business_id === current.business_id)
      .map((customer) => {
        const orders = this.ordersService.list().filter((order) => order.customer_id === customer.customer_id && order.business_id === current.business_id && completed.has(String(order.status)) && calculateOrderFinancials(order).netUnits > 0);
        const last = orders.reduce((max, order) => Math.max(max, new Date(order.delivered_at || order.updated_at || order.created_at).getTime() || 0), 0);
        return { id: customer.customer_id, recency: last ? (Date.now() - last) / 86_400_000 : 99999, frequency: orders.length, monetary: orders.reduce((sum, order) => sum + calculateOrderFinancials(order).netAmount, 0) };
      });
    const row = metrics.find((entry) => entry.id === current.customer_id);
    if (!row || row.frequency === 0) return "dormant";
    const rank = (value: number, values: number[], inverse = false) => {
      const sorted = [...values].sort((a, b) => a - b);
      const below = sorted.filter((entry) => entry <= value).length;
      const score = Math.max(1, Math.min(5, Math.ceil((below / Math.max(1, sorted.length)) * 5)));
      return inverse ? 6 - score : score;
    };
    const r = rank(row.recency, metrics.map((entry) => entry.recency), true);
    const f = rank(row.frequency, metrics.map((entry) => entry.frequency));
    const m = rank(row.monetary, metrics.map((entry) => entry.monetary));
    if (r >= 4 && f >= 4 && m >= 4) return "champions";
    if (f >= 4 && m >= 3) return r <= 2 ? "at_risk" : "loyal";
    if (row.frequency <= 1 && r >= 4) return "new";
    if (r <= 2 && (f >= 3 || m >= 3)) return "at_risk";
    if (r <= 2) return "dormant";
    return "needs_attention";
  }
}
