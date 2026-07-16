import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { CurrencyPipe, DatePipe } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { lastValueFrom } from "rxjs";
import {
  TrackDashboard,
  TrackOrderSummary,
  TrackReturn,
  TrackingPortalService,
} from "./tracking-portal.service";

type PortalTab = "active" | "history" | "returns";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-order-tracker",
  imports: [CurrencyPipe, DatePipe, RouterLink],
  templateUrl: "./order-tracker.html",
  styleUrl: "./order-tracker.css",
})
export default class OrderTrackerPage {
  private readonly route = inject(ActivatedRoute);
  private readonly portal = inject(TrackingPortalService);

  readonly token = signal(this.route.snapshot.paramMap.get("token") ?? "");
  readonly loading = signal(true);
  readonly error = signal<"invalid" | "unavailable" | null>(null);
  readonly data = signal<TrackDashboard | null>(null);
  readonly activeTab = signal<PortalTab>("active");
  readonly history = signal<TrackOrderSummary[]>([]);
  readonly returns = signal<TrackReturn[]>([]);
  readonly historyCursor = signal<string | null>(null);
  readonly returnsCursor = signal<string | null>(null);
  readonly loadingMore = signal(false);
  readonly paginationError = signal<PortalTab | null>(null);

  readonly whatsappHref = computed(() => {
    const number = this.data()?.support.whatsapp_number || "523310167906";
    return `https://wa.me/${number}?text=${encodeURIComponent("Hola, necesito ayuda con el seguimiento de mis pedidos.")}`;
  });

  constructor() {
    void this.load();
  }

  selectTab(tab: PortalTab): void {
    this.activeTab.set(tab);
  }

  async retry(): Promise<void> {
    await this.load();
  }

  async loadMoreHistory(): Promise<void> {
    const cursor = this.historyCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.paginationError.set(null);
    try {
      const page = await lastValueFrom(this.portal.loadHistory(this.token(), cursor));
      this.history.update((rows) => [...rows, ...page.items]);
      this.historyCursor.set(page.next_cursor);
    } catch {
      this.paginationError.set("history");
    } finally {
      this.loadingMore.set(false);
    }
  }

  async loadMoreReturns(): Promise<void> {
    const cursor = this.returnsCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.paginationError.set(null);
    try {
      const page = await lastValueFrom(this.portal.loadReturns(this.token(), cursor));
      this.returns.update((rows) => [...rows, ...page.items]);
      this.returnsCursor.set(page.next_cursor);
    } catch {
      this.paginationError.set("returns");
    } finally {
      this.loadingMore.set(false);
    }
  }

  shortOrderId(orderId: string): string {
    return orderId.length > 14 ? orderId.slice(-14).toUpperCase() : orderId.toUpperCase();
  }

  statusIcon(key: string): string {
    if (["delivered", "completed"].includes(key)) return "check_circle";
    if (["in_transit", "delivered_pending", "delivered_partial"].includes(key)) return "local_shipping";
    if (["packed", "packing"].includes(key)) return "inventory_2";
    if (["cancelled", "unavailable"].includes(key)) return "cancel";
    if (["returned", "review"].includes(key)) return "assignment_return";
    return "schedule";
  }

  private async load(): Promise<void> {
    const token = this.token();
    this.loading.set(true);
    this.error.set(null);
    if (!token) {
      this.error.set("invalid");
      this.loading.set(false);
      return;
    }
    try {
      const result = await lastValueFrom(this.portal.loadDashboard(token));
      this.data.set(result);
      this.history.set(result.history.items);
      this.historyCursor.set(result.history.next_cursor);
      this.returns.set(result.returns.items);
      this.returnsCursor.set(result.returns.next_cursor);
    } catch (error: unknown) {
      this.error.set(error instanceof HttpErrorResponse && error.status === 404 ? "invalid" : "unavailable");
    } finally {
      this.loading.set(false);
    }
  }
}
