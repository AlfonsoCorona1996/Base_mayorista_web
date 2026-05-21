import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { CategoriesService, Category } from "../../core/categories.service";
import { STORAGE } from "../../core/firebase.providers";
import { InventoryItem, InventoryReservation, InventoryService } from "../../core/inventory.service";
import { OrdersService } from "../../core/orders.service";
import { SuppliersService } from "../../core/suppliers.service";

type StockFilter = "all" | "available" | "reserved" | "low" | "sold_out" | "without_price";
type SortFilter = "updated_desc" | "name_asc" | "stock_low" | "stock_high" | "price_low" | "price_high";
type ReservationEntry = { orderId: string; qty: number; orderNumber: string; status: string };

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-inventario",
  imports: [FormsModule, RouterLink],
  templateUrl: "./inventario.html",
  styleUrl: "./inventario.css",
})
export default class InventarioPage {
  private static readonly MAX_IMAGES = 8;
  private static readonly RESERVATION_PREVIEW_LIMIT = 2;

  loading = signal(false);
  saving = signal(false);
  uploadingImages = signal(false);
  busyById = signal<Record<string, boolean>>({});
  editingId = signal<string | null>(null);
  formDialogOpen = signal(false);
  deleteDialogItem = signal<InventoryItem | null>(null);
  imageViewerOpen = signal(false);
  imageViewerUrls = signal<string[]>([]);
  imageViewerIndex = signal(0);

  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  stockFilter = signal<StockFilter>("all");
  hideSoldOut = signal(true);
  sortFilter = signal<SortFilter>("stock_low");
  filterCategoryPath = signal("all");
  filterSupplierId = signal("all");
  minStockFilter = signal<number | null>(null);
  maxStockFilter = signal<number | null>(null);
  minPriceFilter = signal<number | null>(null);
  maxPriceFilter = signal<number | null>(null);

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
  private orders = inject(OrdersService);

  constructor() {
    this.reload();
  }

  rows = computed(() => this.inventory.items());
  orderStatusById = computed(() => new Map(this.orders.list().map((order) => [order.order_id, order.status])));
  currentViewerImage = computed(() => this.imageViewerUrls()[this.imageViewerIndex()] || null);
  viewerHasMultipleImages = computed(() => this.imageViewerUrls().length > 1);

  totalUnits = computed(() => this.rows().reduce((sum, row) => sum + this.onHandQty(row), 0));
  totalAvailableUnits = computed(() => this.rows().reduce((sum, row) => sum + this.availableQty(row), 0));

  lowStockCount = computed(() => this.rows().filter((row) => this.availableQty(row) > 0 && this.availableQty(row) <= 3).length);

  soldOutCount = computed(() => this.rows().filter((row) => this.onHandQty(row) === 0).length);
  reservedCount = computed(() => this.rows().filter((row) => this.reservedQty(row) > 0).length);
  withoutPriceCount = computed(() => this.rows().filter((row) => !row.unit_price || row.unit_price <= 0).length);
  totalInvestment = computed(() =>
    this.rows().reduce((sum, row) => sum + (row.unit_price || 0) * this.onHandQty(row), 0),
  );

  categoryOptions = computed(() => this.categories.getAll());
  categoryFilterOptions = computed(() =>
    [...new Set(this.categoryOptions().map((category) => category.fullPath).filter((path) => Boolean(path)))]
      .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" })),
  );

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
  editingReservedQty = computed(() => {
    const editingId = this.editingId();
    if (!editingId) return 0;
    const row = this.rows().find((item) => item.inventory_id === editingId);
    return row ? this.reservedQty(row) : 0;
  });

  activeFilterCount = computed(() => {
    let count = 0;
    if (this.searchTerm().trim()) count += 1;
    if (this.stockFilter() !== "all") count += 1;
    if (this.filterCategoryPath() !== "all") count += 1;
    if (this.filterSupplierId() !== "all") count += 1;
    if (this.minStockFilter() !== null || this.maxStockFilter() !== null) count += 1;
    if (this.minPriceFilter() !== null || this.maxPriceFilter() !== null) count += 1;
    if (this.sortFilter() !== "stock_low") count += 1;
    return count;
  });

  hasActiveFilters = computed(() => this.activeFilterCount() > 0);

  filteredRows = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const stockFilter = this.stockFilter();
    const selectedCategoryPath = this.filterCategoryPath();
    const selectedSupplierId = this.filterSupplierId();
    const minStock = this.minStockFilter();
    const maxStock = this.maxStockFilter();
    const minPrice = this.minPriceFilter();
    const maxPrice = this.maxPriceFilter();
    const sortBy = this.sortFilter();

