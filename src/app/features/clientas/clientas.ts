import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { CommercialStage, Customer, CustomersService } from "../../core/customers.service";
import { LocalitiesService, Locality } from "../../core/localities.service";
import { RoutePlan, RoutesService } from "../../core/routes.service";
import { OrdersService } from "../../core/orders.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { BusinessScopeService } from "../../core/business-scope.service";
import { CurrencyPipe, DatePipe } from "@angular/common";
import { CustomerFollowup, CustomerFollowupsService } from "../../core/customer-followups.service";

type CustomerFilter = "all" | "active" | "inactive";
type AccountFilter = "all" | "debt" | "credit";
type FollowupFilter = "all" | "pending";
type CustomerSort = "name" | "route" | "lastOrder" | "sales" | "orders" | "balanceDue" | "status";
type SortDirection = "asc" | "desc";
type CustomerSegment = "champions" | "loyal" | "risk" | "new" | "dormant" | "collection" | "returns";
type ClientsTab = "clients" | "actions";
type DrawerMode = "create" | "edit";
type ActionCategory = "collection" | "post_sale" | "birthday" | "reactivation" | "missing_data";
type StatusTone = "active" | "inactive" | "risk" | "debt" | "credit" | "info" | "warning";

interface FilterChip {
  key: string;
  label: string;
}

interface StatusPill {
  label: string;
  tone: StatusTone;
}

interface CustomerMetrics {
  orders: number;
  netSales: number;
  balanceDue: number;
  average: number;
  returns: number;
  returnRate: number;
  lastOrder: string | null;
  daysSinceLastOrder: number | null;
}

interface CustomerDraft {
  customer_id: string;
  first_name: string;
  last_name: string;
  whatsapp: string;
  route_id: string;
  locality_id: string;
  active: boolean;
  birthday: string;
  address: string;
  delivery_reference: string;
  commercial_stage: CommercialStage | "";
  preferred_sizes: string;
  preferred_categories: string;
  preferred_colors: string;
  source: string;
  wa_opt_in_notes: string;
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
  imports: [FormsModule, CurrencyPipe, DatePipe],
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
  followupFilter = signal<FollowupFilter>("all");
  segmentFilter = signal("all");
  activityFilter = signal<"all" | "30" | "60" | "inactive">("all");
  sortBy = signal<CustomerSort>("name");
  sortDirection = signal<SortDirection>("asc");
  editingId = signal<string | null>(null);
  showInsights = signal(false);
  activeTab = signal<ClientsTab>("clients");
  drawerOpen = signal(false);
  drawerMode = signal<DrawerMode>("create");
  rowMenuOpenId = signal<string | null>(null);
  advancedFormOpen = signal(false);
  filtersSheetOpen = signal(false);
  quickRouteOpen = signal(false);
  quickLocalityOpen = signal(false);
  quickSaving = signal(false);
  quickRouteName = signal("");
  quickRouteLocalityName = signal("");
  quickRouteNotes = signal("");
  quickLocalityName = signal("");
  quickLocalityNotes = signal("");
  selectedActionCategory = signal<ActionCategory>("collection");
  pageIndex = signal(1);
  pageSize = signal(20);
  pageSizeOptions = [10, 20, 50];

  draft: CustomerDraft = this.emptyDraft();

