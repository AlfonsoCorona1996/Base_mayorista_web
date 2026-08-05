import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { CurrencyPipe, DatePipe } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { lastValueFrom } from "rxjs";
import {
  TrackDashboard,
  TrackDashboardSection,
  TrackMode,
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
  readonly section = signal<TrackMode>("bm");
  private readonly historyItems = signal<Record<TrackMode, TrackOrderSummary[]>>({ bm: [], catalogo: [] });
  private readonly historyCursorByMode = signal<Record<TrackMode, string | null>>({ bm: null, catalogo: null });
  private readonly returnItems = signal<Record<TrackMode, TrackReturn[]>>({ bm: [], catalogo: [] });
  private readonly returnsCursorByMode = signal<Record<TrackMode, string | null>>({ bm: null, catalogo: null });
  readonly loadingMore = signal(false);
  readonly paginationError = signal<PortalTab | null>(null);

  readonly history = computed(() => this.historyItems()[this.section()]);
  readonly returns = computed(() => this.returnItems()[this.section()]);
  readonly historyCursor = computed(() => this.historyCursorByMode()[this.section()]);
  readonly returnsCursor = computed(() => this.returnsCursorByMode()[this.section()]);

  /** Cada modo (BM/Catalogo) se muestra por separado, nunca combinado. Si la
   * clienta solo tiene pedidos de un modo, la otra seccion queda oculta. */
  readonly currentSection = computed<TrackDashboardSection | null>(() => this.data()?.[this.section()] ?? null);
  readonly hasBmData = computed(() => this.sectionHasData(this.data()?.bm));
  readonly hasCatalogoData = computed(() => this.sectionHasData(this.data()?.catalogo));
  readonly showSectionToggle = computed(() => this.hasBmData() && this.hasCatalogoData());

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

  selectSection(mode: TrackMode): void {
    this.section.set(mode);
  }

  async retry(): Promise<void> {
    await this.load();
  }

  async loadMoreHistory(): Promise<void> {
    const mode = this.section();
    const cursor = this.historyCursorByMode()[mode];
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.paginationError.set(null);
    try {
      const page = await lastValueFrom(this.portal.loadHistory(this.token(), cursor, mode));
      this.historyItems.update((state) => ({ ...state, [mode]: [...state[mode], ...page.items] }));
      this.historyCursorByMode.update((state) => ({ ...state, [mode]: page.next_cursor }));
    } catch {
      this.paginationError.set("history");
    } finally {
      this.loadingMore.set(false);
    }
  }

  async loadMoreReturns(): Promise<void> {
    const mode = this.section();
    const cursor = this.returnsCursorByMode()[mode];
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.paginationError.set(null);
    try {
      const page = await lastValueFrom(this.portal.loadReturns(this.token(), cursor, mode));
      this.returnItems.update((state) => ({ ...state, [mode]: [...state[mode], ...page.items] }));
      this.returnsCursorByMode.update((state) => ({ ...state, [mode]: page.next_cursor }));
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

  private sectionHasData(section: TrackDashboardSection | undefined): boolean {
    if (!section) return false;
    const s = section.summary;
    return s.active_orders + s.completed_orders + s.returns_count > 0;
  }

  private pickDefaultSection(data: TrackDashboard): TrackMode {
    if (this.sectionHasData(data.bm)) return "bm";
    if (this.sectionHasData(data.catalogo)) return "catalogo";
    return "bm";
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
      this.historyItems.set({ bm: result.bm.history.items, catalogo: result.catalogo.history.items });
      this.historyCursorByMode.set({ bm: result.bm.history.next_cursor, catalogo: result.catalogo.history.next_cursor });
      this.returnItems.set({ bm: result.bm.returns.items, catalogo: result.catalogo.returns.items });
      this.returnsCursorByMode.set({ bm: result.bm.returns.next_cursor, catalogo: result.catalogo.returns.next_cursor });
      this.section.set(this.pickDefaultSection(result));
    } catch (error: unknown) {
      this.error.set(error instanceof HttpErrorResponse && error.status === 404 ? "invalid" : "unavailable");
    } finally {
      this.loading.set(false);
    }
  }
}
