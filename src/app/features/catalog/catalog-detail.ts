import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { isNormalizedListingDocV3 } from "../../core/firestore-contracts";
import type { ItemPricesV3, NormalizedItemV3, NormalizedListingDocV3, StockState } from "../../core/firestore-contracts";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { SuppliersService } from "../../core/suppliers.service";

type PriceFieldKey = "precio_costo" | "precio_clienta" | "precio_final";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  readonly priceFields: Array<{ key: PriceFieldKey; label: string; icon: string }> = [
    { key: "precio_costo", label: "Costo", icon: "payments" },
    { key: "precio_clienta", label: "Precio clienta", icon: "badge" },
    { key: "precio_final", label: "Precio final", icon: "sell" },
  ];

  id = inject(ActivatedRoute).snapshot.paramMap.get("id") || "";

  loading = signal(false);
  saving = signal(false);
  editing = signal(false);
  error = signal<string | null>(null);
  saveMessage = signal<string | null>(null);

  doc = signal<NormalizedListingDocV3 | null>(null);

  private svc = inject(NormalizedListingsService);
  private suppliers = inject(SuppliersService);
  private router = inject(Router);

  constructor() {
    this.load();
  }

  preferredCurrency = computed(() => {
    const d = this.doc();
    if (!d) return "MXN";

    for (const item of d.listing.items) {
      const currency = (item.prices?.currency || "").trim().toUpperCase();
      if (currency) return currency;
    }

    return "MXN";
  });

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

  priceOverview = computed(() => {
    const d = this.doc();
    if (!d) return [];

    const currency = this.preferredCurrency();
    return this.priceFields.map((field) => {
      const values = d.listing.items
        .map((item) => this.toValidPrice(item.prices?.[field.key]))
        .filter((value): value is number => value !== null);

      if (values.length === 0) {
        return {
          ...field,
          hasData: false,
          valueLabel: "Sin dato",
          helperLabel: "Captura precios para esta metrica.",
        };
      }

      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((acc, value) => acc + value, 0) / values.length;

      const valueLabel = min === max ? this.formatMoney(min, currency) : `${this.formatMoney(min, currency)} - ${this.formatMoney(max, currency)}`;

      return {
        ...field,
        hasData: true,
        valueLabel,
        helperLabel: `Promedio ${this.formatMoney(avg, currency)} en ${values.length} variante${values.length !== 1 ? "s" : ""}.`,
      };
    });
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

  formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Sin dato";

    const safeCurrency = (currency || this.preferredCurrency() || "MXN").trim().toUpperCase() || "MXN";

    try {
      return new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: safeCurrency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return `$${value.toFixed(2)}`;
    }
  }

  getPriceValue(item: NormalizedItemV3, field: PriceFieldKey): number | null {
    return this.toValidPrice(item.prices?.[field]);
  }

  priceIssue(item: NormalizedItemV3): string | null {
    const cost = this.toValidPrice(item.prices?.precio_costo);
    const client = this.toValidPrice(item.prices?.precio_clienta);
    const final = this.toValidPrice(item.prices?.precio_final);

    if (cost === null || client === null || final === null) {
      return "Faltan precios por capturar en esta variante.";
    }

    if (client < cost) {
      return "Precio clienta menor que costo. Revisa margen.";
    }

    if (final < client) {
      return "Precio final menor que precio clienta.";
    }

    return null;
  }

  toggleEditMode() {
    this.editing.update((current) => !current);
  }

  onListingFieldChange(field: "title" | "category_hint", rawValue: unknown) {
    const d = this.doc();
    if (!d) return;

    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");

    if (field === "title") {
      d.listing.title = value;
    } else {
      d.listing.category_hint = value;
    }

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onVariantFieldChange(itemIndex: number, field: "variant_name" | "sku" | "notes", rawValue: unknown) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    if (!item) return;

    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    item[field] = value.trim() ? value : null;

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onVariantPriceChange(itemIndex: number, field: PriceFieldKey, rawValue: unknown) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    if (!item) return;

    const fallbackCurrency = this.preferredCurrency();
    this.ensurePrices(item, fallbackCurrency);
    item.prices[field] = this.parsePriceInput(rawValue);

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onVariantStateChange(itemIndex: number, nextState: StockState) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    item.stock_state = nextState;

    if (item.color_stock && item.color_stock.length > 0) {
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
      this.saveMessage.set("Cambios del producto guardados correctamente.");
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo guardar el producto");
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
      const defaultCurrency = this.resolveDefaultCurrency(clone);

      clone.listing.items.forEach((item) => {
        this.ensureColorStock(item);
        this.ensurePrices(item, defaultCurrency);
      });

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

  private ensurePrices(item: NormalizedItemV3, fallbackCurrency: string) {
    const source = item.prices as ItemPricesV3 | undefined;
    const currency = (source?.currency || fallbackCurrency || "MXN").trim().toUpperCase() || "MXN";

    item.prices = {
      precio_costo: this.toValidPrice(source?.precio_costo),
      precio_clienta: this.toValidPrice(source?.precio_clienta),
      precio_final: this.toValidPrice(source?.precio_final),
      currency,
    };
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

  private resolveDefaultCurrency(doc: NormalizedListingDocV3): string {
    for (const item of doc.listing.items) {
      const currency = (item.prices?.currency || "").trim().toUpperCase();
      if (currency) return currency;
    }

    return "MXN";
  }

  private toValidPrice(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, Math.round(value * 100) / 100);
  }

  private parsePriceInput(rawValue: unknown): number | null {
    if (rawValue === null || rawValue === undefined || rawValue === "") {
      return null;
    }

    if (typeof rawValue === "number") {
      return this.toValidPrice(rawValue);
    }

    if (typeof rawValue === "string") {
      const cleaned = rawValue.replace(",", ".").trim();
      if (!cleaned) return null;
      return this.toValidPrice(Number(cleaned));
    }

    return null;
  }

  private isRequiredSchema(doc: unknown): doc is NormalizedListingDocV3 {
    return isNormalizedListingDocV3(doc) && doc.schema_version === this.requiredSchemaVersion;
  }
}
