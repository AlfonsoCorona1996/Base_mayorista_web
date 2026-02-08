import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { LocalitiesService, Locality } from "../../core/localities.service";

type LocalityFilter = "all" | "active" | "inactive";

interface LocalityDraft {
  locality_id: string;
  name: string;
  notes: string;
  active: boolean;
}

@Component({
  standalone: true,
  selector: "app-localidades",
  imports: [FormsModule],
  templateUrl: "./localidades.html",
  styleUrl: "./localidades.css",
})
export default class LocalidadesPage {
  loading = signal(false);
  saving = signal(false);
  togglingId = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  statusFilter = signal<LocalityFilter>("all");
  editingId = signal<string | null>(null);

  draft: LocalityDraft = this.emptyDraft();

  private localitiesService = inject(LocalitiesService);

  constructor() {
    this.reload();
  }

  allLocalities = computed(() => this.localitiesService.localities());
  activeCount = computed(() => this.allLocalities().filter((locality) => locality.active).length);
  inactiveCount = computed(() => this.allLocalities().length - this.activeCount());

  filteredLocalities = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();

    return [...this.allLocalities()]
      .filter((locality) => {
        const statusOk =
          filter === "all" ||
          (filter === "active" && locality.active) ||
          (filter === "inactive" && !locality.active);
        if (!statusOk) return false;
        if (!term) return true;

        const blob = [locality.name, locality.notes || "", locality.locality_id]
          .join(" ")
          .toLowerCase();
        return blob.includes(term);
      })
      .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await this.localitiesService.loadFromFirestore();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar las localidades");
    } finally {
      this.loading.set(false);
    }
  }

  onStatusFilterChange(value: string) {
    const next: LocalityFilter = value === "active" || value === "inactive" || value === "all" ? value : "all";
    this.statusFilter.set(next);
  }

  clearFilters() {
    this.searchTerm.set("");
    this.statusFilter.set("all");
  }

  startCreate() {
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.error.set(null);
    this.success.set(null);
  }

  startEdit(locality: Locality) {
    this.editingId.set(locality.locality_id);
    this.draft = {
      locality_id: locality.locality_id,
      name: locality.name,
      notes: locality.notes || "",
      active: locality.active,
    };
    this.error.set(null);
    this.success.set(null);
  }

  cancelEdit() {
    this.startCreate();
  }

  async saveLocality() {
    this.error.set(null);
    this.success.set(null);

    const name = this.draft.name.trim();
    if (!name) {
      this.error.set("El nombre de la localidad es obligatorio");
      return;
    }

    this.saving.set(true);

    try {
      const existing = this.editingId() ? this.localitiesService.getById(this.editingId()!) : null;
      const createdAt = existing?.created_at || new Date();
      const localityId = this.editingId() || this.slugify(name);

      const payload: Locality = {
        locality_id: localityId,
        name,
        notes: this.draft.notes.trim(),
        active: this.draft.active,
        created_at: createdAt,
      };

      await this.localitiesService.save(payload);
      this.success.set(this.editingId() ? "Localidad actualizada" : "Localidad creada");

      if (!this.editingId()) {
        this.startCreate();
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la localidad");
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(locality: Locality, nextActive: boolean) {
    if (locality.active === nextActive) return;

    this.togglingId.set(locality.locality_id);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.localitiesService.setActive(locality.locality_id, nextActive);
      this.success.set(nextActive ? "Localidad activada" : "Localidad desactivada");

      if (this.editingId() === locality.locality_id) {
        this.draft = { ...this.draft, active: nextActive };
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
    } finally {
      this.togglingId.set(null);
    }
  }

  isBusy(localityId: string): boolean {
    return this.togglingId() === localityId;
  }

  private emptyDraft(): LocalityDraft {
    return {
      locality_id: "",
      name: "",
      notes: "",
      active: true,
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
