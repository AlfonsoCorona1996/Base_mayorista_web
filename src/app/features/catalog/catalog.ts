import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { SuppliersService } from "../../core/suppliers.service";
import type {
  NormalizedItemV3,
  NormalizedListingDocV3,
  StockState,
} from "../../core/firestore-contracts";
import { isNormalizedListingDocV3 } from "../../core/firestore-contracts";

@Component({
  standalone: true,
  selector: "app-catalog",
  imports: [FormsModule],
  templateUrl: "./catalog.html",
  styleUrl: "./catalog.css",
})
export default class CatalogPage {
  private readonly requiredSchemaVersion = "normalized_v3.0";
  readonly stockStates: StockState[] = ["in_stock", "last_pair", "out_of_stock", "unknown_qty"];
  readonly stockFilterOptions: Array<{ value: StockState | ""; label: string }> = [
    { value: "", label: "Estado (todos)" },
    { value: "in_stock", label: "Disponible" },
    { value: "last_pair", label: "Ultima pieza" },
    { value: "out_of_stock", label: "Agotado" },
    { value: "unknown_qty", label: "Sin confirmar" },
  ];

  searchTerm = signal("");
  supplierFilter = signal("");
  categoryFilter = signal("");
  colorFilter = signal("");
  statusFilter = signal<StockState | "">("");
  hideOutOfStock = signal(false);

  rows = signal<NormalizedListingDocV3[]>([]);
  loading = signal(false);
  loadingMore = signal(false);
  error = signal<string | null>(null);
  hasMore = signal(true);
  busyById = signal<Record<string, boolean>>({});

  private cursor: QueryDocumentSnapshot<DocumentData> | null | undefined;

  private svc = inject(NormalizedListingsService);
  private suppliers = inject(SuppliersService);
  private router = inject(Router);

  constructor() {
    this.reload();
  }

