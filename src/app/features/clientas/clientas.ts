import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { Customer, CustomersService, OptInStatus } from "../../core/customers.service";
import { LocalitiesService, Locality } from "../../core/localities.service";
import { RoutesService } from "../../core/routes.service";
import { OrdersService } from "../../core/orders.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { BusinessScopeService } from "../../core/business-scope.service";
import { CurrencyPipe, DatePipe } from "@angular/common";

type CustomerFilter = "all" | "active" | "inactive";
type AccountFilter = "all" | "debt" | "credit";
type CustomerSort = "name" | "sales" | "frequency" | "oldest";

interface CustomerDraft {
  customer_id: string;
  first_name: string;
  last_name: string;
  whatsapp: string;
  route_id: string;
  locality_id: string;
  active: boolean;
  notes: string;
  insights_last_order: string;
  insights_total_orders: number | null;
  insights_total_spent: number | null;
  insights_avg_order: number | null;
  insights_avg_units: number | null;
  insights_frequency_days: number | null;
  insights_categories: string;
  insights_products: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-clientas",
  imports: [FormsModule, RouterLink, CurrencyPipe, DatePipe],
  templateUrl: "./clientas.html",
  styleUrl: "./clientas.css",
})
export default class ClientasPage {
  loading = signal(false);
  saving = signal(false);
  togglingId = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  statusFilter = signal<CustomerFilter>("all");
  routeFilter = signal("all");
  localityFilter = signal("all");
  accountFilter = signal<AccountFilter>("all");
  segmentFilter = signal("all");
  activityFilter = signal<"all" | "30" | "60" | "inactive">("all");
  sortBy = signal<CustomerSort>("name");
  editingId = signal<string | null>(null);
  showInsights = signal(false);

  draft: CustomerDraft = this.emptyDraft();