    return [...this.rows()]
      .filter((row) => {
        const onHand = this.onHandQty(row);
        const reserved = this.reservedQty(row);
        const available = this.availableQty(row);
        const unitPrice = row.unit_price;

        if (this.hideSoldOut() && stockFilter !== "sold_out" && onHand === 0) return false;

        if (stockFilter === "available" && available <= 0) return false;
        if (stockFilter === "reserved" && reserved <= 0) return false;
        if (stockFilter === "low" && (available === 0 || available > 3)) return false;
        if (stockFilter === "sold_out" && onHand > 0) return false;
        if (stockFilter === "without_price" && unitPrice && unitPrice > 0) return false;

        if (selectedCategoryPath !== "all" && !this.matchesCategoryPath(row.category_hint, selectedCategoryPath)) return false;
        if (selectedSupplierId !== "all" && (row.supplier_id || "") !== selectedSupplierId) return false;
        if (!this.isWithinRange(available, minStock, maxStock)) return false;
        if (!this.matchesPriceRange(unitPrice, minPrice, maxPrice)) return false;

        if (!term) return true;

        const blob = [
          row.title,
          row.sku || "",
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
      .sort((a, b) => this.compareRows(a, b, sortBy));
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await Promise.all([
        this.inventory.loadFromFirestore(),
        this.categories.loadCategories(),
        this.suppliers.loadFromFirestore(),
        this.orders.loadFromFirestore(),
      ]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar inventario");
    } finally {
      this.loading.set(false);
    }
  }

  openCreateDialog() {
    this.startCreate();
    this.formDialogOpen.set(true);
  }

  closeFormDialog() {
    this.formDialogOpen.set(false);
    this.editingId.set(null);
    this.draft = this.emptyDraft();
    this.categoryQuery.set("");
    this.categoryConfirmed.set(false);
    this.selectedCategoryId.set(null);
    this.categoryDropdownOpen.set(false);
    this.categoryTreeOpen.set(false);
    this.error.set(null);
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
      quantity_on_hand: this.onHandQty(item),
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
    this.formDialogOpen.set(true);
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
    this.hideSoldOut.set(true);
    this.sortFilter.set("stock_low");
    this.filterCategoryPath.set("all");
    this.filterSupplierId.set("all");
    this.minStockFilter.set(null);
    this.maxStockFilter.set(null);
    this.minPriceFilter.set(null);
    this.maxPriceFilter.set(null);
  }

  onStockFilterChange(next: string) {
    if (
      next === "all" ||
      next === "available" ||
      next === "reserved" ||
      next === "low" ||
      next === "sold_out" ||
      next === "without_price"
    ) {
      this.stockFilter.set(next);
      return;
    }
    this.stockFilter.set("all");
  }

  onSortFilterChange(next: string) {
    if (
      next === "updated_desc" ||
      next === "name_asc" ||
      next === "stock_low" ||
      next === "stock_high" ||
      next === "price_low" ||
      next === "price_high"
    ) {
      this.sortFilter.set(next);
      return;
    }
    this.sortFilter.set("stock_low");
  }

  onOptionalNumberFilterChange(
    key: "minStock" | "maxStock" | "minPrice" | "maxPrice",
    rawValue: string | number | null,
  ) {
    const value = this.toOptionalNumber(rawValue);
    if (key === "minStock") {
      this.minStockFilter.set(value);
      return;
    }
    if (key === "maxStock") {
      this.maxStockFilter.set(value);
      return;
    }
    if (key === "minPrice") {
      this.minPriceFilter.set(value);
      return;
    }
    this.maxPriceFilter.set(value);
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

    const existing = this.editingId()
      ? this.rows().find((row) => row.inventory_id === this.editingId())
      : null;
    const reservedQty = existing ? this.reservedQty(existing) : 0;

    if (this.draft.quantity_on_hand < reservedQty) {
      this.error.set(`No puedes dejar menos piezas on hand que las ${reservedQty} reservadas activas.`);
      return;
    }

    this.saving.set(true);

    try {
      const onHandQty = Math.max(0, Math.trunc(this.draft.quantity_on_hand));
      const availableQty = Math.max(0, onHandQty - reservedQty);
      const payload: InventoryItem = {
        inventory_id: this.draft.inventory_id,
        title,
        category_hint: this.draft.category_hint || null,
        supplier_id: this.draft.supplier_id || null,
        variant_name: this.trimOrNull(this.draft.variant_name),
        color_name: this.trimOrNull(this.draft.color_name),
        size_label: this.trimOrNull(this.draft.size_label),
        on_hand_qty: onHandQty,
        reserved_qty: reservedQty,
        available_qty: availableQty,
        quantity_on_hand: availableQty,
        unit_price: this.draft.unit_price,
        notes: this.trimOrNull(this.draft.notes),
        image_urls: this.draft.image_urls,
        source_reason: this.draft.source_reason,
        reservations: existing?.reservations || {},
      };

      await this.inventory.save(payload);
      const isEditing = Boolean(this.editingId());
      const message = isEditing ? "Item actualizado" : "Item agregado al inventario";
      this.startCreate();
      this.closeFormDialog();
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
    if (delta < 0 && !this.canDecreaseStock(item)) return;

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

  stockTag(item: InventoryItem): string {
    const available = this.availableQty(item);
    const reserved = this.reservedQty(item);
    const onHand = this.onHandQty(item);

    if (available === 0 && reserved > 0 && onHand > 0) return "Reservado";
    if (onHand === 0) return "Agotado";
    if (available <= 3) return "Pocas piezas";
    return "Disponible";
  }

  stockClass(item: InventoryItem): string {
    const available = this.availableQty(item);
    const reserved = this.reservedQty(item);
    const onHand = this.onHandQty(item);

    if (available === 0 && reserved > 0 && onHand > 0) return "tag-reserved";
    if (onHand === 0) return "tag-out";
    if (available <= 3) return "tag-low";
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

  openImageViewer(item: InventoryItem, startIndex = 0) {
    const urls = (item.image_urls || []).filter((url): url is string => Boolean(url));
    if (urls.length === 0) return;

    const safeIndex = Math.max(0, Math.min(Math.trunc(startIndex), urls.length - 1));
    this.imageViewerUrls.set(urls);
    this.imageViewerIndex.set(safeIndex);
    this.imageViewerOpen.set(true);
  }

  closeImageViewer() {
    this.imageViewerOpen.set(false);
    this.imageViewerUrls.set([]);
    this.imageViewerIndex.set(0);
  }

  showPreviousViewerImage() {
    const total = this.imageViewerUrls().length;
    if (total <= 1) return;
    this.imageViewerIndex.update((current) => (current - 1 + total) % total);
  }

  showNextViewerImage() {
    const total = this.imageViewerUrls().length;
    if (total <= 1) return;
    this.imageViewerIndex.update((current) => (current + 1) % total);
  }

  viewerPositionLabel(): string {
    const total = this.imageViewerUrls().length;
    if (total === 0) return "";
    return `${this.imageViewerIndex() + 1} / ${total}`;
  }

  onHandQty(item: InventoryItem): number {
    if (item.on_hand_qty !== null && item.on_hand_qty !== undefined) {
      return Math.max(0, Math.trunc(Number(item.on_hand_qty) || 0));
    }
    if (item.available_qty !== null && item.available_qty !== undefined && item.reserved_qty !== null && item.reserved_qty !== undefined) {
      return Math.max(0, Math.trunc(Number(item.available_qty || 0) + Number(item.reserved_qty || 0)));
    }
    return Math.max(0, Math.trunc(Number(item.quantity_on_hand || 0)));
  }

  reservedQty(item: InventoryItem): number {
    const entries = this.reservationEntries(item);
    const fromMap = entries.reduce((sum, entry) => sum + entry.qty, 0);
    const hasMap = Object.keys(item.reservations || {}).length > 0;

    if (hasMap) return Math.max(0, Math.trunc(fromMap));
    return Math.max(0, Math.trunc(Number(item.reserved_qty || 0)));
  }

  availableQty(item: InventoryItem): number {
    return Math.max(0, Math.trunc(this.onHandQty(item) - this.reservedQty(item)));
  }

  hasReservations(item: InventoryItem): boolean {
    return this.reservedQty(item) > 0;
  }

  reservationEntries(item: InventoryItem): ReservationEntry[] {
    const reservations = item.reservations || {};
    return Object.entries(reservations)
      .map(([orderId, reservation]) => ({
        orderId,
        qty: Number((reservation as InventoryReservation)?.qty || 0),
        orderNumber: (reservation as InventoryReservation)?.order_number || orderId,
        status: (reservation as InventoryReservation)?.status || "reserved",
      }))
      .filter((entry) => entry.qty > 0 && this.isReservationActive(entry.orderId, entry.status))
      .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, "es", { sensitivity: "base" }));
  }

  reservationPreviewEntries(item: InventoryItem): ReservationEntry[] {
    return this.reservationEntries(item).slice(0, InventarioPage.RESERVATION_PREVIEW_LIMIT);
  }

  reservationOverflowCount(item: InventoryItem): number {
    return Math.max(0, this.reservationEntries(item).length - InventarioPage.RESERVATION_PREVIEW_LIMIT);
  }

  reservationCount(item: InventoryItem): number {
    return this.reservationEntries(item).length;
  }

  variantDescriptor(item: InventoryItem): string | null {
    const out: string[] = [];
    if (item.variant_name) out.push(`Variante ${item.variant_name}`);
    if (item.color_name) out.push(`Color ${item.color_name}`);
    if (item.size_label) out.push(`Talla ${item.size_label}`);
    return out.length > 0 ? out.join(" · ") : null;
  }

  canDecreaseStock(item: InventoryItem): boolean {
    return this.onHandQty(item) > this.reservedQty(item);
  }

  isFullyReserved(item: InventoryItem): boolean {
    return this.availableQty(item) === 0 && this.onHandQty(item) > 0 && this.reservedQty(item) > 0;
  }

  private matchesCategoryPath(itemPath: string | null, filterPath: string): boolean {
    const current = (itemPath || "").trim();
    if (!current) return false;
    return current === filterPath || current.startsWith(`${filterPath} > `);
  }

  private matchesPriceRange(price: number | null, min: number | null, max: number | null): boolean {
    if (min === null && max === null) return true;
    if (price === null || price === undefined) return false;
    return this.isWithinRange(price, min, max);
  }

  private isWithinRange(value: number, min: number | null, max: number | null): boolean {
    if (min !== null && value < min) return false;
    if (max !== null && value > max) return false;
    return true;
  }

  private compareRows(a: InventoryItem, b: InventoryItem, sortBy: SortFilter): number {
    if (sortBy === "updated_desc") {
      const aDate = this.pickBestTime(a.updated_at, a.created_at);
      const bDate = this.pickBestTime(b.updated_at, b.created_at);
      if (aDate !== bDate) return bDate - aDate;
      return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    }

    if (sortBy === "name_asc") {
      return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    }

    if (sortBy === "stock_high") {
      const diff = this.availableQty(b) - this.availableQty(a);
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    }

    if (sortBy === "price_low") {
      const diff = (a.unit_price || 0) - (b.unit_price || 0);
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    }

    if (sortBy === "price_high") {
      const diff = (b.unit_price || 0) - (a.unit_price || 0);
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    }

    const diff = this.availableQty(a) - this.availableQty(b);
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
  }

  private pickBestTime(...values: unknown[]): number {
    for (const value of values) {
      const date = this.toDate(value);
      if (date) return date.getTime();
    }
    return 0;
  }

  private toDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "object" && value !== null) {
      const maybe = value as { toDate?: () => Date };
      if (typeof maybe.toDate === "function") {
        const parsed = maybe.toDate();
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    }
    return null;
  }

  private isReservationActive(orderId: string, reservationStatus: string): boolean {
    const normalizedReservationStatus = String(reservationStatus || "reserved").toLowerCase();
    if (normalizedReservationStatus !== "reserved") return false;

    const orderStatus = this.orderStatusById().get(orderId);
    if (!orderStatus) return true;
    return !this.isClosedOrderStatus(orderStatus);
  }

  private isClosedOrderStatus(status: string): boolean {
    const normalized = String(status || "").toLowerCase();
    if (!normalized) return false;
    if (normalized === "closed" || normalized === "cancelado" || normalized === "devuelto") return true;
    if (normalized.includes("entregado")) return true;
    if (normalized.includes("delivered")) return true;
    if (normalized.includes("pagado")) return true;
    return false;
  }

  private toOptionalNumber(value: string | number | null): number | null {
    if (value === null || value === undefined || value === "") return null;
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Number(numeric));
  }

  @HostListener("document:keydown.escape")
  onEscapePressed() {
    if (this.imageViewerOpen()) {
      this.closeImageViewer();
      return;
    }
    if (this.categoryTreeOpen()) {
      this.closeCategoryTree();
      return;
    }
    if (this.deleteDialogItem()) {
      this.cancelRemove();
      return;
    }
    if (this.formDialogOpen()) {
      this.closeFormDialog();
    }
  }

  @HostListener("document:keydown.arrowleft")
  onArrowLeftPressed() {
    if (!this.imageViewerOpen()) return;
    this.showPreviousViewerImage();
  }

  @HostListener("document:keydown.arrowright")
  onArrowRightPressed() {
    if (!this.imageViewerOpen()) return;
    this.showNextViewerImage();
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