  private customersService = inject(CustomersService);
  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);
  private ordersService = inject(OrdersService);
  private followupsService = inject(CustomerFollowupsService);
  private businessScope = inject(BusinessScopeService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  constructor() {
    this.reload();
  }

  allCustomers = computed(() => this.customersService.customers());
  activeCount = computed(() => this.allCustomers().filter((customer) => customer.active).length);
  inactiveCount = computed(() => this.allCustomers().length - this.activeCount());
  riskCount = computed(() => this.allCustomers().filter((customer) => this.isRiskDisplayCustomer(customer)).length);
  totalNetSales = computed(() => this.allCustomers().reduce((sum, customer) => sum + this.customerMetrics(customer).netSales, 0));
  totalReceivable = computed(() => this.allCustomers().reduce((sum, customer) => sum + this.customerMetrics(customer).balanceDue, 0));
  totalCredits = computed(() => this.allCustomers().reduce((sum, customer) => sum + Number(customer.credit_balance || 0), 0));
  openFollowups = computed(() => this.followupsService.list().filter((row) => row.status === "open" || row.status === "snoozed"));
  todayActions = computed(() => this.buildTodayActions());
  selectedTodayAction = computed(() => this.todayActions().find((action) => action.key === this.selectedActionCategory()) || this.todayActions()[0]);
  private metricsByCustomer = computed(() => new Map(this.allCustomers().map((customer) => [customer.customer_id, this.calculateCustomerMetrics(customer)])));
  hasActiveFilters = computed(() => Boolean(this.searchTerm().trim()) || this.statusFilter() !== "all" || this.routeFilter() !== "all" || this.localityFilter() !== "all" || this.accountFilter() !== "all" || this.followupFilter() !== "all" || this.segmentFilter() !== "all" || this.activityFilter() !== "all" || this.sortBy() !== "name" || this.sortDirection() !== "asc");
  activeFilterChips = computed<FilterChip[]>(() => this.buildActiveFilterChips());
  totalPages = computed(() => Math.max(1, Math.ceil(this.filteredCustomers().length / this.pageSize())));
  paginatedCustomers = computed(() => {
    const page = Math.min(this.pageIndex(), this.totalPages());
    const start = (page - 1) * this.pageSize();
    return this.filteredCustomers().slice(start, start + this.pageSize());
  });
  pageStart = computed(() => this.filteredCustomers().length === 0 ? 0 : ((Math.min(this.pageIndex(), this.totalPages()) - 1) * this.pageSize()) + 1);
  pageEnd = computed(() => Math.min(this.filteredCustomers().length, Math.min(this.pageIndex(), this.totalPages()) * this.pageSize()));

  routes = computed(() => this.routesService.routes());
  localities = computed(() => this.localitiesService.localities());

  filteredCustomers = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();
    const route = this.routeFilter();
    const locality = this.localityFilter();
    const account = this.accountFilter();
    const followup = this.followupFilter();
    const segment = this.segmentFilter();
    const activity = this.activityFilter();
    const sort = this.sortBy();
    const direction = this.sortDirection();

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
        if (followup === "pending" && this.openFollowupsFor(customer).length === 0) return false;
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
          (customer.preferred_sizes || []).join(" "),
          (customer.preferred_categories || []).join(" "),
          (customer.preferred_colors || []).join(" "),
          customer.address || "",
          customer.delivery_reference || "",
          customer.source || "",
          customer.notes || "",
        ]
          .join(" ")
          .toLowerCase();

        return blob.includes(term);
      })
      .sort((a, b) => {
        const result = this.compareCustomers(a, b, sort);
        const directed = direction === "asc" ? result : -result;
        return directed || this.compareNames(a, b);
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
        this.followupsService.loadFromFirestore(),
      ]);
      const editId = this.route.snapshot.queryParamMap.get("edit");
      if (editId) {
        const customer = this.customersService.getById(editId);
        if (customer) this.openEditDrawer(customer);
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar las clientas");
    } finally {
      this.loading.set(false);
    }
  }

  onStatusFilterChange(value: string) {
    const next: CustomerFilter = value === "active" || value === "inactive" || value === "all" ? value : "all";
    this.statusFilter.set(next);
    this.resetPagination();
  }

  setSearchTerm(value: string) {
    this.searchTerm.set(value);
    this.resetPagination();
  }

  setRouteFilter(value: string) {
    this.routeFilter.set(value || "all");
    if (value === "all") this.localityFilter.set("all");
    this.resetPagination();
  }

  setLocalityFilter(value: string) {
    this.localityFilter.set(value || "all");
    this.resetPagination();
  }

  setSegmentFilter(value: string) {
    this.segmentFilter.set(value || "all");
    this.resetPagination();
  }

  setAccountFilter(value: string) {
    this.accountFilter.set(value === "debt" || value === "credit" ? value : "all");
    this.resetPagination();
  }

  setFollowupFilter(value: string) {
    this.followupFilter.set(value === "pending" ? "pending" : "all");
    this.resetPagination();
  }

  setActivityFilter(value: string) {
    const next = value === "30" || value === "60" || value === "inactive" ? value : "all";
    this.activityFilter.set(next);
    this.resetPagination();
  }

  setSortBy(value: string) {
    const next = this.coerceSort(value);
    this.sortBy.set(next);
    this.sortDirection.set(value === "oldest" ? "asc" : this.defaultSortDirection(next));
    this.resetPagination();
  }

  setTableSort(sort: CustomerSort) {
    if (this.sortBy() === sort) {
      this.sortDirection.set(this.sortDirection() === "asc" ? "desc" : "asc");
    } else {
      this.sortBy.set(sort);
      this.sortDirection.set(this.defaultSortDirection(sort));
    }
    this.resetPagination();
  }

  sortControlValue(): string {
    return this.sortBy() === "lastOrder" && this.sortDirection() === "asc" ? "oldest" : this.sortBy();
  }

  isSortedBy(sort: CustomerSort): boolean {
    return this.sortBy() === sort;
  }

  sortIcon(sort: CustomerSort): string {
    if (!this.isSortedBy(sort)) return "unfold_more";
    return this.sortDirection() === "asc" ? "arrow_upward" : "arrow_downward";
  }

  sortAria(sort: CustomerSort): string | null {
    if (!this.isSortedBy(sort)) return null;
    return this.sortDirection() === "asc" ? "ascending" : "descending";
  }

  clearFilters() {
    this.searchTerm.set("");
    this.statusFilter.set("all");
    this.routeFilter.set("all");
    this.localityFilter.set("all");
    this.accountFilter.set("all");
    this.followupFilter.set("all");
    this.segmentFilter.set("all");
    this.activityFilter.set("all");
    this.sortBy.set("name");
    this.sortDirection.set("asc");
    this.filtersSheetOpen.set(false);
    this.resetPagination();
  }

  removeFilter(key: string) {
    if (key === "search") this.searchTerm.set("");
    if (key === "status") this.statusFilter.set("all");
    if (key === "route") this.routeFilter.set("all");
    if (key === "locality") this.localityFilter.set("all");
    if (key === "segment") this.segmentFilter.set("all");
    if (key === "account") this.accountFilter.set("all");
    if (key === "followup") this.followupFilter.set("all");
    if (key === "activity") this.activityFilter.set("all");
    if (key === "sort") {
      this.sortBy.set("name");
      this.sortDirection.set("asc");
    }
    this.resetPagination();
  }

  setActiveTab(tab: ClientsTab) {
    this.activeTab.set(tab);
    this.rowMenuOpenId.set(null);
    this.filtersSheetOpen.set(false);
  }

  openCreateDrawer() {
    this.startCreate();
    this.drawerMode.set("create");
    this.advancedFormOpen.set(false);
    this.drawerOpen.set(true);
  }

  openEditDrawer(customer: Customer, event?: Event) {
    event?.stopPropagation();
    this.startEdit(customer);
    this.drawerMode.set("edit");
    this.advancedFormOpen.set(false);
    this.drawerOpen.set(true);
    this.rowMenuOpenId.set(null);
  }

  closeDrawer() {
    if (this.saving()) return;
    this.drawerOpen.set(false);
    this.advancedFormOpen.set(false);
    this.closeQuickCreates();
    this.startCreate();
  }

  toggleRowMenu(customerId: string, event?: Event) {
    event?.stopPropagation();
    this.rowMenuOpenId.set(this.rowMenuOpenId() === customerId ? null : customerId);
  }

  async toggleActiveFromMenu(customer: Customer, event?: Event) {
    event?.stopPropagation();
    this.rowMenuOpenId.set(null);
    await this.toggleActive(customer, !customer.active);
  }

  openProfile(customerId: string, event?: Event) {
    event?.stopPropagation();
    this.rowMenuOpenId.set(null);
    this.router.navigate(["/main/clientas", customerId]);
  }

  setActionCategory(key: string) {
    const next = (["collection", "post_sale", "birthday", "reactivation", "missing_data"].includes(key) ? key : "collection") as ActionCategory;
    this.selectedActionCategory.set(next);
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

  toggleQuickRoute() {
    this.quickRouteOpen.set(!this.quickRouteOpen());
    if (this.quickRouteOpen()) this.quickLocalityOpen.set(false);
  }

  toggleQuickLocality() {
    this.quickLocalityOpen.set(!this.quickLocalityOpen());
    if (this.quickLocalityOpen()) this.quickRouteOpen.set(false);
  }

  async createQuickRoute() {
    this.error.set(null);
    this.success.set(null);
    const routeName = this.quickRouteName().trim();
    const localityName = this.quickRouteLocalityName().trim();
    if (!routeName || !localityName) {
      this.error.set("Escribe la ruta y su primera localidad");
      return;
    }

    this.quickSaving.set(true);
    try {
      const routeId = this.uniqueRouteId(routeName);
      const localityId = this.uniqueLocalityId(localityName);
      await this.localitiesService.save({
        locality_id: localityId,
        name: localityName,
        notes: "",
        active: true,
      });
      const payload: RoutePlan = {
        route_id: routeId,
        name: routeName,
        notes: this.quickRouteNotes().trim(),
        active: true,
        locality_ids: [localityId],
        created_at: new Date(),
      };
      await this.routesService.save(payload);
      this.draft.route_id = routeId;
      this.draft.locality_id = localityId;
      this.quickRouteName.set("");
      this.quickRouteLocalityName.set("");
      this.quickRouteNotes.set("");
      this.quickRouteOpen.set(false);
      this.success.set("Ruta y localidad creadas");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo crear la ruta");
    } finally {
      this.quickSaving.set(false);
    }
  }

  async createQuickLocality() {
    this.error.set(null);
    this.success.set(null);
    const routeId = this.draft.route_id.trim();
    const localityName = this.quickLocalityName().trim();
    const route = routeId ? this.routesService.getById(routeId) : null;
    if (!route) {
      this.error.set("Selecciona una ruta antes de crear la localidad");
      return;
    }
    if (!localityName) {
      this.error.set("Escribe el nombre de la localidad");
      return;
    }

    this.quickSaving.set(true);
    try {
      const localityId = this.uniqueLocalityId(localityName);
      await this.localitiesService.save({
        locality_id: localityId,
        name: localityName,
        notes: this.quickLocalityNotes().trim(),
        active: true,
      });
      await this.routesService.save({
        ...route,
        locality_ids: [...new Set([...(route.locality_ids || []), localityId])],
      });
      this.draft.locality_id = localityId;
      this.quickLocalityName.set("");
      this.quickLocalityNotes.set("");
      this.quickLocalityOpen.set(false);
      this.success.set("Localidad creada");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo crear la localidad");
    } finally {
      this.quickSaving.set(false);
    }
  }

  startCreate() {
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.showInsights.set(false);
    this.closeQuickCreates();
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
      birthday: customer.birthday || "",
      address: customer.address || "",
      delivery_reference: customer.delivery_reference || "",
      commercial_stage: customer.commercial_stage || "",
      preferred_sizes: (customer.preferred_sizes || []).join(", "),
      preferred_categories: (customer.preferred_categories || []).join(", "),
      preferred_colors: (customer.preferred_colors || []).join(", "),
      source: customer.source || "",
      wa_opt_in_notes: customer.wa_opt_in_notes || "",
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
    this.closeDrawer();
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

    if (!this.editingId() && (!this.draft.route_id || !this.draft.locality_id)) {
      this.error.set("Ruta y localidad son obligatorias para crear una clienta");
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
        birthday: this.draft.birthday || null,
        address: this.draft.address.trim(),
        delivery_reference: this.draft.delivery_reference.trim(),
        commercial_stage: this.draft.commercial_stage || null,
        preferred_sizes: this.parseTags(this.draft.preferred_sizes),
        preferred_categories: this.parseTags(this.draft.preferred_categories),
        preferred_colors: this.parseTags(this.draft.preferred_colors),
        source: this.draft.source.trim(),
        wa_opt_in_notes: this.draft.wa_opt_in_notes.trim(),
        notes: this.draft.notes.trim(),
        tags: existing?.tags || [],
        opt_in: existing?.opt_in || null,
        insights: null,
        credit_balance: existing?.credit_balance || 0,
        created_at: createdAt,
      };

      await this.customersService.save(payload);
      this.success.set(this.editingId() ? "Clienta actualizada" : "Clienta creada");
      this.drawerOpen.set(false);
      this.advancedFormOpen.set(false);
      this.startCreate();
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

  initials(customer: Customer): string {
    const first = (customer.first_name || "").trim().charAt(0);
    const last = (customer.last_name || "").trim().charAt(0);
    return `${first}${last}`.trim().toUpperCase() || "CL";
  }

  avatarClass(customer: Customer): string {
    const value = customer.customer_id || `${customer.first_name}${customer.last_name}`;
    const index = Math.abs([...value].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 5;
    return `avatar-tone-${index}`;
  }

  statusPills(customer: Customer): StatusPill[] {
    const metrics = this.customerMetrics(customer);
    const segment = this.customerSegment(customer);
    const isRisk = this.isRiskDisplayCustomer(customer);
    const pills: StatusPill[] = [];
    if (!customer.active) {
      pills.push({ label: "Inactiva", tone: "inactive" });
    } else if (metrics.orders <= 0) {
      pills.push({ label: "Sin compras", tone: "inactive" });
    } else {
      pills.push({ label: "Activa", tone: "active" });
    }
    if (isRisk) pills.push({ label: "En riesgo", tone: "risk" });
    if (!isRisk && segment !== "collection" && segment !== "dormant") {
      const tone: StatusTone = segment === "returns" ? "warning" : segment === "risk" ? "risk" : "info";
      pills.push({ label: this.segmentLabel(segment), tone });
    }
    if (metrics.balanceDue > 0) pills.push({ label: "Por cobrar", tone: "debt" });
    if (Number(customer.credit_balance || 0) > 0) pills.push({ label: "Saldo a favor", tone: "credit" });
    return pills;
  }

  compactStatusPills(customer: Customer): StatusPill[] {
    return this.statusPills(customer).slice(0, 3);
  }

  filterSheetTitle(): string {
    return this.filtersSheetOpen() ? "Ocultar filtros" : "Más filtros";
  }

  prevPage() {
    this.pageIndex.set(Math.max(1, this.pageIndex() - 1));
  }

  nextPage() {
    this.pageIndex.set(Math.min(this.totalPages(), this.pageIndex() + 1));
  }

  setPageSize(value: string | number) {
    const parsed = Number(value);
    this.pageSize.set(this.pageSizeOptions.includes(parsed) ? parsed : 20);
    this.pageIndex.set(1);
  }

  openFollowupsFor(customer: Customer): CustomerFollowup[] {
    return this.openFollowups().filter((row) => row.customer_id === customer.customer_id);
  }

  qualityIssues(customer: Customer): string[] {
    const issues: string[] = [];
    if (!customer.route_id) issues.push("Ruta");
    if (!customer.locality_id) issues.push("Localidad");
    if (!customer.birthday) issues.push("Cumpleaños");
    if (!customer.address?.trim()) issues.push("Dirección");
    return issues;
  }

  nextActionLabel(customer: Customer): string {
    const metrics = this.customerMetrics(customer);
    const paymentFollowup = this.openFollowupsFor(customer).find((row) => row.type === "payment_reminder");
    if (metrics.balanceDue > 0) return paymentFollowup?.due_at ? `Cobrar saldo pendiente (${paymentFollowup.due_at})` : "Revisar cobro pendiente";
    const nextFollowup = this.openFollowupsFor(customer)[0];
    if (nextFollowup) return nextFollowup.title;
    const birthdayDays = this.daysUntilBirthday(customer.birthday || null);
    if (birthdayDays !== null && birthdayDays <= 7) return birthdayDays === 0 ? "Felicitar cumpleaños hoy" : `Preparar cumpleaños en ${birthdayDays} días`;
    if ((metrics.daysSinceLastOrder || 0) > 60) return "Reactivar con mensaje amable";
    if (this.qualityIssues(customer).length) return "Completar datos 360";
    return "Dar seguimiento comercial";
  }

  private buildTodayActions(): Array<{ key: string; label: string; icon: string; count: number; items: Array<{ trackId: string; customer: Customer; detail: string; amount?: number }> }> {
    const customers = this.allCustomers();
    const collectionItems = customers
      .filter((customer) => this.customerMetrics(customer).balanceDue > 0)
      .sort((a, b) => this.customerMetrics(b).balanceDue - this.customerMetrics(a).balanceDue)
      .map((customer) => ({ trackId: `collection-${customer.customer_id}`, customer, detail: "Cobro pendiente", amount: this.customerMetrics(customer).balanceDue }));

    const postSaleItems = this.openFollowups()
      .filter((row) => row.type === "post_sale")
      .map((row) => ({ row, customer: this.customersService.getById(row.customer_id) }))
      .filter((entry): entry is { row: CustomerFollowup; customer: Customer } => Boolean(entry.customer))
      .map(({ row, customer }) => ({ trackId: `post-sale-${row.followup_id}`, customer, detail: "Seguimiento postventa" }));

    const birthdayItems = customers
      .map((customer) => ({ customer, days: this.daysUntilBirthday(customer.birthday || null) }))
      .filter((entry): entry is { customer: Customer; days: number } => entry.days !== null && entry.days <= 7)
      .sort((a, b) => a.days - b.days)
      .map(({ customer, days }) => ({ trackId: `birthday-${customer.customer_id}`, customer, detail: days === 0 ? "Cumpleaños hoy" : `Cumple en ${days} días` }));

    const reactivationItems = customers
      .filter((customer) => (this.customerMetrics(customer).daysSinceLastOrder || 0) > 60 && this.customerMetrics(customer).balanceDue <= 0)
      .sort((a, b) => (this.customerMetrics(b).daysSinceLastOrder || 0) - (this.customerMetrics(a).daysSinceLastOrder || 0))
      .map((customer) => ({ trackId: `reactivation-${customer.customer_id}`, customer, detail: `${this.customerMetrics(customer).daysSinceLastOrder} días sin compra` }));

    const missingDataItems = customers
      .filter((customer) => this.qualityIssues(customer).length > 0)
      .map((customer) => ({ trackId: `missing-data-${customer.customer_id}`, customer, detail: this.qualityIssues(customer).slice(0, 2).join(", ") }));

    return [
      { key: "collection", label: "Cobrar", icon: "payments", count: customers.filter((customer) => this.customerMetrics(customer).balanceDue > 0).length, items: collectionItems },
      { key: "post_sale", label: "Postventa", icon: "support_agent", count: this.openFollowups().filter((row) => row.type === "post_sale").length, items: postSaleItems },
      { key: "birthday", label: "Cumpleaños", icon: "cake", count: customers.filter((customer) => {
        const days = this.daysUntilBirthday(customer.birthday || null);
        return days !== null && days <= 7;
      }).length, items: birthdayItems },
      { key: "reactivation", label: "Reactivar", icon: "campaign", count: customers.filter((customer) => (this.customerMetrics(customer).daysSinceLastOrder || 0) > 60 && this.customerMetrics(customer).balanceDue <= 0).length, items: reactivationItems },
      { key: "missing_data", label: "Datos faltantes", icon: "fact_check", count: customers.filter((customer) => this.qualityIssues(customer).length > 0).length, items: missingDataItems },
    ];
  }

  private buildActiveFilterChips(): FilterChip[] {
    const chips: FilterChip[] = [];
    if (this.searchTerm().trim()) chips.push({ key: "search", label: `Buscar: ${this.searchTerm().trim()}` });
    if (this.routeFilter() !== "all") chips.push({ key: "route", label: `Ruta: ${this.routeName(this.routeFilter())}` });
    if (this.localityFilter() !== "all") chips.push({ key: "locality", label: `Localidad: ${this.localityName(this.localityFilter())}` });
    if (this.statusFilter() !== "all") chips.push({ key: "status", label: this.statusFilter() === "active" ? "Activas" : "Inactivas" });
    if (this.segmentFilter() !== "all") chips.push({ key: "segment", label: this.segmentLabel(this.segmentFilter()) });
    if (this.accountFilter() !== "all") chips.push({ key: "account", label: this.accountFilter() === "debt" ? "Con deuda" : "Con saldo a favor" });
    if (this.followupFilter() !== "all") chips.push({ key: "followup", label: "Seguimiento pendiente" });
    if (this.activityFilter() !== "all") chips.push({ key: "activity", label: this.activityLabel(this.activityFilter()) });
    if (this.sortBy() !== "name" || this.sortDirection() !== "asc") chips.push({ key: "sort", label: `Orden: ${this.sortDescription()}` });
    return chips;
  }

  private compareCustomers(a: Customer, b: Customer, sort: CustomerSort): number {
    const metricsA = this.customerMetrics(a);
    const metricsB = this.customerMetrics(b);
    if (sort === "route") return this.compareText(`${this.routeName(a.route_id)} ${this.localityName(a.locality_id)}`, `${this.routeName(b.route_id)} ${this.localityName(b.locality_id)}`);
    if (sort === "lastOrder") return this.lastOrderTime(metricsA.lastOrder) - this.lastOrderTime(metricsB.lastOrder);
    if (sort === "sales") return metricsA.netSales - metricsB.netSales;
    if (sort === "orders") return metricsA.orders - metricsB.orders;
    if (sort === "balanceDue") return metricsA.balanceDue - metricsB.balanceDue;
    if (sort === "status") return this.compareText(this.statusSortValue(a), this.statusSortValue(b));
    return this.compareNames(a, b);
  }

  private compareNames(a: Customer, b: Customer): number {
    return this.compareText(`${a.first_name} ${a.last_name}`.trim(), `${b.first_name} ${b.last_name}`.trim());
  }

  private compareText(a: string, b: string): number {
    return a.localeCompare(b, "es", { sensitivity: "base" });
  }

  private lastOrderTime(value: string | null): number {
    return value ? new Date(value).getTime() : 0;
  }

  private statusSortValue(customer: Customer): string {
    const metrics = this.customerMetrics(customer);
    if (!customer.active) return "3-inactiva";
    if (metrics.orders <= 0) return "2-sin-compras";
    if (metrics.balanceDue > 0) return "1-por-cobrar";
    return "0-activa";
  }

  private resetPagination() {
    this.pageIndex.set(1);
  }

  private isRiskCustomer(customer: Customer): boolean {
    const metrics = this.customerMetrics(customer);
    return customer.commercial_stage === "en_riesgo" || (metrics.orders >= 3 && (metrics.daysSinceLastOrder || 0) > 45);
  }

  private isRiskDisplayCustomer(customer: Customer): boolean {
    return this.isRiskCustomer(customer) || this.customerSegment(customer) === "risk";
  }

  private activityLabel(value: string): string {
    return ({ "30": "Compra en 30 días", "60": "Compra en 60 días", inactive: "Sin compra en 60 días" } as Record<string, string>)[value] || "Cualquier actividad";
  }

  private coerceSort(value: string): CustomerSort {
    if (value === "sales" || value === "orders" || value === "route" || value === "lastOrder" || value === "balanceDue" || value === "status") return value;
    if (value === "frequency") return "orders";
    if (value === "oldest") return "lastOrder";
    return "name";
  }

  private defaultSortDirection(sort: CustomerSort): SortDirection {
    return sort === "name" || sort === "route" || sort === "status" ? "asc" : "desc";
  }

  private sortDescription(): string {
    const base = ({ name: "Nombre", route: "Ruta/localidad", lastOrder: "Ultima compra", sales: "Ventas netas", orders: "Pedidos", balanceDue: "Por cobrar", status: "Estado" } as Record<CustomerSort, string>)[this.sortBy()];
    return `${base} ${this.sortDirection() === "asc" ? "ascendente" : "descendente"}`;
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
      birthday: "",
      address: "",
      delivery_reference: "",
      commercial_stage: "",
      preferred_sizes: "",
      preferred_categories: "",
      preferred_colors: "",
      source: "",
      wa_opt_in_notes: "",
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

  private closeQuickCreates() {
    this.quickRouteOpen.set(false);
    this.quickLocalityOpen.set(false);
    this.quickRouteName.set("");
    this.quickRouteLocalityName.set("");
    this.quickRouteNotes.set("");
    this.quickLocalityName.set("");
    this.quickLocalityNotes.set("");
  }

  private uniqueRouteId(name: string): string {
    const base = this.slugify(name) || `ruta-${Date.now().toString(36)}`;
    if (!this.routesService.getById(base)) return base;
    return `${base}-${Date.now().toString(36).slice(-4)}`;
  }

  private uniqueLocalityId(name: string): string {
    const base = this.slugify(name) || `localidad-${Date.now().toString(36)}`;
    if (!this.localitiesService.getById(base)) return base;
    return `${base}-${Date.now().toString(36).slice(-4)}`;
  }

  private buildCustomerId(firstName: string, lastName: string, phone: string): string {
    const base = this.slugify(`${firstName} ${lastName}`) || "clienta";
    const digits = phone.replace(/\D/g, "");
    const suffix = digits.slice(-4) || Date.now().toString(36).slice(-4);
    return `${this.businessScope.writeBusinessId()}-${base}-${suffix}`;
  }

  customerMetrics(customer: Customer): CustomerMetrics {
    return this.metricsByCustomer().get(customer.customer_id) || this.calculateCustomerMetrics(customer);
  }

  private calculateCustomerMetrics(customer: Customer): CustomerMetrics {
    const rows = this.ordersService.list().filter((order) => order.customer_id === customer.customer_id && order.business_id === customer.business_id);
    const billable = rows.filter((order) => !["cancelado", "devuelto"].includes(order.status));
    const delivered = rows.filter((order) => Boolean(order.delivered_at) || ["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed"].includes(order.status));
    const completed = delivered.filter((order) => calculateOrderFinancials(order).netUnits > 0);
    let netSales = 0;
    let balanceDue = 0;
    let returns = 0;
    for (const order of billable) {
      const financials = calculateOrderFinancials(order);
      balanceDue += financials.balanceDue;
    }
    for (const order of delivered) {
      const financials = calculateOrderFinancials(order);
      returns += financials.returnsAmount;
    }
    for (const order of completed) {
      const financials = calculateOrderFinancials(order);
      netSales += financials.netAmount;
    }
    const lastOrder = completed
      .map((order) => order.delivered_at || order.updated_at || order.created_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const daysSinceLastOrder = lastOrder ? Math.max(0, Math.floor((Date.now() - new Date(lastOrder).getTime()) / 86_400_000)) : null;
    return {
      orders: completed.length,
      netSales,
      balanceDue,
      average: completed.length > 0 ? netSales / completed.length : 0,
      returns,
      returnRate: netSales > 0 ? returns / netSales : 0,
      lastOrder,
      daysSinceLastOrder,
    };
  }

  customerSegment(customer: Customer): CustomerSegment {
    const directMetrics = this.customerMetrics(customer);
    if (directMetrics.balanceDue > 0) return "collection";
    if (directMetrics.returns > 0 && directMetrics.returnRate >= 0.15) return "returns";
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
    return ({ champions: "Estrella", loyal: "Fiel", risk: "En riesgo", new: "Nueva", dormant: "Inactiva", collection: "Pendiente de cobro", returns: "Alta devolución" } as Record<string, string>)[segment] || segment;
  }

  private daysUntilBirthday(value: string | null): number | null {
    if (!value) return null;
    const parts = value.slice(0, 10).split("-").map(Number);
    if (parts.length < 3 || !parts[1] || !parts[2]) return null;
    const today = new Date();
    const birthday = new Date(today.getFullYear(), parts[1] - 1, parts[2]);
    if (birthday.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
      birthday.setFullYear(today.getFullYear() + 1);
    }
    return Math.ceil((birthday.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
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
