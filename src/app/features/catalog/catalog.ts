import { Component, computed, effect, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { collection, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { SuppliersService } from "../../core/suppliers.service";
import { ManualProductHistoryService, ManualProductEntry } from "../../core/manual-product-history.service";
import { FIRESTORE } from "../../core/firebase.providers";
import { BusinessScopeService } from "../../core/business-scope.service";
import { CatalogProductsImportComponent } from "./catalog-products-import.component";
import { CurrencyPipe, DatePipe } from "@angular/common";
import type {
  NormalizedItemV3,
  NormalizedListingDocV3,
  StockState,
} from "../../core/firestore-contracts";
import { isNormalizedListingDocV3 } from "../../core/firestore-contracts";
import { OrdersService } from "../../core/orders.service";
import { InventoryService } from "../../core/inventory.service";
import { calculateItemFinancials } from "../../core/order-financials";

type CommercialFilter = "" | "unprofitable" | "high_returns" | "low_stock" | "no_cost" | "no_sku" | "slow" | "reorder";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-catalog",
  imports: [FormsModule, CurrencyPipe, DatePipe, CatalogProductsImportComponent],
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
  commercialFilter = signal<CommercialFilter>("");

  rows = signal<NormalizedListingDocV3[]>([]);
  loading = signal(false);
  loadingMore = signal(false);
  searchingAll = signal(false);
  catalogLoadedOnce = signal(false);
  error = signal<string | null>(null);
  hasMore = signal(true);
  busyById = signal<Record<string, boolean>>({});

  private cursor: QueryDocumentSnapshot<DocumentData> | null | undefined;
  private searchLoadFailedTerm = "";

  private svc       = inject(NormalizedListingsService);
  private suppliers = inject(SuppliersService);
  private router    = inject(Router);
  private orders = inject(OrdersService);
  private inventory = inject(InventoryService);
  readonly manualSvc = inject(ManualProductHistoryService);
  businessScope = inject(BusinessScopeService);
  private firestore = FIRESTORE;

  // ── Vista activa ─────────────────────────────────────────
  activeTab = signal<"catalog" | "catalogo_excel" | "manuales_bm" | "manuales_catalogo">("catalog");

  // ── Productos manuales ───────────────────────────────────
  manualSearch = signal("");
  manualBusy   = signal<Record<string, boolean>>({});
  manualError  = signal<string | null>(null);

  manualFiltered = computed(() => {
    const q = this.manualSearch().trim().toLowerCase();
    const businessId = this.manualBusinessForActiveTab();
    return this.manualSvc.entries().filter(e =>
      e.business_id === businessId &&
      (!q || e.title.toLowerCase().includes(q) ||
            e.variant.toLowerCase().includes(q) ||
            e.color.toLowerCase().includes(q))
    );
  });

  visibleTabs = computed(() => {
    const scope = this.businessScope.scope();
    if (scope === "catalogo") {
      return [
        { id: "catalogo_excel" as const, label: "Catálogo", icon: "table" },
        { id: "manuales_catalogo" as const, label: "Manuales Catálogo", icon: "edit_note" },
      ];
    }
    if (scope === "both") {
      return [
        { id: "catalog" as const, label: "Productos BM", icon: "inventory_2" },
        { id: "catalogo_excel" as const, label: "Catálogo", icon: "table" },
        { id: "manuales_bm" as const, label: "Manuales BM", icon: "edit_note" },
        { id: "manuales_catalogo" as const, label: "Manuales Catálogo", icon: "edit_note" },
      ];
    }
    return [
      { id: "catalog" as const, label: "Productos BM", icon: "inventory_2" },
      { id: "manuales_bm" as const, label: "Manuales BM", icon: "edit_note" },
    ];
  });

  constructor() {
    this.orders.loadFromFirestore();
    this.inventory.loadFromFirestore();
    effect(() => {
      const tabs = this.visibleTabs();
      if (!tabs.some((tab) => tab.id === this.activeTab())) {
        this.activeTab.set(tabs[0]?.id || "catalog");
      }
      const active = this.activeTab();
      if (active === "catalog" && !this.catalogLoadedOnce() && !this.loading()) {
        this.reload();
      }
      const currentSearch = this.searchTerm().trim().toLowerCase();
      const shouldCompleteSearch =
        active === "catalog" &&
        currentSearch.length > 0 &&
        currentSearch !== this.searchLoadFailedTerm &&
        this.catalogLoadedOnce() &&
        this.hasMore() &&
        !this.loading() &&
        !this.loadingMore() &&
        !this.searchingAll();
      if (shouldCompleteSearch) {
        void this.loadRemainingForSearch();
      }
      if (active === "manuales_bm" || active === "manuales_catalogo") {
        this.manualSvc.load(this.manualBusinessForActiveTab()).catch(() => null);
      }
    });
  }

  // ── Cambio de tab ─────────────────────────────────────────
  setTab(tab: "catalog" | "catalogo_excel" | "manuales_bm" | "manuales_catalogo"): void {
    this.activeTab.set(tab);
    if (tab === "manuales_bm" || tab === "manuales_catalogo") {
      this.manualSvc.load(this.manualBusinessForActiveTab()).catch(() => null);
    }
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

  private productStatsById = computed(() => new Map(this.rows().map((product) => [product.normalized_id, this.calculateProductStats(product)])));

  filteredRows = computed(() => {
    const search = this.searchTerm().trim().toLowerCase();
    const supplier = this.supplierFilter().trim().toLowerCase();
    const category = this.categoryFilter().trim().toLowerCase();
    const color = this.colorFilter().trim().toLowerCase();
    const status = this.statusFilter();
    const hideOut = this.hideOutOfStock();
    const commercial = this.commercialFilter();

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
      const stats = this.productStats(doc);
      const commercialOk = !commercial
        || (commercial === "unprofitable" && stats.units > 0 && stats.profit <= 0)
        || (commercial === "high_returns" && stats.returnRate >= 0.2)
        || (commercial === "low_stock" && stats.lowStock)
        || (commercial === "no_cost" && doc.listing.items.some((item) => !Number(item.prices?.precio_costo)))
        || (commercial === "no_sku" && doc.listing.items.some((item) => !(item.sku || "").trim()))
        || (commercial === "slow" && stats.slow)
        || (commercial === "reorder" && stats.reorder);

      return textOk && supplierOk && categoryOk && colorOk && statusOk && stockVisibilityOk && commercialOk;
    });
  });

  hasActiveFilters = computed(
    () =>
      this.searchTerm().trim().length > 0 ||
      this.supplierFilter().trim().length > 0 ||
      this.categoryFilter().trim().length > 0 ||
      this.colorFilter().trim().length > 0 ||
      this.statusFilter().trim().length > 0 ||
      this.commercialFilter().length > 0 ||
      this.hideOutOfStock()
  );

  async reload() {
    if (this.searchingAll()) return;
    this.error.set(null);
    this.loading.set(true);
    this.cursor = undefined;
    this.searchLoadFailedTerm = "";
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
      this.catalogLoadedOnce.set(true);
      this.loading.set(false);
    }
  }

  async loadMore() {
    if (this.loadingMore() || this.searchingAll()) return;
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
      this.searchLoadFailedTerm = "";

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

  private async loadRemainingForSearch(): Promise<void> {
    if (this.searchingAll() || this.loading() || this.loadingMore() || !this.cursor) return;

    this.searchingAll.set(true);
    this.error.set(null);
    let skipped = 0;

    try {
      while (
        this.cursor &&
        this.searchTerm().trim().length > 0 &&
        this.activeTab() === "catalog"
      ) {
        const currentCursor = this.cursor;
        const { docs, nextCursor } = await this.svc.listValidated(100, currentCursor);
        const v3Docs = docs.filter((doc) => this.isRequiredSchema(doc));
        skipped += docs.length - v3Docs.length;

        const existingIds = new Set(this.rows().map((doc) => doc.normalized_id));
        const newDocs = v3Docs.filter((doc) => !existingIds.has(doc.normalized_id));
        if (newDocs.length > 0) {
          this.rows.update((rows) => [...rows, ...newDocs]);
        }

        this.cursor = nextCursor;
        this.hasMore.set(Boolean(nextCursor));
      }

      if (skipped > 0) {
        this.error.set(
          `Se omitieron ${skipped} registro(s) con esquema incompatible. Solo se admite ${this.requiredSchemaVersion}.`
        );
      }
    } catch (error: unknown) {
      this.searchLoadFailedTerm = this.searchTerm().trim().toLowerCase();
      this.error.set(error instanceof Error && error.message
        ? error.message
        : "No se pudo completar la búsqueda en todo el catálogo");
    } finally {
      this.searchingAll.set(false);
    }
  }

  clearFilters() {
    this.searchTerm.set("");
    this.supplierFilter.set("");
    this.categoryFilter.set("");
    this.colorFilter.set("");
    this.statusFilter.set("");
    this.commercialFilter.set("");
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

  // ── Acciones productos manuales ──────────────────────────

  async deleteManual(entry: ManualProductEntry): Promise<void> {
    if (!confirm(`¿Eliminar "${entry.title}" del historial manual?`)) return;
    this.setManualBusy(entry.id, true);
    try {
      await this.manualSvc.delete(entry.id);
    } catch (e: any) {
      this.manualError.set(e?.message ?? "No se pudo eliminar");
    } finally {
      this.setManualBusy(entry.id, false);
    }
  }

  /**
   * Crea un listing provisional en `normalized_listings` con status "needs_review"
   * para que aparezca en la cola de revisión y el admin pueda completarlo.
   */
  async promoteToReview(entry: ManualProductEntry): Promise<void> {
    if (this.isManualBusy(entry.id)) return;
    this.setManualBusy(entry.id, true);
    this.manualError.set(null);
    try {
      const id = `manual_${entry.id}`;
      const previewImage = (entry.image_url || "").trim() || null;
      const listingDoc: Record<string, unknown> = {
        normalized_id: id,
        schema_version: "normalized_v3.0",
        business_id: entry.business_id || "bm",
        status: "needs_review",
        source: "manual_history",
        supplier_id: null,
        cover_images: previewImage ? [previewImage] : [],
        preview_image_url: previewImage,
        product_colors: [],
        listing: {
          title: entry.title,
          category_hint: "",
          items: [
            {
              size: entry.variant || "Único",
              stock_state: "unknown_qty",
              price_clienta: entry.price_clienta ?? 0,
              price_cost: entry.price_cost ?? 0,
              color_stock: entry.color
                ? [{ color_name: entry.color, stock_state: "unknown_qty" }]
                : [],
            },
          ],
        },
        created_at: serverTimestamp(),
        manual_entry_id: entry.id,
      };

      await setDoc(
        doc(collection(this.firestore, "normalized_listings"), id),
        listingDoc
      );

      alert(`"${entry.title}" enviado a la cola de revisión. Puedes completarlo en Revisión.`);
    } catch (e: any) {
      this.manualError.set(e?.message ?? "No se pudo promover el producto");
    } finally {
      this.setManualBusy(entry.id, false);
    }
  }

  isManualBusy(id: string): boolean {
    return Boolean(this.manualBusy()[id]);
  }

  private setManualBusy(id: string, val: boolean): void {
    this.manualBusy.update(m => ({ ...m, [id]: val }));
  }

  productStats(product: NormalizedListingDocV3) {
    return this.productStatsById().get(product.normalized_id) || this.calculateProductStats(product);
  }

  private calculateProductStats(product: NormalizedListingDocV3) {
    const skus = new Set(product.listing.items.map((item) => (item.sku || "").trim().toLowerCase()).filter(Boolean));
    const completed = new Set(["delivered", "delivered_partial", "entregado", "closed", "pagado", "pago_pendiente", "pagado_parcial"]);
    let units = 0;
    let returned = 0;
    let sales = 0;
    let profit = 0;
    let lastSaleMs = 0;
    for (const order of this.orders.list()) {
      if (!completed.has(String(order.status)) && !order.delivered_at) continue;
      for (const item of order.items || []) {
        const sku = (item.sku || "").trim().toLowerCase();
        if (item.product_id !== product.normalized_id && (!sku || !skus.has(sku))) continue;
        const row = calculateItemFinancials(item);
        units += row.netQty;
        returned += row.returnedQty;
        sales += row.netClient;
        profit += row.netClient - row.netCost;
        lastSaleMs = Math.max(lastSaleMs, new Date(order.delivered_at || order.updated_at || order.created_at).getTime() || 0);
      }
    }
    const stock = this.inventory.items().filter((item) => item.product_id === product.normalized_id || skus.has((item.sku || "").trim().toLowerCase()));
    const available = stock.reduce((sum, item) => sum + Number(item.available_qty ?? item.quantity_on_hand ?? 0), 0);
    const min = stock.reduce((sum, item) => sum + Number(item.min_stock || 0), 0);
    const max = stock.reduce((sum, item) => sum + Number(item.max_stock || 0), 0);
    return {
      units,
      returned,
      sales,
      profit,
      returnRate: units + returned > 0 ? returned / (units + returned) : 0,
      available,
      lowStock: min > 0 && available <= min,
      reorder: min > 0 && available <= min && max > available,
      slow: units === 0 || (lastSaleMs > 0 && Date.now() - lastSaleMs > 90 * 86_400_000),
    };
  }

  manualBusinessForActiveTab(): "bm" | "catalogo" {
    return this.activeTab() === "manuales_catalogo" ? "catalogo" : "bm";
  }
}
