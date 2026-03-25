import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { CurrencyPipe, DatePipe, NgClass, UpperCasePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { lastValueFrom } from "rxjs";
import { FIRESTORE } from "../../core/firebase.providers";
import { CustomersService, Customer } from "../../core/customers.service";
import { RoutesService } from "../../core/routes.service";
import { Order, OrderStatus } from "../../core/orders.service";
import { UserAdminApiService } from "../../services/user-admin-api.service";

// Tipos de notificación (espejo del backend)
export interface WaNotifType {
  id: string;
  label: string;
  description: string;
  default: boolean;
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

interface ProductFreqRow {
  title: string;
  count: number;
  totalSpent: number;
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
    ["pagado", "pagado_parcial", "entregado"].includes(o.status)
  );
  const totalOrders = paid.length;
  if (totalOrders === 0) return "dormant";
  if (totalOrders < 2) return "new";

  const last = paid[0];
  const days = daysSince(last.updated_at || last.created_at);
  const total = paid.reduce((s, o) => s + (o.totals?.total_amount ?? 0), 0);
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
  imports: [RouterLink, CurrencyPipe, DatePipe, NgClass, UpperCasePipe, FormsModule],
  templateUrl: "./clienta-detalle.html",
  styleUrl: "./clienta-detalle.css",
})
export default class ClientaDetallePage implements OnInit {
  private route     = inject(ActivatedRoute);
  private router    = inject(Router);
  private customers = inject(CustomersService);
  private routes    = inject(RoutesService);
  private api       = inject(UserAdminApiService);
  private firestore = FIRESTORE;

  loading    = signal(true);
  customerId = signal("");
  customer   = signal<Customer | null>(null);
  orders     = signal<Order[]>([]);
  error      = signal<string | null>(null);

  // ── Link de seguimiento ───────────────────────────────────────────────
  trackLink        = signal<string | null>(null);
  trackLinkLoading = signal(false);
  trackLinkCopied  = signal(false);

  // ── Notificaciones WhatsApp ───────────────────────────────────────────
  waTypes       = signal<WaNotifType[]>([]);
  waPrefs       = signal<Record<string, boolean>>({});
  waPrefsDirty  = signal(false);
  waPrefsSaving = signal(false);
  waSendLoading = signal<string | null>(null);
  waSendResult  = signal<{ type: string; ok: boolean; msg?: string } | null>(null);

  // ── Computed de análisis ─────────────────────────────────────────────

  paidOrders = computed(() =>
    this.orders().filter(o => ["pagado", "pagado_parcial", "entregado"].includes(o.status))
  );

  activeOrders = computed(() =>
    this.orders().filter(o => !["pagado", "cancelado", "devuelto", "closed"].includes(o.status))
  );

  totalSpent = computed(() =>
    this.paidOrders().reduce((s, o) => s + (o.totals?.total_amount ?? 0), 0)
  );

  totalDebt = computed(() =>
    this.orders()
      .filter(o => ["pago_pendiente", "pagado_parcial"].includes(o.status))
      .reduce((s, o) => s + (o.totals?.balance_due ?? 0), 0)
  );

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

  rfmSegment = computed<RfmSegment>(() => computeRfmSegment(this.paidOrders()));

  /** Top 5 productos más comprados */
  topProducts = computed<ProductFreqRow[]>(() => {
    const freq = new Map<string, ProductFreqRow>();
    for (const order of this.paidOrders()) {
      for (const item of order.items ?? []) {
        const key = (item.title || "").trim().toLowerCase();
        if (!key) continue;
        const existing = freq.get(key) ?? { title: item.title || key, count: 0, totalSpent: 0 };
        existing.count++;
        existing.totalSpent += (item.price_clienta ?? 0) * (item.quantity ?? 1);
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
    ]);

    const c = this.customers.getById(id);
    if (!c) {
      this.error.set("Clienta no encontrada");
      this.loading.set(false);
      return;
    }
    this.customer.set(c);

    // Pre-cargar link de tracking si ya existe
    if ((c as any).tracking_token) {
      this.trackLink.set(this.buildTrackUrl((c as any).tracking_token));
    }

    await Promise.all([
      this.loadOrders(id),
      this.loadWaTypes(),
    ]);

    this.loading.set(false);
  }

  // ── Link de seguimiento ──────────────────────────────────────────────

  private buildTrackUrl(token: string): string {
    return `${window.location.origin}/track/${token}`;
  }

  async generateTrackLink(): Promise<void> {
    this.trackLinkLoading.set(true);
    try {
      const result = await lastValueFrom(
        this.api.post<{ token: string; tracking_url: string }>(
          "/api/admin/track/generate",
          { customer_id: this.customerId() }
        )
      );
      this.trackLink.set(this.buildTrackUrl(result.token));
    } catch (err: any) {
      console.error("[TrackLink] Error:", err);
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
      setTimeout(() => this.trackLinkCopied.set(false), 2500);
    } catch {}
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
    const q = query(
      collection(this.firestore, "orders"),
      where("customer_id", "==", customerId),
      orderBy("created_at", "desc")
    );
    const snap = await getDocs(q).catch(() => null);
    if (!snap) return;
    this.orders.set(snap.docs.map(d => ({ order_id: d.id, ...d.data() } as Order)));
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
}
