import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { CurrencyPipe, DatePipe } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { lastValueFrom } from "rxjs";
import { TrackOrderDetailResponse, TrackingPortalService } from "./tracking-portal.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-order-tracker-detail",
  imports: [CurrencyPipe, DatePipe, RouterLink],
  templateUrl: "./order-tracker-detail.html",
  styleUrl: "./order-tracker-detail.css",
})
export default class OrderTrackerDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly portal = inject(TrackingPortalService);

  readonly token = signal(this.route.snapshot.paramMap.get("token") ?? "");
  readonly orderId = signal(this.route.snapshot.paramMap.get("orderId") ?? "");
  readonly loading = signal(true);
  readonly error = signal<"invalid" | "unavailable" | null>(null);
  readonly data = signal<TrackOrderDetailResponse | null>(null);
  readonly whatsappHref = computed(() => {
    const number = this.data()?.support.whatsapp_number || "523310167906";
    const order = this.shortOrderId(this.orderId());
    return `https://wa.me/${number}?text=${encodeURIComponent(`Hola, necesito ayuda con mi pedido ${order}.`)}`;
  });

  constructor() {
    void this.load();
  }

  async retry(): Promise<void> {
    await this.load();
  }

  shortOrderId(orderId: string): string {
    return orderId.length > 14 ? orderId.slice(-14).toUpperCase() : orderId.toUpperCase();
  }

  statusIcon(key: string): string {
    if (["delivered", "confirmed"].includes(key)) return "check_circle";
    if (["in_transit", "delivered_pending", "delivered_partial"].includes(key)) return "local_shipping";
    if (["packed", "packing"].includes(key)) return "inventory_2";
    if (["cancelled", "unavailable"].includes(key)) return "cancel";
    if (["returned", "substitute"].includes(key)) return "assignment_return";
    return "schedule";
  }

  stageIcon(state: string): string {
    if (state === "complete") return "check";
    if (state === "problem") return "close";
    return "radio_button_checked";
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    if (!this.token() || !this.orderId()) {
      this.error.set("invalid");
      this.loading.set(false);
      return;
    }
    try {
      this.data.set(await lastValueFrom(this.portal.loadOrder(this.token(), this.orderId())));
    } catch (error: unknown) {
      this.error.set(error instanceof HttpErrorResponse && error.status === 404 ? "invalid" : "unavailable");
    } finally {
      this.loading.set(false);
    }
  }
}
