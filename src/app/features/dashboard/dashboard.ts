import { Component, ChangeDetectionStrategy, inject, OnInit, signal } from "@angular/core";
import { RouterLink, Router } from "@angular/router";
import { CurrencyPipe, DatePipe, NgClass } from "@angular/common";
import { lastValueFrom } from "rxjs";
import { SmartAlertsService, SmartAlert, AlertSeverity } from "../../core/smart-alerts.service";
import { OrdersService } from "../../core/orders.service";
import { CustomersService } from "../../core/customers.service";
import { RoutesService } from "../../core/routes.service";
import { RouteRunsService } from "../../services/route-runs.service";
import { AuthzService } from "../../core/authz.service";
import { UserAdminApiService } from "../../services/user-admin-api.service";

interface AlertGroup {
  category: string;
  label: string;
  icon: string;
  alerts: SmartAlert[];
}

interface MarketInsightTopProduct {
  title: string;
  units: number;
  orderCount: number;
  revenue: number;
}

interface MarketInsightTopCategory {
  category: string;
  units: number;
  orderCount: number;
  revenue: number;
}

interface MarketInsightNiche {
  niche: string;
  rationale: string;
  sampleProducts: string[];
  demandSignal: string;
  riskLevel: string;
  firstAction: string;
}

interface MarketInsightsSnapshot {
  generated_at: string;
  window_days: number;
  source: string | null;
  model: string | null;
  prompt_version: string | null;
  ai_error?: {
    name?: string | null;
    message?: string | null;
    code?: string | null;
    status?: number | null;
  } | null;
  totals?: {
    orders_considered?: number;
    top_products_count?: number;
    top_categories_count?: number;
    active_customers?: number;
  } | null;
  top_products?: MarketInsightTopProduct[];
  top_categories?: MarketInsightTopCategory[];
  ai_insights?: {
    summary?: string;
    nicheIdeas?: MarketInsightNiche[];
    crossSellIdeas?: string[];
    watchouts?: string[];
    next7DaysPlan?: string[];
  } | null;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-dashboard",
  imports: [RouterLink, CurrencyPipe, DatePipe, NgClass],
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.css",
})
export default class DashboardPage implements OnInit {
  readonly alertsSvc = inject(SmartAlertsService);
  private readonly ordersSvc = inject(OrdersService);
  private readonly customersSvc = inject(CustomersService);
  private readonly routesSvc = inject(RoutesService);
  private readonly routeRuns = inject(RouteRunsService);
  private readonly authz = inject(AuthzService);
  private readonly router = inject(Router);
  private readonly api = inject(UserAdminApiService);

  readonly alerts = this.alertsSvc.allAlerts;
  readonly kpis = this.alertsSvc.kpis;
  readonly criticalCount = this.alertsSvc.criticalCount;
  readonly schedulingRouteId = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly skeletonKpiCards = [0, 1, 2, 3, 4];
  readonly skeletonAlertColumns = [0, 1];
  readonly skeletonAlertItems = [0, 1];
  readonly skeletonQuicklinks = [0, 1, 2, 3, 4, 5];
  readonly marketInsightsLoading = signal(true);
  readonly marketInsightsGenerating = signal(false);
  readonly marketInsightsError = signal<string | null>(null);
  readonly marketInsights = signal<MarketInsightsSnapshot | null>(null);

  dismissed = new Set<string>();

