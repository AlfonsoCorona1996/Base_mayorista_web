import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { LocalitiesService } from "../../core/localities.service";
import { RoutePlan, RoutesService } from "../../core/routes.service";

type RouteFilter = "all" | "active" | "inactive";

interface RouteDraft {
  route_id: string;
  name: string;
  notes: string;
  active: boolean;
  locality_ids: string[];
}

@Component({
  standalone: true,
  selector: "app-rutas",
  imports: [FormsModule],
  templateUrl: "./rutas.html",
  styleUrl: "./rutas.css",
})
export default class RutasPage {
  loading = signal(false);
  saving = signal(false);
  togglingId = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  statusFilter = signal<RouteFilter>("all");
  editingId = signal<string | null>(null);
  selectedLocalityId = signal("");

  draft: RouteDraft = this.emptyDraft();

  private routesService = inject(RoutesService);
  private localitiesService = inject(LocalitiesService);

  constructor() {
    this.reload();
  }

  allRoutes = computed(() => this.routesService.routes());
  activeCount = computed(() => this.allRoutes().filter((route) => route.active).length);
  inactiveCount = computed(() => this.allRoutes().length - this.activeCount());

  localities = computed(() => this.localitiesService.localities());
  activeLocalities = computed(() => this.localities().filter((locality) => locality.active));
  availableLocalities = computed(() => {
    const used = new Set<string>();
    for (const route of this.allRoutes()) {
      for (const localityId of route.locality_ids) {
        used.add(localityId);
      }
    }

    return this.activeLocalities().filter((locality) => !used.has(locality.locality_id));
  });

  filteredRoutes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();

    return [...this.allRoutes()]
      .filter((route) => {
        const statusOk =
          filter === "all" ||
          (filter === "active" && route.active) ||
          (filter === "inactive" && !route.active);
        if (!statusOk) return false;
        if (!term) return true;

        const localityNames = route.locality_ids.map((id) => this.localityName(id)).join(" ");
        const blob = [route.name, route.route_id, route.notes || "", localityNames].join(" ").toLowerCase();
        return blob.includes(term);
      })
      .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await Promise.all([this.routesService.loadFromFirestore(), this.localitiesService.loadFromFirestore()]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar las rutas");
    } finally {
      this.loading.set(false);
    }
  }

  onStatusFilterChange(value: string) {
    const next: RouteFilter = value === "active" || value === "inactive" || value === "all" ? value : "all";
    this.statusFilter.set(next);
  }

  clearFilters() {
    this.searchTerm.set("");
    this.statusFilter.set("all");
  }

  startCreate() {
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.selectedLocalityId.set("");
    this.error.set(null);
    this.success.set(null);
  }

  startEdit(route: RoutePlan) {
    this.editingId.set(route.route_id);
    this.draft = {
      route_id: route.route_id,
      name: route.name,
      notes: route.notes || "",
      active: route.active,
      locality_ids: [...route.locality_ids],
    };
    this.selectedLocalityId.set("");
    this.error.set(null);
    this.success.set(null);
  }

  cancelEdit() {
    this.startCreate();
  }

  addLocality() {
    const nextId = this.selectedLocalityId().trim();
    if (!nextId) return;
    if (this.draft.locality_ids.includes(nextId)) return;

    this.draft.locality_ids = [...this.draft.locality_ids, nextId];
    this.selectedLocalityId.set("");
  }

  removeLocality(index: number) {
    this.draft.locality_ids = this.draft.locality_ids.filter((_, idx) => idx !== index);
  }

  moveLocality(index: number, direction: number) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= this.draft.locality_ids.length) return;

    const updated = [...this.draft.locality_ids];
    const [item] = updated.splice(index, 1);
    updated.splice(nextIndex, 0, item);
    this.draft.locality_ids = updated;
  }

  async saveRoute() {
    this.error.set(null);
    this.success.set(null);

    const name = this.draft.name.trim();
    if (!name) {
      this.error.set("El nombre de la ruta es obligatorio");
      return;
    }

    this.saving.set(true);

    try {
      const existing = this.editingId() ? this.routesService.getById(this.editingId()!) : null;
      const createdAt = existing?.created_at || new Date();
      const routeId = this.editingId() || this.slugify(name);

      const payload: RoutePlan = {
        route_id: routeId,
        name,
        notes: this.draft.notes.trim(),
        active: this.draft.active,
        locality_ids: this.draft.locality_ids,
        created_at: createdAt,
      };

      await this.routesService.save(payload);
      this.success.set(this.editingId() ? "Ruta actualizada" : "Ruta creada");

      if (!this.editingId()) {
        this.startCreate();
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la ruta");
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(route: RoutePlan, nextActive: boolean) {
    if (route.active === nextActive) return;

    this.togglingId.set(route.route_id);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.routesService.setActive(route.route_id, nextActive);
      this.success.set(nextActive ? "Ruta activada" : "Ruta desactivada");

      if (this.editingId() === route.route_id) {
        this.draft = { ...this.draft, active: nextActive };
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
    } finally {
      this.togglingId.set(null);
    }
  }

  isBusy(routeId: string): boolean {
    return this.togglingId() === routeId;
  }

  localityName(localityId: string): string {
    return this.localitiesService.getById(localityId)?.name || localityId;
  }

  private emptyDraft(): RouteDraft {
    return {
      route_id: "",
      name: "",
      notes: "",
      active: true,
      locality_ids: [],
    };
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
}