  private customersService = inject(CustomersService);
  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);
  private ordersService = inject(OrdersService);
  private businessScope = inject(BusinessScopeService);

  constructor() {
    this.reload();
  }

  allCustomers = computed(() => this.customersService.customers());
  activeCount = computed(() => this.allCustomers().filter((customer) => customer.active).length);
  inactiveCount = computed(() => this.allCustomers().length - this.activeCount());
  totalNetSales = computed(() => this.allCustomers().reduce((sum, customer) => sum + this.customerMetrics(customer).netSales, 0));
  totalReceivable = computed(() => this.allCustomers().reduce((sum, customer) => sum + this.customerMetrics(customer).balanceDue, 0));
  totalCredits = computed(() => this.allCustomers().reduce((sum, customer) => sum + Number(customer.credit_balance || 0), 0));
  private metricsByCustomer = computed(() => new Map(this.allCustomers().map((customer) => [customer.customer_id, this.calculateCustomerMetrics(customer)])));
  hasActiveFilters = computed(() => Boolean(this.searchTerm().trim()) || this.statusFilter() !== "all" || this.routeFilter() !== "all" || this.localityFilter() !== "all" || this.accountFilter() !== "all" || this.segmentFilter() !== "all" || this.activityFilter() !== "all" || this.sortBy() !== "name");

  routes = computed(() => this.routesService.routes());
  localities = computed(() => this.localitiesService.localities());

  filteredCustomers = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();
    const route = this.routeFilter();
    const locality = this.localityFilter();
    const account = this.accountFilter();
    const segment = this.segmentFilter();
    const activity = this.activityFilter();
    const sort = this.sortBy();

    return [...this.allCustomers()]
      .filter((customer) => {
        const statusOk =
          filter === "all" ||
          (filter === "active" && customer.active) ||
          (filter === "inactive" && !customer.active);
        if (!statusOk) return false;
        if (route !== "all" && (customer.route_id || "") !== route) return false;
        if (locality !== "all" && (customer.locality_id || "") !== locality) return false;
        const metrics = this.customerMetrics(customer);
        if (account === "debt" && metrics.balanceDue <= 0) return false;
        if (account === "credit" && Number(customer.credit_balance || 0) <= 0) return false;
        if (segment !== "all" && this.customerSegment(customer) !== segment) return false;
        const age = metrics.lastOrder ? (Date.now() - new Date(metrics.lastOrder).getTime()) / 86_400_000 : Infinity;
        if (activity === "30" && age > 30) return false;
        if (activity === "60" && age > 60) return false;
        if (activity === "inactive" && age <= 60) return false;
        if (!term) return true;

        const blob = [
          customer.first_name,
          customer.last_name,
          customer.whatsapp,
          this.routeName(customer.route_id),
          this.localityName(customer.locality_id),
          (customer.tags || []).join(" "),
          customer.notes || "",
        ]
          .join(" ")
          .toLowerCase();

        return blob.includes(term);
      })
      .sort((a, b) => {
        if (sort === "sales") return this.customerMetrics(b).netSales - this.customerMetrics(a).netSales;
        if (sort === "frequency") return this.customerMetrics(b).orders - this.customerMetrics(a).orders;
        if (sort === "oldest") return new Date(this.customerMetrics(a).lastOrder || 0).getTime() - new Date(this.customerMetrics(b).lastOrder || 0).getTime();
        const nameA = `${a.first_name} ${a.last_name}`.trim();
        const nameB = `${b.first_name} ${b.last_name}`.trim();
        return nameA.localeCompare(nameB, "es", { sensitivity: "base" });
      });
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await Promise.all([
        this.customersService.loadFromFirestore(),
        this.routesService.loadFromFirestore(),
        this.localitiesService.loadFromFirestore(),
        this.ordersService.loadFromFirestore(),
      ]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar las clientas");
    } finally {
      this.loading.set(false);
    }
  }

  onStatusFilterChange(value: string) {
    const next: CustomerFilter = value === "active" || value === "inactive" || value === "all" ? value : "all";
    this.statusFilter.set(next);
  }

  clearFilters() {
    this.searchTerm.set("");
    this.statusFilter.set("all");
    this.routeFilter.set("all");
    this.localityFilter.set("all");
    this.accountFilter.set("all");
    this.segmentFilter.set("all");
    this.activityFilter.set("all");
    this.sortBy.set("name");
  }

  onRouteChange(routeId: string) {
    const nextRouteId = (routeId || "").trim();
    this.draft.route_id = nextRouteId;

    if (!nextRouteId) {
      this.draft.locality_id = "";
      return;
    }

    const allowedLocalityIds = new Set(this.routeLocalityIds(nextRouteId));
    if (!allowedLocalityIds.has(this.draft.locality_id)) {
      this.draft.locality_id = "";
    }
  }

  startCreate() {
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.showInsights.set(false);
    this.error.set(null);
    this.success.set(null);
  }

  startEdit(customer: Customer) {
    this.editingId.set(customer.customer_id);
    this.draft = {
      customer_id: customer.customer_id,
      first_name: customer.first_name || "",
      last_name: customer.last_name || "",
      whatsapp: customer.whatsapp || "",
      route_id: customer.route_id || "",
      locality_id: customer.locality_id || "",
      active: customer.active,
      notes: customer.notes || "",
      insights_last_order: customer.insights?.last_order_at || "",
      insights_total_orders: customer.insights?.total_orders ?? null,
      insights_total_spent: customer.insights?.total_spent ?? null,
      insights_avg_order: customer.insights?.avg_order_value ?? null,
      insights_avg_units: customer.insights?.avg_units_per_order ?? null,
      insights_frequency_days: customer.insights?.frequency_days ?? null,
      insights_categories: (customer.insights?.preferred_categories || []).join(", "),
      insights_products: (customer.insights?.preferred_products || []).join(", "),
    };

    this.showInsights.set(Boolean(customer.insights));
    this.error.set(null);
    this.success.set(null);
  }

  cancelEdit() {
    this.startCreate();
  }

  async saveCustomer() {
    this.error.set(null);
    this.success.set(null);

    const firstName = this.draft.first_name.trim();
    const lastName = this.draft.last_name.trim();
    const whatsapp = this.draft.whatsapp.trim();

    if (!firstName || !lastName) {
      this.error.set("Nombre y apellido son obligatorios");
      return;
    }

    if (!whatsapp) {
      this.error.set("El telefono de WhatsApp es obligatorio");
      return;
    }

    this.saving.set(true);

    try {
      const existing = this.editingId() ? this.customersService.getById(this.editingId()!) : null;
      const createdAt = existing?.created_at || new Date();

      const draftId = this.editingId() || this.buildCustomerId(firstName, lastName, whatsapp);

      const payload: Customer = {
        customer_id: draftId,
        business_id: existing?.business_id || this.businessScope.writeBusinessId(),
        first_name: firstName,
        last_name: lastName,
        whatsapp,
        route_id: this.draft.route_id || null,
        locality_id: this.draft.locality_id || null,
        active: this.draft.active,
        notes: this.draft.notes.trim(),
        tags: existing?.tags || [],
        opt_in: existing?.opt_in || null,
        insights: null,
        credit_balance: existing?.credit_balance || 0,
        created_at: createdAt,
      };

      await this.customersService.save(payload);
      this.success.set(this.editingId() ? "Clienta actualizada" : "Clienta creada");

      if (!this.editingId()) {
        this.startCreate();
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la clienta");
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(customer: Customer, nextActive: boolean) {
    if (customer.active === nextActive) return;

    this.togglingId.set(customer.customer_id);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.customersService.setActive(customer.customer_id, nextActive);
      this.success.set(nextActive ? "Clienta activada" : "Clienta desactivada");

      if (this.editingId() === customer.customer_id) {
        this.draft = { ...this.draft, active: nextActive };
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
    } finally {
      this.togglingId.set(null);
    }
  }

  isBusy(customerId: string): boolean {
    return this.togglingId() === customerId;
  }

  routeName(routeId: string | null): string {
    if (!routeId) return "Sin ruta";
    return this.routesService.getById(routeId)?.name || routeId;
  }

  localityName(localityId: string | null): string {
    if (!localityId) return "Sin localidad";
    return this.localitiesService.getById(localityId)?.name || localityId;
  }

  localitiesForRoute(routeId: string): Locality[] {
    const routeLocalityIds = this.routeLocalityIds(routeId);
    if (routeLocalityIds.length === 0) return [];

    const allowed = new Set(routeLocalityIds);
    return this.localities().filter((locality) => allowed.has(locality.locality_id));
  }

  private emptyDraft(): CustomerDraft {
    return {
      customer_id: "",
      first_name: "",
      last_name: "",
      whatsapp: "",
      route_id: "",
      locality_id: "",
      active: true,
      notes: "",
      insights_last_order: "",
      insights_total_orders: null,
      insights_total_spent: null,
      insights_avg_order: null,
      insights_avg_units: null,
      insights_frequency_days: null,
      insights_categories: "",
      insights_products: "",
    };
  }

  private parseTags(value: string): string[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private routeLocalityIds(routeId: string): string[] {
    if (!routeId) return [];
    const route = this.routesService.getById(routeId);
    if (!route || !Array.isArray(route.locality_ids)) return [];
    return route.locality_ids.filter(Boolean);
  }

  private buildCustomerId(firstName: string, lastName: string, phone: string): string {
    const base = this.slugify(`${firstName} ${lastName}`) || "clienta";
    const digits = phone.replace(/\D/g, "");
    const suffix = digits.slice(-4) || Date.now().toString(36).slice(-4);
    return `${this.businessScope.writeBusinessId()}-${base}-${suffix}`;
  }

  customerMetrics(customer: Customer): { orders: number; netSales: number; balanceDue: number; average: number; returns: number; lastOrder: string | null } {
    return this.metricsByCustomer().get(customer.customer_id) || this.calculateCustomerMetrics(customer);
  }

  private calculateCustomerMetrics(customer: Customer): { orders: number; netSales: number; balanceDue: number; average: number; returns: number; lastOrder: string | null } {
    const rows = this.ordersService.list().filter((order) => order.customer_id === customer.customer_id && order.business_id === customer.business_id);
    const delivered = rows.filter((order) => Boolean(order.delivered_at) || ["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed"].includes(order.status));
    const completed = delivered.filter((order) => calculateOrderFinancials(order).netUnits > 0);
    let netSales = 0;
    let balanceDue = 0;
    let returns = 0;
    for (const order of delivered) {
      const financials = calculateOrderFinancials(order);
      returns += financials.returnsAmount;
    }
    for (const order of completed) {
      const financials = calculateOrderFinancials(order);
      netSales += financials.netAmount;
      balanceDue += financials.balanceDue;
    }
    const lastOrder = completed
      .map((order) => order.delivered_at || order.updated_at || order.created_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    return {
      orders: completed.length,
      netSales,
      balanceDue,
      average: completed.length > 0 ? netSales / completed.length : 0,
      returns,
      lastOrder,
    };
  }

  customerSegment(customer: Customer): "champions" | "loyal" | "risk" | "new" | "dormant" {
    const rows = this.allCustomers().filter((entry) => entry.business_id === customer.business_id);
    const metrics = rows.map((entry) => ({ id: entry.customer_id, ...this.customerMetrics(entry) }));
    const current = metrics.find((entry) => entry.id === customer.customer_id)!;
    if (!current || current.orders === 0) return "dormant";
    const rank = (value: number, values: number[]) => Math.max(1, Math.min(5, Math.ceil((values.filter((entry) => entry <= value).length / Math.max(1, values.length)) * 5)));
    const recency = current.lastOrder ? (Date.now() - new Date(current.lastOrder).getTime()) / 86_400_000 : 99999;
    const recencies = metrics.map((entry) => entry.lastOrder ? (Date.now() - new Date(entry.lastOrder).getTime()) / 86_400_000 : 99999);
    const r = 6 - rank(recency, recencies);
    const f = rank(current.orders, metrics.map((entry) => entry.orders));
    const m = rank(current.netSales, metrics.map((entry) => entry.netSales));
    if (r >= 4 && f >= 4 && m >= 4) return "champions";
    if (r <= 2 && (f >= 3 || m >= 3)) return "risk";
    if (current.orders === 1 && r >= 4) return "new";
    if (r <= 2) return "dormant";
    return "loyal";
  }

  segmentLabel(segment: string): string {
    return ({ champions: "Estrella", loyal: "Fiel", risk: "En riesgo", new: "Nueva", dormant: "Inactiva" } as Record<string, string>)[segment] || segment;
  }

  private slugify(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private toNumberOrNull(value: number | null): number | null {
    if (value === null || value === undefined || value === ("" as any)) return null;
    if (!Number.isFinite(value)) return null;
    return value;
  }
}
