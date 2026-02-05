import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Supplier, SuppliersService } from "../../core/suppliers.service";

type SupplierFilter = "all" | "active" | "inactive";

interface SupplierDraft {
  supplier_id: string;
  display_name: string;
  contact_name: string;
  contact_phone: string;
  notes: string;
  active: boolean;
}

@Component({
  standalone: true,
  selector: "app-proveedores",
  imports: [FormsModule],
  templateUrl: "./proveedores.html",
  styleUrl: "./proveedores.css",
})
export default class ProveedoresPage {
  loading = signal(false);
  saving = signal(false);
  togglingId = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  statusFilter = signal<SupplierFilter>("all");
  editingId = signal<string | null>(null);

  draft: SupplierDraft = this.emptyDraft();

  private suppliersService = inject(SuppliersService);

  constructor() {
    this.reload();
  }

  allSuppliers = computed(() => this.suppliersService.suppliers());

  activeCount = computed(() => this.allSuppliers().filter((supplier) => supplier.active).length);

  inactiveCount = computed(() => this.allSuppliers().length - this.activeCount());

  filteredSuppliers = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();

    return [...this.allSuppliers()]
      .filter((supplier) => {
        const statusOk =
          filter === "all" ||
          (filter === "active" && supplier.active) ||
          (filter === "inactive" && !supplier.active);

        if (!statusOk) return false;
        if (!term) return true;

        const blob = [
          supplier.display_name,
          supplier.supplier_id,
          supplier.contact_name || "",
          supplier.contact_phone || "",
          supplier.notes || "",
        ]
          .join(" ")
          .toLowerCase();

        return blob.includes(term);
      })
      .sort((a, b) => a.display_name.localeCompare(b.display_name, "es", { sensitivity: "base" }));
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await this.suppliersService.loadFromFirestore();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar los proveedores");
    } finally {
      this.loading.set(false);
    }
  }

  onStatusFilterChange(value: string) {
    const next: SupplierFilter =
      value === "active" || value === "inactive" || value === "all" ? value : "all";
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

  startEdit(supplier: Supplier) {
    this.editingId.set(supplier.supplier_id);
    this.draft = {
      supplier_id: supplier.supplier_id,
      display_name: supplier.display_name,
      contact_name: supplier.contact_name || "",
      contact_phone: supplier.contact_phone || "",
      notes: supplier.notes || "",
      active: supplier.active,
    };
    this.error.set(null);
    this.success.set(null);
  }

  cancelEdit() {
    this.startCreate();
  }

  async saveSupplier() {
    this.error.set(null);
    this.success.set(null);

    const displayName = this.draft.display_name.trim();
    if (!displayName) {
      this.error.set("El nombre del proveedor es obligatorio");
      return;
    }

    const resolvedId = (this.draft.supplier_id || this.slugify(displayName)).trim();
    if (!resolvedId) {
      this.error.set("No se pudo generar el ID del proveedor");
      return;
    }

    this.saving.set(true);

    try {
      const existing = this.suppliersService.getById(resolvedId);
      const createdAt = existing?.created_at || new Date();

      const payload: Supplier = {
        supplier_id: resolvedId,
        display_name: displayName,
        contact_name: this.draft.contact_name.trim(),
        contact_phone: this.draft.contact_phone.trim(),
        notes: this.draft.notes.trim(),
        active: this.draft.active,
        created_at: createdAt,
      };

      await this.suppliersService.save(payload);

      this.success.set(this.editingId() ? "Proveedor actualizado" : "Proveedor creado");

      if (!this.editingId()) {
        this.draft = this.emptyDraft();
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar el proveedor");
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(supplier: Supplier, nextActive: boolean) {
    if (supplier.active === nextActive) return;

    this.togglingId.set(supplier.supplier_id);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.suppliersService.setActive(supplier.supplier_id, nextActive);
      this.success.set(nextActive ? "Proveedor activado" : "Proveedor desactivado");

      if (this.editingId() === supplier.supplier_id) {
        this.draft = {
          ...this.draft,
          active: nextActive,
        };
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
    } finally {
      this.togglingId.set(null);
    }
  }

  isBusy(supplierId: string): boolean {
    return this.togglingId() === supplierId;
  }

  private emptyDraft(): SupplierDraft {
    return {
      supplier_id: "",
      display_name: "",
      contact_name: "",
      contact_phone: "",
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