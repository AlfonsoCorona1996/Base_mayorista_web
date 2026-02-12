import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
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
  selector: "app-catalog-detail",
  imports: [FormsModule],
  templateUrl: "./catalog-detail.html",
  styleUrl: "./catalog-detail.css",
})
export default class CatalogDetailPage {
  private readonly requiredSchemaVersion = "normalized_v3.0";
  readonly stockStates: Array<{ value: StockState; label: string }> = [
    { value: "in_stock", label: "Disponible" },
    { value: "last_pair", label: "Ultima pieza" },
    { value: "out_of_stock", label: "Agotado" },
    { value: "unknown_qty", label: "Sin confirmar" },
  ];

  id = inject(ActivatedRoute).snapshot.paramMap.get("id") || "";

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  saveMessage = signal<string | null>(null);

  doc = signal<NormalizedListingDocV3 | null>(null);

  private svc = inject(NormalizedListingsService);
  private suppliers = inject(SuppliersService);
  private router = inject(Router);

  constructor() {
    this.load();
  }

  coverUrl = computed(() => {
    const d = this.doc();
    if (!d) return null;
    return d.cover_images?.[0] || d.preview_image_url || null;
  });

  productStockState = computed(() => {
    const d = this.doc();
    if (!d || d.listing.items.length === 0) return "unknown_qty" as StockState;

    const states = d.listing.items.flatMap((item) => {
      const colorStates = (item.color_stock || []).map((entry) => this.normalizeStockState(entry.stock_state));
      return [this.normalizeStockState(item.stock_state), ...colorStates].filter((state): state is StockState => Boolean(state));
    });

    if (states.length === 0) return "unknown_qty";
    if (states.every((state) => state === "out_of_stock")) return "out_of_stock";
    if (states.some((state) => state === "in_stock")) return "in_stock";
    if (states.some((state) => state === "last_pair")) return "last_pair";
    return "unknown_qty";
  });

  supplierName = computed(() => {
    const supplierId = this.doc()?.supplier_id;
    if (!supplierId) return "Sin proveedor";
    return this.suppliers.getById(supplierId)?.display_name || supplierId;
  });

  stockLabel(state: StockState): string {
    const match = this.stockStates.find((option) => option.value === state);
    return match?.label || "Sin confirmar";
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

  variantLabel(item: NormalizedItemV3, index: number): string {
    const name = (item.variant_name || "").trim();
    return name || `Variante ${index + 1}`;
  }

  getVariantColors(item: NormalizedItemV3): string[] {
    const names = (item.color_stock || [])
      .map((entry) => entry.color_name)
      .map((name) => (name || "").trim())
      .filter(Boolean);

    return Array.from(new Set(names));
  }

  onVariantStateChange(itemIndex: number, nextState: StockState) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    item.stock_state = nextState;

    if (item.color_stock && item.color_stock.length > 0) {
      // Mantener consistencia: si cambia el estado de la variante,
      // los colores heredan ese mismo estado.
      item.color_stock = item.color_stock.map((entry) => ({ ...entry, stock_state: nextState }));
    }

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onColorStateChange(itemIndex: number, colorIndex: number, nextState: StockState) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    if (!item.color_stock || !item.color_stock[colorIndex]) return;

    item.color_stock[colorIndex].stock_state = nextState;
    this.syncVariantStateFromColors(item);

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  setVariantOutOfStock(itemIndex: number) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    item.stock_state = "out_of_stock";
    if (item.color_stock && item.color_stock.length > 0) {
      item.color_stock = item.color_stock.map((entry) => ({ ...entry, stock_state: "out_of_stock" }));
    }

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  markAllOutOfStock() {
    const d = this.doc();
    if (!d) return;

    d.listing.items = d.listing.items.map((item) => {
      const next: NormalizedItemV3 = {
        ...item,
        stock_state: "out_of_stock",
      };

      if (next.color_stock && next.color_stock.length > 0) {
        next.color_stock = next.color_stock.map((entry) => ({ ...entry, stock_state: "out_of_stock" }));
      }

      return next;
    });

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  markAllInStock() {
    const d = this.doc();
    if (!d) return;

    d.listing.items = d.listing.items.map((item) => {
      const next: NormalizedItemV3 = {
        ...item,
        stock_state: "in_stock",
      };

      if (next.color_stock && next.color_stock.length > 0) {
        next.color_stock = next.color_stock.map((entry) => ({ ...entry, stock_state: "in_stock" }));
      }

      return next;
    });

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  async saveInventory() {
    const d = this.doc();
    if (!d) return;

    this.saving.set(true);
    this.error.set(null);
    this.saveMessage.set(null);

    try {
      await this.svc.updateListing(this.id, {
        listing: d.listing,
      });
      this.saveMessage.set("Inventario actualizado correctamente.");
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo guardar el inventario");
    } finally {
      this.saving.set(false);
    }
  }

  goCatalog() {
    this.router.navigateByUrl("/main/catalogo");
  }

  private async load() {
    this.loading.set(true);
    this.error.set(null);

    try {
      const loaded = await this.svc.getById(this.id);
      if (!this.isRequiredSchema(loaded)) {
        throw new Error(`Esquema no soportado. Se requiere ${this.requiredSchemaVersion}.`);
      }

      const clone = structuredClone(loaded) as NormalizedListingDocV3;
      clone.listing.items.forEach((item) => this.ensureColorStock(item));
      this.doc.set(clone);
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo cargar el producto");
    } finally {
      this.loading.set(false);
    }
  }

  private ensureColorStock(item: NormalizedItemV3) {
    const colors = this.getVariantColors(item);
    const fallbackState = this.normalizeStockState(item.stock_state) || "unknown_qty";
    const map = new Map<string, StockState>();

    (item.color_stock || []).forEach((entry) => {
      const name = (entry.color_name || "").trim();
      if (!name) return;
      map.set(name, this.normalizeStockState(entry.stock_state) || fallbackState);
    });

    colors.forEach((color) => {
      if (!map.has(color)) {
        map.set(color, fallbackState);
      }
    });

    item.color_stock = Array.from(map.entries()).map(([color_name, stock_state]) => ({ color_name, stock_state }));
  }

  private syncVariantStateFromColors(item: NormalizedItemV3) {
    const states = (item.color_stock || [])
      .map((entry) => this.normalizeStockState(entry.stock_state))
      .filter((state): state is StockState => Boolean(state));

    if (states.length === 0) return;
    if (states.every((state) => state === "out_of_stock")) {
      item.stock_state = "out_of_stock";
      return;
    }
    if (states.some((state) => state === "in_stock")) {
      item.stock_state = "in_stock";
      return;
    }
    if (states.some((state) => state === "last_pair")) {
      item.stock_state = "last_pair";
      return;
    }
    item.stock_state = "unknown_qty";
  }

  private normalizeStockState(value: unknown): StockState | null {
    if (typeof value !== "string") return null;
    const valid: StockState[] = ["in_stock", "last_pair", "out_of_stock", "unknown_qty"];
    return valid.includes(value as StockState) ? (value as StockState) : null;
  }

  private isRequiredSchema(doc: unknown): doc is NormalizedListingDocV3 {
    return isNormalizedListingDocV3(doc) && doc.schema_version === this.requiredSchemaVersion;
  }
}
