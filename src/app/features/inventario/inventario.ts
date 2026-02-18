import { Component, HostListener, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { CategoriesService, Category } from "../../core/categories.service";
import { STORAGE } from "../../core/firebase.providers";
import { InventoryItem, InventoryService } from "../../core/inventory.service";
import { SuppliersService } from "../../core/suppliers.service";

type StockFilter = "all" | "low" | "sold_out" | "without_price";

interface InventoryDraft {
  inventory_id: string;
  title: string;
  category_hint: string;
  supplier_id: string;
  variant_name: string;
  color_name: string;
  size_label: string;
  quantity_on_hand: number;
  unit_price: number | null;
  notes: string;
  image_urls: string[];
  source_reason: "devolucion" | "ajuste_manual";
}

@Component({
  standalone: true,
  selector: "app-inventario",
  imports: [FormsModule],
  templateUrl: "./inventario.html",
  styleUrl: "./inventario.css",
})
export default class InventarioPage {
  private static readonly MAX_IMAGES = 8;

  loading = signal(false);
  saving = signal(false);
  uploadingImages = signal(false);
  busyById = signal<Record<string, boolean>>({});
  editingId = signal<string | null>(null);
  deleteDialogItem = signal<InventoryItem | null>(null);

  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  stockFilter = signal<StockFilter>("all");

  categoryQuery = signal("");
  categoryDropdownOpen = signal(false);
  categoryConfirmed = signal(false);
  selectedCategoryId = signal<string | null>(null);
  categoryTreeOpen = signal(false);
  categoryTreeParentId = signal<string | null>(null);

  draft: InventoryDraft = this.emptyDraft();

  private inventory = inject(InventoryService);
  private categories = inject(CategoriesService);
  private suppliers = inject(SuppliersService);

  constructor() {
    this.reload();
  }

  rows = computed(() => this.inventory.items());

  totalUnits = computed(() => this.rows().reduce((sum, row) => sum + row.quantity_on_hand, 0));

  lowStockCount = computed(() => this.rows().filter((row) => row.quantity_on_hand > 0 && row.quantity_on_hand <= 3).length);

  soldOutCount = computed(() => this.rows().filter((row) => row.quantity_on_hand === 0).length);
  withoutPriceCount = computed(() => this.rows().filter((row) => !row.unit_price || row.unit_price <= 0).length);
  totalInvestment = computed(() =>
    this.rows().reduce((sum, row) => sum + (row.unit_price || 0) * row.quantity_on_hand, 0),
  );

  categoryOptions = computed(() => this.categories.getAll());

  filteredCategoryOptions = computed(() => {
    const query = this.categoryQuery().trim().toLowerCase();
    if (query.length < 2) return [];

    return this.categoryOptions()
      .filter((category) => {
        const path = (category.fullPath || "").toLowerCase();
        return path.includes(query);
      })
      .slice(0, 12);
  });

  categoryChildrenMap = computed(() => {
    const map = new Map<string, Category[]>();

    for (const category of this.categoryOptions()) {
      const key = category.parentId || "__root__";
      const rows = map.get(key) || [];
      rows.push(category);
      map.set(key, rows);
    }

    for (const [key, rows] of map.entries()) {
      map.set(key, this.sortCategories(rows));
    }

    return map;
  });

  categoryTreeRows = computed(() => {
    const key = this.categoryTreeParentId() || "__root__";
    return this.categoryChildrenMap().get(key) || [];
  });

  categoryTreeBreadcrumb = computed(() => {
    const byId = new Map(this.categoryOptions().map((category) => [category.id, category]));
    const out: Category[] = [];
    let cursor = this.categoryTreeParentId();

    while (cursor) {
      const node = byId.get(cursor);
      if (!node) break;
      out.unshift(node);
      cursor = node.parentId || null;
    }

    return out;
  });

  supplierOptions = computed(() => this.suppliers.getActive());
  hasActiveFilters = computed(() => Boolean(this.searchTerm().trim()) || this.stockFilter() !== "all");

  filteredRows = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const stockFilter = this.stockFilter();

    return [...this.rows()]
      .filter((row) => {
        if (stockFilter === "low" && (row.quantity_on_hand === 0 || row.quantity_on_hand > 3)) return false;
        if (stockFilter === "sold_out" && row.quantity_on_hand > 0) return false;
        if (stockFilter === "without_price" && row.unit_price && row.unit_price > 0) return false;

        if (!term) return true;

        const blob = [
          row.title,
          row.category_hint || "",
          this.supplierName(row.supplier_id),
          row.variant_name || "",
          row.color_name || "",
          row.size_label || "",
          row.notes || "",
        ]
          .join(" ")
          .toLowerCase();

        return blob.includes(term);
      })
      .sort((a, b) => {
        const qtyDiff = a.quantity_on_hand - b.quantity_on_hand;
        if (qtyDiff !== 0) return qtyDiff;
        return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
      });
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await Promise.all([this.inventory.loadFromFirestore(), this.categories.loadCategories(), this.suppliers.loadFromFirestore()]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar inventario");
    } finally {
      this.loading.set(false);
    }
  }

  startCreate() {
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.categoryQuery.set("");
    this.categoryConfirmed.set(false);
    this.selectedCategoryId.set(null);
    this.categoryDropdownOpen.set(false);
    this.error.set(null);
    this.success.set(null);
    this.deleteDialogItem.set(null);
  }

  startEdit(item: InventoryItem) {
    this.editingId.set(item.inventory_id);
    this.draft = {
      inventory_id: item.inventory_id,
      title: item.title,
      category_hint: item.category_hint || "",
      supplier_id: item.supplier_id || "",
      variant_name: item.variant_name || "",
      color_name: item.color_name || "",
      size_label: item.size_label || "",
      quantity_on_hand: item.quantity_on_hand,
      unit_price: item.unit_price,
      notes: item.notes || "",
      image_urls: item.image_urls || [],
      source_reason: item.source_reason || "devolucion",
    };

    this.categoryQuery.set(item.category_hint || "");
    this.categoryConfirmed.set(Boolean(item.category_hint));
    this.selectedCategoryId.set(this.findCategoryIdByPath(item.category_hint || ""));
    this.categoryDropdownOpen.set(false);
    this.error.set(null);
    this.success.set(null);
    this.deleteDialogItem.set(null);
  }

  onCategoryInputChange(value: string) {
    this.categoryQuery.set(value);
    this.draft.category_hint = value;
    this.categoryConfirmed.set(false);
    this.selectedCategoryId.set(null);
    this.categoryDropdownOpen.set(value.trim().length >= 2);
  }

  onCategoryInputFocus() {
    this.categoryDropdownOpen.set(this.categoryQuery().trim().length >= 2);
  }

  onCategoryInputBlur() {
    setTimeout(() => this.categoryDropdownOpen.set(false), 120);
  }

  selectCategory(category: Category) {
    if (this.hasCategoryChildren(category.id)) {
      this.error.set("Para productos debes seleccionar una categoria final (sin subcategorias).");
      this.categoryConfirmed.set(false);
      this.selectedCategoryId.set(null);
      return;
    }

    this.categoryQuery.set(category.fullPath);
    this.draft.category_hint = category.fullPath;
    this.categoryConfirmed.set(true);
    this.selectedCategoryId.set(category.id);
    this.categoryDropdownOpen.set(false);
    this.categoryTreeOpen.set(false);
  }

  openCategoryTree() {
    this.categoryTreeParentId.set(null);
    this.categoryTreeOpen.set(true);
    this.categoryDropdownOpen.set(false);
  }

  closeCategoryTree() {
    this.categoryTreeOpen.set(false);
  }

  goBackCategoryTree() {
    const parentId = this.categoryTreeParentId();
    if (!parentId) return;

    const current = this.categoryOptions().find((category) => category.id === parentId) || null;
    this.categoryTreeParentId.set(current?.parentId || null);
  }

  openCategoryBranch(category: Category) {
    if (!this.hasCategoryChildren(category.id)) {
      this.selectCategory(category);
      return;
    }
    this.categoryTreeParentId.set(category.id);
  }

  hasCategoryChildren(categoryId: string): boolean {
    return (this.categoryChildrenMap().get(categoryId) || []).length > 0;
  }

  async onImageFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;

    this.error.set(null);
    this.uploadingImages.set(true);

    try {
      const uploadedUrls: string[] = [];
      const alreadyUploaded = this.draft.image_urls.length;
      const incoming = files.length;

      if (alreadyUploaded >= InventarioPage.MAX_IMAGES) {
        throw new Error(`Ya alcanzaste el maximo de ${InventarioPage.MAX_IMAGES} imagenes por item.`);
      }

      if (alreadyUploaded + incoming > InventarioPage.MAX_IMAGES) {
        throw new Error(
          `Solo puedes tener hasta ${InventarioPage.MAX_IMAGES} imagenes. Ya tienes ${alreadyUploaded} y estas intentando subir ${incoming}.`,
        );
      }

      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          throw new Error(`Archivo invalido: ${file.name}. Solo se permiten imagenes.`);
        }

        if (file.size > 5 * 1024 * 1024) {
          throw new Error(`La imagen ${file.name} supera 5MB.`);
        }

        const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = `inventory-images/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${cleanName}`;
        const storageRef = ref(STORAGE, fileName);

        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);
        uploadedUrls.push(url);
      }

      this.draft.image_urls = [...this.draft.image_urls, ...uploadedUrls];
      this.success.set(`${uploadedUrls.length} imagen(es) subida(s)`);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron subir las imagenes");
    } finally {
      this.uploadingImages.set(false);
      input.value = "";
    }
  }

  removeDraftImage(index: number) {
    this.draft.image_urls = this.draft.image_urls.filter((_, imageIndex) => imageIndex !== index);
  }

  openPicker(input: HTMLInputElement) {
    input.click();
  }

  remainingImageSlots(): number {
    return Math.max(0, InventarioPage.MAX_IMAGES - this.draft.image_urls.length);
  }

  clearFilters() {
    this.searchTerm.set("");
    this.stockFilter.set("all");
  }

  onStockFilterChange(next: string) {
    if (next === "low" || next === "sold_out" || next === "without_price" || next === "all") {
      this.stockFilter.set(next);
      return;
    }
    this.stockFilter.set("all");
  }

  applyQuickFilter(next: StockFilter) {
    this.stockFilter.set(next);
  }

  async save() {
    this.error.set(null);
    this.success.set(null);

    const title = this.draft.title.trim();
    if (!title) {
      this.error.set("El nombre del producto es obligatorio");
      return;
    }

    if (!this.categoryConfirmed()) {
      this.error.set("Selecciona la categoria desde la lista de sugerencias.");
      return;
    }

    const selectedId = this.selectedCategoryId();
    if (!selectedId) {
      this.error.set("Selecciona una categoria valida.");
      return;
    }

    if (this.hasCategoryChildren(selectedId)) {
      this.error.set("Selecciona una categoria final, no una categoria padre.");
      return;
    }

    if (!Number.isFinite(this.draft.quantity_on_hand) || this.draft.quantity_on_hand < 0) {
      this.error.set("La cantidad debe ser cero o mayor");
      return;
    }

    this.saving.set(true);

    try {
      const payload: InventoryItem = {
        inventory_id: this.draft.inventory_id,
        title,
        category_hint: this.draft.category_hint || null,
        supplier_id: this.draft.supplier_id || null,
        variant_name: this.trimOrNull(this.draft.variant_name),
        color_name: this.trimOrNull(this.draft.color_name),
        size_label: this.trimOrNull(this.draft.size_label),
        quantity_on_hand: this.draft.quantity_on_hand,
        unit_price: this.draft.unit_price,
        notes: this.trimOrNull(this.draft.notes),
        image_urls: this.draft.image_urls,
        source_reason: this.draft.source_reason,
      };

      await this.inventory.save(payload);
      const isEditing = Boolean(this.editingId());
      const message = isEditing ? "Item actualizado" : "Item agregado al inventario";
      this.startCreate();
      this.success.set(message);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar el item");
    } finally {
      this.saving.set(false);
    }
  }

  askRemove(item: InventoryItem) {
    this.deleteDialogItem.set(item);
  }

  cancelRemove() {
    this.deleteDialogItem.set(null);
  }

  async confirmRemove() {
    const item = this.deleteDialogItem();
    if (!item) return;
    await this.remove(item);
    this.deleteDialogItem.set(null);
  }

  private async remove(item: InventoryItem) {
    this.setBusy(item.inventory_id, true);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.inventory.delete(item.inventory_id);
      this.success.set("Item eliminado");
      if (this.editingId() === item.inventory_id) {
        this.startCreate();
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo eliminar el item");
    } finally {
      this.setBusy(item.inventory_id, false);
    }
  }

  async adjustQty(item: InventoryItem, delta: number) {
    if (this.isBusy(item.inventory_id)) return;
    if (item.quantity_on_hand === 0 && delta < 0) return;

    this.setBusy(item.inventory_id, true);
    this.error.set(null);

    try {
      await this.inventory.adjustQuantity(item.inventory_id, delta);
      if (this.editingId() === item.inventory_id) {
        const updated = this.rows().find((row) => row.inventory_id === item.inventory_id);
        if (updated) this.startEdit(updated);
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo ajustar cantidad");
    } finally {
      this.setBusy(item.inventory_id, false);
    }
  }

  isBusy(itemId: string): boolean {
    return Boolean(this.busyById()[itemId]);
  }

  supplierName(supplierId: string | null): string {
    if (!supplierId) return "Sin proveedor";
    return this.suppliers.getById(supplierId)?.display_name || supplierId;
  }

  stockTag(qty: number): string {
    if (qty === 0) return "Agotado";
    if (qty <= 3) return "Pocas piezas";
    return "Disponible";
  }

  stockClass(qty: number): string {
    if (qty === 0) return "tag-out";
    if (qty <= 3) return "tag-low";
    return "tag-ok";
  }

  formatMoney(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      maximumFractionDigits: 2,
    }).format(value);
  }

  formatCount(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      maximumFractionDigits: 0,
    }).format(value);
  }

  primaryImage(item: InventoryItem): string | null {
    return item.image_urls?.[0] || null;
  }

  @HostListener("document:keydown.escape")
  onEscapePressed() {
    if (this.categoryTreeOpen()) {
      this.closeCategoryTree();
      return;
    }
    if (this.deleteDialogItem()) {
      this.cancelRemove();
    }
  }

  private setBusy(itemId: string, value: boolean) {
    this.busyById.update((current) => ({ ...current, [itemId]: value }));
  }

  private emptyDraft(): InventoryDraft {
    return {
      inventory_id: "",
      title: "",
      category_hint: "",
      supplier_id: "",
      variant_name: "",
      color_name: "",
      size_label: "",
      quantity_on_hand: 1,
      unit_price: null,
      notes: "",
      image_urls: [],
      source_reason: "devolucion",
    };
  }

  private trimOrNull(value: string): string | null {
    const next = value.trim();
    return next ? next : null;
  }

  private sortCategories(rows: Category[]): Category[] {
    return [...rows].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
    });
  }

  private findCategoryIdByPath(path: string): string | null {
    if (!path) return null;
    return this.categoryOptions().find((category) => category.fullPath === path)?.id || null;
  }
}
