import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Customer, CustomersService, OptInStatus } from "../../core/customers.service";
import { LocalitiesService } from "../../core/localities.service";
import { RoutesService } from "../../core/routes.service";

type CustomerFilter = "all" | "active" | "inactive";

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
  standalone: true,
  selector: "app-clientas",
  imports: [FormsModule],
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
  editingId = signal<string | null>(null);
  showInsights = signal(false);

  draft: CustomerDraft = this.emptyDraft();

  private customersService = inject(CustomersService);
  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);

  constructor() {
    this.reload();
  }

  allCustomers = computed(() => this.customersService.customers());
  activeCount = computed(() => this.allCustomers().filter((customer) => customer.active).length);
  inactiveCount = computed(() => this.allCustomers().length - this.activeCount());

  routes = computed(() => this.routesService.routes());
  localities = computed(() => this.localitiesService.localities());

  filteredCustomers = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();

    return [...this.allCustomers()]
      .filter((customer) => {
        const statusOk =
          filter === "all" ||
          (filter === "active" && customer.active) ||
          (filter === "inactive" && !customer.active);
        if (!statusOk) return false;
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
        first_name: firstName,
        last_name: lastName,
        whatsapp,
        route_id: this.draft.route_id || null,
        locality_id: this.draft.locality_id || null,
        active: this.draft.active,
        notes: this.draft.notes.trim(),
        tags: [],
        opt_in: null,
        insights: this.showInsights()
          ? {
              last_order_at: this.draft.insights_last_order || null,
              total_orders: this.toNumberOrNull(this.draft.insights_total_orders),
              total_spent: this.toNumberOrNull(this.draft.insights_total_spent),
              avg_order_value: this.toNumberOrNull(this.draft.insights_avg_order),
              avg_units_per_order: this.toNumberOrNull(this.draft.insights_avg_units),
              frequency_days: this.toNumberOrNull(this.draft.insights_frequency_days),
              preferred_categories: this.parseTags(this.draft.insights_categories),
              preferred_products: this.parseTags(this.draft.insights_products),
            }
          : null,
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

  private buildCustomerId(firstName: string, lastName: string, phone: string): string {
    const base = this.slugify(`${firstName} ${lastName}`) || "clienta";
    const digits = phone.replace(/\D/g, "");
    const suffix = digits.slice(-4) || Date.now().toString(36).slice(-4);
    return `${base}-${suffix}`;
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
