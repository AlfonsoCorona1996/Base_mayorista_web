import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { HttpClient } from "@angular/common/http";
import { CurrencyPipe, DatePipe, NgClass } from "@angular/common";
import { lastValueFrom } from "rxjs";
import { environment } from "../../../../environments/environment";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos de la respuesta del backend
// ─────────────────────────────────────────────────────────────────────────────

interface TrackItem {
  title: string;
  variant: string | null;
  color: string | null;
  quantity: number;
  returned_qty?: number;
  net_qty?: number;
}

interface TrackCancelledItem {
  title: string;
  reason: string;
}

interface TrackOrder {
  order_id: string;
  status: string;
  status_label: string;
  created_at: string;
  updated_at: string;
  items: TrackItem[];
  cancelled_items: TrackCancelledItem[];
  totals: { total_amount: number; paid_amount: number; balance_due: number; gross_amount?: number; returns_amount?: number; net_amount?: number; overpayment_amount?: number };
}

interface TrackData {
  customer: { first_name: string; last_name: string };
  active_orders: TrackOrder[];
  history_orders: TrackOrder[];
  total_debt: number;
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-order-tracker",
  imports: [CurrencyPipe, DatePipe, NgClass],
  templateUrl: "./order-tracker.html",
  styleUrl: "./order-tracker.css",
})
export default class OrderTrackerPage implements OnInit {
  private route = inject(ActivatedRoute);
  private http   = inject(HttpClient);

  loading = signal(true);
  error   = signal<string | null>(null);
  data    = signal<TrackData | null>(null);

  /** Pedido activo principal (el más reciente no terminal) */
  mainOrder = computed(() => this.data()?.active_orders?.[0] ?? null);

  /** Progreso del pedido en la cadena (0–100) */
  progress = computed(() => {
    const o = this.mainOrder();
    if (!o) return 0;
    const steps = [
      "borrador", "confirmando_proveedor", "en_transito", "packing",
      "empaque", "ready_for_route", "assigned_to_run", "in_transit",
      "en_ruta", "pago_pendiente", "pagado",
    ];
    const idx = steps.indexOf(o.status);
    return idx < 0 ? 10 : Math.round(((idx + 1) / steps.length) * 100);
  });

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.paramMap.get("token") ?? "";
    if (!token) {
      this.error.set("El enlace no es válido.");
      this.loading.set(false);
      return;
    }
    await this.load(token);
  }

  private async load(token: string): Promise<void> {
    try {
      const url = `${environment.adminApiBaseUrl}/api/track/${token}`;
      const result = await lastValueFrom(this.http.get<TrackData>(url));
      this.data.set(result);
    } catch (err: any) {
      const msg = err?.error?.message ?? err?.message ?? "Error al cargar el seguimiento.";
      this.error.set(msg);
    } finally {
      this.loading.set(false);
    }
  }

  statusEmoji(status: string): string {
    if (["pagado", "entregado"].includes(status)) return "✅";
    if (["in_transit", "en_ruta", "assigned_to_run"].includes(status)) return "🚚";
    if (["packing", "empaque", "ready_for_route"].includes(status)) return "📦";
    if (["cancelado", "devuelto"].includes(status)) return "❌";
    return "⏳";
  }

  isTerminal(status: string): boolean {
    return ["pagado", "cancelado", "devuelto", "closed", "entregado"].includes(status);
  }

  netTotal(order: TrackOrder): number {
    return Number(order.totals.net_amount ?? order.totals.total_amount ?? 0);
  }

  netQty(item: TrackItem): number {
    return Math.max(0, Number(item.net_qty ?? item.quantity - Number(item.returned_qty || 0)));
  }
}