  suppliersOptions = computed(() => {
    const options = new Map<string, string>();

    this.rows().forEach((doc) => {
      if (!doc.supplier_id) return;
      options.set(doc.supplier_id, this.supplierName(doc.supplier_id));
    });

    return Array.from(options.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
  });

  categoriesOptions = computed(() => {
    const values = new Set<string>();
    this.rows().forEach((doc) => {
      const cat = (doc.listing.category_hint || "").trim();
      if (cat) values.add(cat);
    });

    return Array.from(values).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
  });

  colorsOptions = computed(() => {
    const values = new Set<string>();
    this.rows().forEach((doc) => {
      this.getColorNames(doc).forEach((name) => values.add(name));
    });

    return Array.from(values).sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
  });

  filteredRows = computed(() => {
    const search = this.searchTerm().trim().toLowerCase();
    const supplier = this.supplierFilter().trim().toLowerCase();
    const category = this.categoryFilter().trim().toLowerCase();
    const color = this.colorFilter().trim().toLowerCase();
    const status = this.statusFilter();
    const hideOut = this.hideOutOfStock();

    return this.rows().filter((doc) => {
      const title = (doc.listing.title || "").toLowerCase();
      const supplierId = (doc.supplier_id || "").toLowerCase();
      const supplierName = this.supplierName(doc.supplier_id).toLowerCase();
      const categoryText = (doc.listing.category_hint || "").toLowerCase();
      const colors = this.getColorNames(doc).map((c) => c.toLowerCase());
      const productState = this.getStockState(doc);

      const textOk =
        !search ||
        title.includes(search) ||
        supplierName.includes(search) ||
        supplierId.includes(search) ||
        categoryText.includes(search) ||
        colors.some((c) => c.includes(search));

      const supplierOk = !supplier || supplierId === supplier;
      const categoryOk = !category || categoryText === category;
      const colorOk = !color || colors.includes(color);
      const statusOk = !status || productState === status;
      const stockVisibilityOk = !hideOut || productState !== "out_of_stock";

      return textOk && supplierOk && categoryOk && colorOk && statusOk && stockVisibilityOk;
    });
  });

  hasActiveFilters = computed(
    () =>
      this.searchTerm().trim().length > 0 ||
      this.supplierFilter().trim().length > 0 ||
      this.categoryFilter().trim().length > 0 ||
      this.colorFilter().trim().length > 0 ||
      this.statusFilter().trim().length > 0 ||
      this.hideOutOfStock()
  );

  async reload() {
    this.error.set(null);
    this.loading.set(true);
    this.cursor = undefined;
    this.hasMore.set(true);

    try {
      const { docs, nextCursor } = await this.svc.listValidated(24);
      const v3Docs = docs.filter((doc) => this.isRequiredSchema(doc));
      const skipped = docs.length - v3Docs.length;

      this.rows.set(v3Docs);
      this.cursor = nextCursor;
      this.hasMore.set(Boolean(nextCursor));

      if (skipped > 0) {
        this.error.set(
          `Se omitieron ${skipped} registro(s) con esquema incompatible. Solo se admite ${this.requiredSchemaVersion}.`
        );
      }
    } catch (e: any) {
      this.error.set(e?.message || "Error cargando catalogo");
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore() {
    if (!this.cursor) {
      this.hasMore.set(false);
      return;
    }

    this.error.set(null);
    this.loadingMore.set(true);
    try {
      const { docs, nextCursor } = await this.svc.listValidated(24, this.cursor);
      const v3Docs = docs.filter((doc) => this.isRequiredSchema(doc));
      const skipped = docs.length - v3Docs.length;

      this.rows.set([...this.rows(), ...v3Docs]);
      this.cursor = nextCursor;
      this.hasMore.set(Boolean(nextCursor));

      if (skipped > 0) {
        this.error.set(
          `Se omitieron ${skipped} registro(s) con esquema incompatible. Solo se admite ${this.requiredSchemaVersion}.`
        );
      }
    } catch (e: any) {
      this.error.set(e?.message || "Error cargando mas");
    } finally {
      this.loadingMore.set(false);
    }
  }

  clearFilters() {
    this.searchTerm.set("");
    this.supplierFilter.set("");
    this.categoryFilter.set("");
    this.colorFilter.set("");
    this.statusFilter.set("");
    this.hideOutOfStock.set(false);
  }

  onStatusFilterChange(next: StockState | "") {
    this.statusFilter.set(next);
    if (next === "out_of_stock" && this.hideOutOfStock()) {
      this.hideOutOfStock.set(false);
    }
  }

  onToggleHideOutOfStock(next: boolean) {
    if (next && this.statusFilter() === "out_of_stock") {
      this.statusFilter.set("");
    }
    this.hideOutOfStock.set(next);
  }

  async open(normalizedId: string) {
    await this.router.navigateByUrl(`/main/catalogo/${normalizedId}`);
  }

  async markProductOutOfStock(normalizedId: string, event: Event) {
    event.stopPropagation();

    const target = this.rows().find((doc) => doc.normalized_id === normalizedId);
    if (!target || this.isBusy(normalizedId)) return;

    const ok = confirm("Marcar TODO el producto como agotado?\nEsto aplica a todas las variantes y colores.");
    if (!ok) return;

    this.setBusy(normalizedId, true);
    this.error.set(null);

    try {
      const listing = structuredClone(target.listing);
      listing.items = listing.items.map((item) => this.toItemOutOfStock(item));

      await this.svc.updateListing(normalizedId, { listing });

      this.rows.update((rows) =>
        rows.map((row) =>
          row.normalized_id === normalizedId
            ? {
                ...row,
                listing,
              }
            : row
        )
      );
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo actualizar el stock");
    } finally {
      this.setBusy(normalizedId, false);
    }
  }

  isBusy(normalizedId: string): boolean {
    return Boolean(this.busyById()[normalizedId]);
  }

  supplierName(supplierId: string | null | undefined): string {
    if (!supplierId) return "Sin proveedor";
    const supplier = this.suppliers.getById(supplierId);
    return supplier?.display_name || supplierId;
  }

  getCoverImage(doc: NormalizedListingDocV3): string | null {
    const cover = doc.cover_images?.[0];
    return cover || doc.preview_image_url || null;
  }

  getStockState(doc: NormalizedListingDocV3): StockState {
    const states = doc.listing.items.flatMap((item) => {
      const colorStates = (item.color_stock || []).map((entry) => this.normalizeStockState(entry.stock_state));
      return [this.normalizeStockState(item.stock_state), ...colorStates];
    });

    const validStates = states.filter((state): state is StockState => Boolean(state));
    if (validStates.length === 0) return "unknown_qty";

    if (validStates.every((state) => state === "out_of_stock")) return "out_of_stock";
    if (validStates.some((state) => state === "in_stock")) return "in_stock";
    if (validStates.some((state) => state === "last_pair")) return "last_pair";
    return "unknown_qty";
  }

  stockLabel(state: StockState): string {
    switch (state) {
      case "in_stock":
        return "Disponible";
      case "last_pair":
        return "Ultima pieza";
      case "out_of_stock":
        return "Agotado";
      default:
        return "Sin confirmar";
    }
  }

  stockClass(state: StockState): string {
    switch (state) {
      case "in_stock":
        return "stock-ok";
      case "last_pair":
        return "stock-low";
      case "out_of_stock":
        return "stock-out";
      default:
        return "stock-unknown";
    }
  }

  getColorNames(doc: NormalizedListingDocV3): string[] {
    const fromGlobal = (doc.product_colors || []).map((c) => (c.name || "").trim()).filter(Boolean);
    if (fromGlobal.length > 0) {
      return Array.from(new Set(fromGlobal));
    }

    const fromItems = doc.listing.items
      .flatMap((item) => {
        const fromColorStock = (item.color_stock || []).map((entry) => entry.color_name);
        return fromColorStock;
      })
      .map((name) => (name || "").trim())
      .filter(Boolean);

    return Array.from(new Set(fromItems));
  }

  timeAgo(ts: any): string {
    const d: Date | null = ts?.toDate?.() ? ts.toDate() : ts instanceof Date ? ts : null;

    if (!d) return "sin fecha";

    const diffMs = Date.now() - d.getTime();
    const sec = Math.max(0, Math.floor(diffMs / 1000));
    if (sec < 60) return `hace ${sec}s`;

    const min = Math.floor(sec / 60);
    if (min < 60) return `hace ${min} min`;

    const hr = Math.floor(min / 60);
    if (hr < 24) return `hace ${hr} h`;

    const days = Math.floor(hr / 24);
    return `hace ${days} d`;
  }

  private setBusy(normalizedId: string, value: boolean) {
    this.busyById.update((current) => ({ ...current, [normalizedId]: value }));
  }

  private toItemOutOfStock(item: NormalizedItemV3): NormalizedItemV3 {
    const next: NormalizedItemV3 = {
      ...item,
      stock_state: "out_of_stock",
    };

    const colors = this.getItemColors(item);
    if (colors.length > 0) {
      next.color_stock = colors.map((color_name) => ({ color_name, stock_state: "out_of_stock" }));
    }

    return next;
  }

  private getItemColors(item: NormalizedItemV3): string[] {
    const list = (item.color_stock || [])
      .map((entry) => entry.color_name)
      .map((name) => (name || "").trim())
      .filter(Boolean);

    return Array.from(new Set(list));
  }

  private isRequiredSchema(doc: unknown): doc is NormalizedListingDocV3 {
    return isNormalizedListingDocV3(doc) && doc.schema_version === this.requiredSchemaVersion;
  }

  private normalizeStockState(value: unknown): StockState | null {
    if (typeof value !== "string") return null;
    if (this.stockStates.includes(value as StockState)) {
      return value as StockState;
    }
    return null;
  }
}