  private readonly catMeta: Record<string, { label: string; icon: string }> = {
    routes:       { label: "Rutas",            icon: "route" },
    orders:       { label: "Pedidos",           icon: "inventory" },
    finance:      { label: "Finanzas",          icon: "payments" },
    customers:    { label: "Clientas",          icon: "group" },
    products:     { label: "Catálogo",          icon: "category" },
    data_quality: { label: "Calidad de datos",  icon: "data_alert" },
    ai_insight:   { label: "Insight IA",        icon: "psychology" },
  };

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([
        this.ordersSvc.loadFromFirestore(),
        this.customersSvc.loadFromFirestore(),
        this.routesSvc.loadFromFirestore(),
      ]);
      await this.loadMarketInsightsLatest();
    } finally {
      this.loading.set(false);
    }
  }

  visibleAlerts(): SmartAlert[] {
    return this.alerts().filter(a => !this.dismissed.has(a.id));
  }

  alertGroups(): AlertGroup[] {
    const map = new Map<string, SmartAlert[]>();
    for (const alert of this.visibleAlerts()) {
      if (!map.has(alert.category)) map.set(alert.category, []);
      map.get(alert.category)!.push(alert);
    }
    return [...map.entries()].map(([cat, alerts]) => ({
      category: cat,
      ...(this.catMeta[cat] ?? { label: cat, icon: "notifications" }),
      alerts,
    }));
  }

  dismiss(id: string): void {
    this.dismissed.add(id);
  }

  severityLabel(s: AlertSeverity): string {
    return { critical: "Crítico", urgent: "Urgente", warning: "Aviso", opportunity: "Oportunidad" }[s];
  }

  now(): Date {
    return new Date();
  }

  marketInsightTopProducts(): MarketInsightTopProduct[] {
    return (this.marketInsights()?.top_products || []).slice(0, 8);
  }

  marketInsightTopCategories(): MarketInsightTopCategory[] {
    return (this.marketInsights()?.top_categories || []).slice(0, 8);
  }

  marketInsightNiches(): MarketInsightNiche[] {
    return (this.marketInsights()?.ai_insights?.nicheIdeas || []).slice(0, 6);
  }

  marketInsightCrossSellIdeas(): string[] {
    return (this.marketInsights()?.ai_insights?.crossSellIdeas || []).slice(0, 6);
  }

  marketInsightWatchouts(): string[] {
    return (this.marketInsights()?.ai_insights?.watchouts || []).slice(0, 6);
  }

  marketInsightNext7Days(): string[] {
    return (this.marketInsights()?.ai_insights?.next7DaysPlan || []).slice(0, 6);
  }

  marketInsightsSummary(): string {
    return this.marketInsights()?.ai_insights?.summary || "Sin resumen disponible.";
  }

  marketInsightsGeneratedAt(): string | null {
    return this.marketInsights()?.generated_at || null;
  }

  marketInsightsFallbackMessage(): string | null {
    const snapshot = this.marketInsights();
    if (!snapshot) return null;

    const source = String(snapshot.source || "");
    if (!source.startsWith("heuristic")) return null;

    const code = String(snapshot.ai_error?.code || "").trim();
    if (code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") {
      return "Analisis generado con datos internos. La conexion segura del servidor al proveedor de IA requiere ajustar certificados.";
    }

    return "Analisis generado con datos internos. El proveedor de IA no respondio en este intento.";
  }

  async generateMarketInsights(): Promise<void> {
    if (this.marketInsightsGenerating()) return;

    this.marketInsightsGenerating.set(true);
    this.marketInsightsError.set(null);
    try {
      const response = await lastValueFrom(
        this.api.post<{ ok?: boolean; snapshot?: MarketInsightsSnapshot | null }>("/api/admin/market-insights/generate", {
          windowDays: 42,
        }),
      );
      const snapshot = response?.snapshot || null;
      this.marketInsights.set(snapshot);
    } catch (err: any) {
      this.marketInsightsError.set(
        err?.error?.message || err?.message || "No se pudo generar el analisis comercial.",
      );
    } finally {
      this.marketInsightsGenerating.set(false);
      this.marketInsightsLoading.set(false);
    }
  }

  private async loadMarketInsightsLatest(): Promise<void> {
    this.marketInsightsLoading.set(true);
    this.marketInsightsError.set(null);

    try {
      const response = await lastValueFrom(
        this.api.get<{ ok?: boolean; snapshot?: MarketInsightsSnapshot | null }>("/api/admin/market-insights/latest"),
      );
      const snapshot = response?.snapshot || null;
      this.marketInsights.set(snapshot);
    } catch (err: any) {
      this.marketInsightsError.set(
        err?.error?.message || err?.message || "No se pudo cargar el analisis comercial.",
      );
    } finally {
      this.marketInsightsLoading.set(false);
    }
  }

  // ── Smart actions ────────────────────────────────────────────────────────

  smartActionLabel(alert: SmartAlert): string {
    if (alert.id.startsWith("unscheduled_route:")) return "Programar ruta";
    if (
      alert.id.startsWith("stale_order:") &&
      (alert.meta?.["status"] as string) === "ready_for_route"
    ) {
      return "Asignar a ruta";
    }
    return alert.actionLabel ?? "Ver";
  }

  smartActionIcon(alert: SmartAlert): string {
    if (alert.id.startsWith("unscheduled_route:")) return "add_road";
    if (
      alert.id.startsWith("stale_order:") &&
      (alert.meta?.["status"] as string) === "ready_for_route"
    ) {
      return "route";
    }
    return "arrow_forward";
  }

  hasCustomAction(alert: SmartAlert): boolean {
    return (
      alert.id.startsWith("unscheduled_route:") ||
      (alert.id.startsWith("stale_order:") &&
        (alert.meta?.["status"] as string) === "ready_for_route")
    );
  }

  isSchedulingRoute(alert: SmartAlert): boolean {
    const routeId = alert.meta?.["routeId"] as string | null;
    return !!routeId && this.schedulingRouteId() === routeId;
  }

  async handleSmartAction(alert: SmartAlert): Promise<void> {
    this.actionError.set(null);

    if (alert.id.startsWith("unscheduled_route:")) {
      await this.scheduleRoute(alert);
      return;
    }

    if (
      alert.id.startsWith("stale_order:") &&
      (alert.meta?.["status"] as string) === "ready_for_route"
    ) {
      const rawRouteId = (alert.meta?.["routeId"] as string | null) ?? null;
      const routeId = rawRouteId && rawRouteId !== "__sin_ruta__" ? rawRouteId : "all";
      const orderId = alert.meta?.["orderId"] as string;
      await this.router.navigate(["/main/salidas"], {
        queryParams: { routeId, openRoute: "1", scheduleOrderId: orderId },
      });
      return;
    }

    if (alert.actionUrl) {
      await this.router.navigateByUrl(alert.actionUrl);
    }
  }

  private async scheduleRoute(alert: SmartAlert): Promise<void> {
    const routeId = alert.meta?.["routeId"] as string | null;
    const routeName = alert.meta?.["routeName"] as string;

    if (!routeId || routeId === "__sin_ruta__") {
      await this.router.navigateByUrl("/main/salidas");
      return;
    }

    const user = this.authz.currentUserSig();
    if (!user) {
      this.actionError.set("No hay usuario activo.");
      return;
    }

    const actor = { uid: user.uid, name: user.displayName || user.email || "Usuario" };
    this.schedulingRouteId.set(routeId);
    try {
      const runId = await this.routeRuns.createDraftRun(routeId, routeName, actor);
      await this.router.navigateByUrl(`/main/salidas/${runId}`);
    } catch (err: any) {
      this.actionError.set(err?.message || "No se pudo programar la salida.");
      await this.router.navigate(["/main/salidas"], {
        queryParams: { routeId, openRoute: "1" },
      });
    } finally {
      this.schedulingRouteId.set(null);
    }
  }
}
