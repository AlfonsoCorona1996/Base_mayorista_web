import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { isNormalizedListingDocV3 } from "../../core/firestore-contracts";
import type { ItemPricesV3, NormalizedItemV3, NormalizedListingDocV3, ProductColor, StockState } from "../../core/firestore-contracts";
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
  private priceDraftByKey = signal<Record<string, string>>({});

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
    return this.firstNonEmpty(d.cover_images) || d.preview_image_url || null;
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

  getPriceInputValue(itemIndex: number, item: NormalizedItemV3, field: PriceFieldKey): string {
    const key = this.priceDraftKey(itemIndex, field);
    const draft = this.priceDraftByKey()[key];
    if (draft !== undefined) return draft;

    const value = this.getPriceValue(item, field);
    return value === null ? "" : String(value);
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

  getColorImageUrl(colorName: string | null | undefined): string | null {
    const d = this.doc();
    if (!d || !colorName) return null;

    const target = colorName.trim().toLowerCase();
    if (!target) return null;

    const match = (d.product_colors || []).find((entry) => (entry.name || "").trim().toLowerCase() === target);
    const url = (match?.image_url || "").trim();
    return url || null;
  }

  addCoverImage() {
    const d = this.doc();
    if (!d) return;

    d.cover_images = [...(d.cover_images || []), ""];
    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onCoverImageChange(index: number, rawValue: unknown) {
    const d = this.doc();
    if (!d || index < 0 || index >= (d.cover_images || []).length) return;

    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    d.cover_images[index] = value;

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  removeCoverImage(index: number) {
    const d = this.doc();
    if (!d || index < 0 || index >= (d.cover_images || []).length) return;

    d.cover_images.splice(index, 1);

    const nextCover = this.firstNonEmpty(d.cover_images);
    d.preview_image_url = nextCover;

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  setCoverImageAsPrimary(index: number) {
    const d = this.doc();
    if (!d || index < 0 || index >= (d.cover_images || []).length) return;

    const list = d.cover_images || [];
    const value = (list[index] || "").trim();
    if (!value) return;

    list.splice(index, 1);
    list.unshift(value);
    d.cover_images = list;
    d.preview_image_url = value;

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  addProductColor() {
    const d = this.doc();
    if (!d) return;

    const name = this.generateColorName(d.product_colors || []);
    d.product_colors = [...(d.product_colors || []), { name, image_url: null }];

    d.listing.items.forEach((item) => {
      const exists = (item.color_stock || []).some((entry) => (entry.color_name || "").trim().toLowerCase() === name.toLowerCase());
      if (!exists) {
        item.color_stock = [
          ...(item.color_stock || []),
          {
            color_name: name,
            stock_state: this.normalizeStockState(item.stock_state) || "unknown_qty",
          },
        ];
      }
    });

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  removeProductColor(colorIndex: number) {
    const d = this.doc();
    if (!d || colorIndex < 0 || colorIndex >= (d.product_colors || []).length) return;

    const target = (d.product_colors[colorIndex].name || "").trim().toLowerCase();
    d.product_colors.splice(colorIndex, 1);

    if (target) {
      d.listing.items.forEach((item) => {
        item.color_stock = (item.color_stock || []).filter((entry) => (entry.color_name || "").trim().toLowerCase() !== target);
      });
    }

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onProductColorFieldChange(colorIndex: number, field: "name" | "image_url", rawValue: unknown) {
    const d = this.doc();
    if (!d || colorIndex < 0 || colorIndex >= (d.product_colors || []).length) return;

    const current = d.product_colors[colorIndex];
    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");

    if (field === "image_url") {
      current.image_url = value.trim() || null;
      this.doc.set({ ...d });
      this.saveMessage.set(null);
      return;
    }

    const previousName = (current.name || "").trim();
    const nextName = value.trim();
    current.name = nextName;

    if (previousName && nextName && previousName.toLowerCase() !== nextName.toLowerCase()) {
      d.listing.items.forEach((item) => {
        item.color_stock = (item.color_stock || []).map((entry) => {
          const entryName = (entry.color_name || "").trim();
          if (entryName.toLowerCase() !== previousName.toLowerCase()) return entry;
          return { ...entry, color_name: nextName };
        });
      });
    }

    this.dedupeProductColors(d);

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  addVariantColor(itemIndex: number) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    if (!item) return;

    const used = new Set((item.color_stock || []).map((entry) => (entry.color_name || "").trim().toLowerCase()));
    const candidate = (d.product_colors || []).find((color) => {
      const name = (color.name || "").trim().toLowerCase();
      return name && !used.has(name);
    });

    const fallbackName = candidate?.name?.trim() || this.generateColorName(d.product_colors || []);
    item.color_stock = [
      ...(item.color_stock || []),
      {
        color_name: fallbackName,
        stock_state: this.normalizeStockState(item.stock_state) || "unknown_qty",
      },
    ];

    this.ensureProductColor(d, fallbackName);

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  onColorNameChange(itemIndex: number, colorIndex: number, rawValue: unknown) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    if (!item || !item.color_stock || !item.color_stock[colorIndex]) return;

    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!value) return;

    item.color_stock[colorIndex].color_name = value;
    item.color_stock = this.dedupeColorStock(item.color_stock);
    this.ensureProductColor(d, value);
    this.dedupeProductColors(d);

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  removeVariantColor(itemIndex: number, colorIndex: number) {
    const d = this.doc();
    if (!d) return;

    const item = d.listing.items[itemIndex];
    if (!item || !item.color_stock || colorIndex < 0 || colorIndex >= item.color_stock.length) return;

    item.color_stock.splice(colorIndex, 1);
    this.syncVariantStateFromColors(item);

    this.doc.set({ ...d });
    this.saveMessage.set(null);
  }

  toggleEditMode() {
    const next = !this.editing();
    this.editing.set(next);
    if (!next) {
      this.priceDraftByKey.set({});
    }
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

  onVariantPriceInputChange(itemIndex: number, field: PriceFieldKey, rawValue: unknown) {
    const key = this.priceDraftKey(itemIndex, field);
    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    this.priceDraftByKey.set({
      ...this.priceDraftByKey(),
      [key]: value,
    });
  }

  onVariantPriceInputBlur(itemIndex: number, field: PriceFieldKey) {
    const key = this.priceDraftKey(itemIndex, field);
    const raw = this.priceDraftByKey()[key] ?? "";
    this.onVariantPriceChange(itemIndex, field, raw);

    const nextDrafts = { ...this.priceDraftByKey() };
    delete nextDrafts[key];
    this.priceDraftByKey.set(nextDrafts);
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

    this.normalizeDocumentForSave(d);

    this.saving.set(true);
    this.error.set(null);
    this.saveMessage.set(null);

    try {
      await this.svc.updateListing(this.id, {
        listing: d.listing,
        cover_images: d.cover_images,
        preview_image_url: d.preview_image_url ?? null,
        product_colors: d.product_colors,
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

      clone.cover_images = this.normalizeCoverImages(clone.cover_images, clone.preview_image_url);
      clone.preview_image_url = this.firstNonEmpty(clone.cover_images);
      clone.product_colors = this.normalizeProductColors(clone.product_colors || []);

      clone.listing.items.forEach((item) => {
        this.ensureColorStock(item);
        this.ensurePrices(item, defaultCurrency);
      });

      this.syncProductColorsFromItems(clone);
      this.priceDraftByKey.set({});

      this.doc.set(clone);
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo cargar el producto");
    } finally {
      this.loading.set(false);
    }
  }

  private ensureColorStock(item: NormalizedItemV3) {
    const fallbackState = this.normalizeStockState(item.stock_state) || "unknown_qty";
    item.color_stock = this.dedupeColorStock(item.color_stock || [], fallbackState);
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

  private priceDraftKey(itemIndex: number, field: PriceFieldKey): string {
    return `${itemIndex}:${field}`;
  }

  private firstNonEmpty(values: Array<string | null | undefined> | null | undefined): string | null {
    if (!Array.isArray(values)) return null;

    for (const value of values) {
      const normalized = (value || "").trim();
      if (normalized) return normalized;
    }

    return null;
  }

  private normalizeCoverImages(rawImages: Array<string | null | undefined> | null | undefined, fallbackPreview?: string | null): string[] {
    const list = Array.isArray(rawImages) ? rawImages : [];
    const normalized = list
      .map((entry) => (entry || "").trim())
      .filter(Boolean);

    const deduped = Array.from(new Set(normalized));
    const preview = (fallbackPreview || "").trim();
    if (preview && !deduped.includes(preview)) {
      deduped.unshift(preview);
    }

    return deduped;
  }

  private normalizeProductColors(colors: ProductColor[] | null | undefined): ProductColor[] {
    const map = new Map<string, string | null>();

    (colors || []).forEach((entry) => {
      const name = (entry?.name || "").trim();
      if (!name) return;

      const key = name.toLowerCase();
      const imageUrl = (entry?.image_url || "").trim() || null;
      if (!map.has(key) || (!map.get(key) && imageUrl)) {
        map.set(key, imageUrl);
      }
    });

    return Array.from(map.entries()).map(([key, image_url]) => ({
      name: this.toTitleCase(key),
      image_url,
    }));
  }

  private dedupeColorStock(
    colorStock: Array<{ color_name: string; stock_state: StockState }> | null | undefined,
    fallbackState: StockState = "unknown_qty"
  ): Array<{ color_name: string; stock_state: StockState }> {
    const map = new Map<string, { color_name: string; stock_state: StockState }>();

    (colorStock || []).forEach((entry) => {
      const name = (entry?.color_name || "").trim();
      if (!name) return;

      const key = name.toLowerCase();
      const stockState = this.normalizeStockState(entry?.stock_state) || fallbackState;
      if (!map.has(key)) {
        map.set(key, { color_name: name, stock_state: stockState });
      }
    });

    return Array.from(map.values());
  }

  private ensureProductColor(doc: NormalizedListingDocV3, colorName: string) {
    const name = (colorName || "").trim();
    if (!name) return;

    const exists = (doc.product_colors || []).some((entry) => (entry.name || "").trim().toLowerCase() === name.toLowerCase());
    if (exists) return;

    doc.product_colors = [...(doc.product_colors || []), { name, image_url: null }];
  }

  private dedupeProductColors(doc: NormalizedListingDocV3) {
    doc.product_colors = this.normalizeProductColors(doc.product_colors || []);
  }

  private syncProductColorsFromItems(doc: NormalizedListingDocV3) {
    const current = this.normalizeProductColors(doc.product_colors || []);
    const map = new Map<string, ProductColor>();

    current.forEach((entry) => {
      map.set((entry.name || "").trim().toLowerCase(), entry);
    });

    doc.listing.items.forEach((item) => {
      (item.color_stock || []).forEach((entry) => {
        const name = (entry.color_name || "").trim();
        if (!name) return;

        const key = name.toLowerCase();
        if (!map.has(key)) {
          map.set(key, {
            name,
            image_url: null,
          });
        }
      });
    });

    doc.product_colors = Array.from(map.values());
  }

  private normalizeDocumentForSave(doc: NormalizedListingDocV3) {
    doc.cover_images = this.normalizeCoverImages(doc.cover_images, doc.preview_image_url);
    doc.preview_image_url = this.firstNonEmpty(doc.cover_images);

    doc.listing.items = doc.listing.items.map((item) => {
      const fallbackState = this.normalizeStockState(item.stock_state) || "unknown_qty";
      const color_stock = this.dedupeColorStock(item.color_stock || [], fallbackState);

      return {
        ...item,
        variant_name: (item.variant_name || "").trim() || null,
        sku: (item.sku || "").trim() || null,
        notes: (item.notes || "").trim() || null,
        stock_state: fallbackState,
        color_stock,
        prices: {
          ...item.prices,
          currency: (item.prices?.currency || this.preferredCurrency() || "MXN").trim().toUpperCase() || "MXN",
          precio_costo: this.toValidPrice(item.prices?.precio_costo),
          precio_clienta: this.toValidPrice(item.prices?.precio_clienta),
          precio_final: this.toValidPrice(item.prices?.precio_final),
        },
      };
    });

    this.syncProductColorsFromItems(doc);
    this.dedupeProductColors(doc);

    const validNames = new Set((doc.product_colors || []).map((entry) => (entry.name || "").trim().toLowerCase()));
    doc.listing.items = doc.listing.items.map((item) => ({
      ...item,
      color_stock: (item.color_stock || []).filter((entry) => validNames.has((entry.color_name || "").trim().toLowerCase())),
    }));
  }

  private generateColorName(colors: ProductColor[]): string {
    const used = new Set(
      (colors || [])
        .map((entry) => (entry.name || "").trim().toLowerCase())
        .filter(Boolean),
    );

    let index = 1;
    while (used.has(`color ${index}`)) {
      index += 1;
    }
    return `Color ${index}`;
  }

  private toTitleCase(value: string): string {
    const words = (value || "").split(/\s+/g).filter(Boolean);
    if (words.length === 0) return "";

    return words
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
      .join(" ");
  }

  private isRequiredSchema(doc: unknown): doc is NormalizedListingDocV3 {
    return isNormalizedListingDocV3(doc) && doc.schema_version === this.requiredSchemaVersion;
  }
}
