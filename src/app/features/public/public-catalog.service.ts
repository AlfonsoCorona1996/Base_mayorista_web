import { Injectable, inject } from "@angular/core";
import type { ProductColor } from "../../core/firestore-contracts";
import { NormalizedListingsService } from "../../core/normalized-listings.service";

export interface PublicProduct {
  id: string;
  name: string;
  category: string;
  subtitle: string;
  reference: string | null;
  imageUrl: string | null;
}

export interface PublicProductSection {
  id: string;
  title: string;
  items: PublicProduct[];
}

export interface PublicLandingCatalog {
  featuredProducts: PublicProduct[];
  sections: PublicProductSection[];
  heroImages: string[];
}

interface ListingItemLike {
  variant_name?: string | null;
  sku?: string | null;
  image_url?: string | null;
  image_urls?: string[] | null;
  color_names?: string[] | null;
  colors?: string[] | null;
  color_stock?: Array<{ color_name?: string | null }> | null;
}

interface ListingLike {
  title?: string | null;
  category_hint?: string | null;
  items?: ListingItemLike[] | null;
}

interface ListingDocLike {
  normalized_id?: string | null;
  listing?: ListingLike | null;
  cover_images?: string[] | null;
  product_colors?: ProductColor[] | null;
  preview_image_url?: string | null;
  updated_at?: unknown;
  created_at?: unknown;
}

interface InternalPublicProduct extends PublicProduct {
  sortScore: number;
}

@Injectable({ providedIn: "root" })
export class PublicCatalogService {
  private readonly listings = inject(NormalizedListingsService);
  private readonly forcedImageReplacements: Array<{ match: string; replaceWith: string }> = [
    {
      match: "d5358df2-7465-4849-8eae-8efd6959c9b0",
      replaceWith:
        "https://firebasestorage.googleapis.com/v0/b/base-mayorista.firebasestorage.app/o/raw%2Ffbcea846-2a36-4db6-b0e3-1e60e7c1480c%2F2774437469559424.jpg?alt=media&token=5a6ad3f4-7723-4681-979a-738da5d4116e",
    },
  ];
  private readonly blockedImageTokens = [
    "precio",
    "precios",
    "price",
    "prices",
    "talla",
    "tallas",
    "size",
    "sizes",
    "medida",
    "medidas",
    "cm",
    "cms",
    "numeracion",
    "numero",
    "num",
    "%23",
    "#",
    "%24",
    "$",
    "mxn",
    "usd",
    "dlls",
    "oferta",
    "promo",
    "promocion",
  ];
  private readonly blockedHeroTokens = [
    "tenis",
    "zapato",
    "zapatos",
    "calzado",
    "apple watch",
    "correa",
    "calceta",
    "calcetin",
    "media",
    "sock",
    "pantufla",
    "pantuflas",
    "slipper",
    "slippers",
  ];
  private readonly blockedHeroImageTokens = ["3-2", "6-1", "polo", "pantufla", "slipper"];

  async loadLandingCatalog(pageSize = 24): Promise<PublicLandingCatalog> {
    const safePageSize = Math.max(8, Math.min(80, Math.floor(pageSize)));
    const { docs } = await this.listings.listValidated(safePageSize);

    const mapped = docs
      .map((doc, index) => this.toPublicProduct(doc as ListingDocLike, index))
      .sort((a, b) => b.sortScore - a.sortScore);

    const featured = mapped.slice(0, 16).map((entry) => this.stripSortScore(entry));
    const sections = this.buildSections(featured);
    const heroImages = this.pickHeroImages(featured);

    return {
      featuredProducts: featured,
      sections,
      heroImages,
    };
  }

  private toPublicProduct(doc: ListingDocLike, index: number): InternalPublicProduct {
    const title = this.clean(doc.listing?.title) || "Producto destacado";
    const category = this.formatCategory(doc.listing?.category_hint);
    const items = this.listingItems(doc);
    const colorNames = this.extractColorNames(doc);
    const variantsCount = items.length;
    const colorCount = colorNames.length;
    const details: string[] = [];

    if (variantsCount > 0) {
      details.push(`${variantsCount} variante${variantsCount === 1 ? "" : "s"}`);
    }
    if (colorCount > 0) {
      details.push(`${colorCount} color${colorCount === 1 ? "" : "es"}`);
    }

    return {
      id: this.clean(doc.normalized_id) || `public-${index + 1}`,
      name: title,
      category,
      subtitle: details.join(" | ") || "Disponible para compra al mayoreo",
      reference: this.firstSku(items),
      imageUrl: this.pickImage(doc, items),
      sortScore: this.timestampToMs(doc.updated_at) || this.timestampToMs(doc.created_at) || 0,
    };
  }

  private buildSections(products: PublicProduct[]): PublicProductSection[] {
    if (products.length === 0) return [];

    const grouped = new Map<string, PublicProductSection>();

    for (const product of products) {
      const title = this.clean(product.category) || "Destacados";
      const sectionId = this.slugify(title) || "destacados";
      const existing = grouped.get(sectionId);

      if (!existing) {
        grouped.set(sectionId, {
          id: sectionId,
          title,
          items: [product],
        });
        continue;
      }

      if (existing.items.length < 8) {
        existing.items.push(product);
      }
    }

    const sections = Array.from(grouped.values()).sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    });

    if (sections.length <= 1) {
      return [
        {
          id: "productos-destacados",
          title: "Productos destacados",
          items: products.slice(0, 12),
        },
      ];
    }

    return sections.slice(0, 4);
  }

  private pickHeroImages(products: PublicProduct[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const product of products) {
      if (this.isHeroImageBlockedByProduct(product)) continue;
      const image = this.clean(product.imageUrl);
      if (this.isHeroImageBlockedByUrl(image)) continue;
      if (!image || seen.has(image)) continue;
      seen.add(image);
      out.push(image);
      if (out.length === 3) break;
    }

    return out;
  }

  private pickImage(doc: ListingDocLike, items: ListingItemLike[]): string | null {
    const isAppleWatchLike = this.isAppleWatchCategory(doc.listing?.category_hint);

    for (const item of items) {
      const direct = this.cleanImageUrl(item.image_url);
      if (direct) return direct;
      const fromArray = this.firstValidUrl(item.image_urls || []);
      if (fromArray) return fromArray;
    }

    const globalColorImage = this.firstValidUrl(
      (doc.product_colors || []).map((entry) => this.clean(entry.image_url)),
    );
    if (globalColorImage) return globalColorImage;

    // En Apple Watch evitamos portada/promocional para no mostrar artes con precio.
    if (!isAppleWatchLike) {
      const cover = this.firstValidUrl(doc.cover_images || []);
      if (cover) return cover;

      const preview = this.cleanImageUrl(doc.preview_image_url);
      if (preview) return preview;
    }

    return null;
  }

  private extractColorNames(doc: ListingDocLike): string[] {
    const fromGlobal = (doc.product_colors || [])
      .map((entry) => this.clean(entry.name))
      .filter((name) => name.length > 0);

    if (fromGlobal.length > 0) {
      return this.unique(fromGlobal);
    }

    const colors: string[] = [];
    for (const item of this.listingItems(doc)) {
      for (const color of item.color_names || []) {
        const value = this.clean(color);
        if (value) colors.push(value);
      }
      for (const color of item.colors || []) {
        const value = this.clean(color);
        if (value) colors.push(value);
      }
      for (const color of item.color_stock || []) {
        const value = this.clean(color?.color_name);
        if (value) colors.push(value);
      }
    }

    return this.unique(colors);
  }

  private listingItems(doc: ListingDocLike): ListingItemLike[] {
    const items = doc.listing?.items;
    if (!Array.isArray(items)) return [];
    return items.filter((entry) => Boolean(entry));
  }

  private firstSku(items: ListingItemLike[]): string | null {
    for (const item of items) {
      const sku = this.clean(item.sku);
      if (sku) return sku;
    }
    return null;
  }

  private stripSortScore(entry: InternalPublicProduct): PublicProduct {
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      subtitle: entry.subtitle,
      reference: entry.reference,
      imageUrl: entry.imageUrl,
    };
  }

  private firstValidUrl(values: Array<string | null | undefined>): string | null {
    for (const candidate of values) {
      const value = this.cleanImageUrl(candidate);
      if (value) return value;
    }
    return null;
  }

  private unique(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const raw of values) {
      const value = this.clean(raw);
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }

    return out;
  }

  private clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private cleanImageUrl(value: unknown): string {
    const rawUrl = this.clean(value);
    const replaced = this.applyForcedReplacement(rawUrl);
    const url = this.toBrowserUrl(replaced);
    if (!url) return "";
    return this.isImageAllowed(url) ? url : "";
  }

  private applyForcedReplacement(url: string): string {
    if (!url) return "";
    const hit = this.forcedImageReplacements.find((entry) => url.includes(entry.match));
    return hit ? hit.replaceWith : url;
  }

  private toBrowserUrl(url: string): string {
    if (!url) return "";
    if (!url.startsWith("gs://")) return url;

    const gsPath = url.slice("gs://".length);
    const firstSlash = gsPath.indexOf("/");
    if (firstSlash <= 0) return "";

    const bucket = gsPath.slice(0, firstSlash);
    const objectPath = gsPath.slice(firstSlash + 1);
    const encodedObject = encodeURIComponent(objectPath);
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedObject}?alt=media`;
  }

  private formatCategory(raw: unknown): string {
    const original = this.clean(raw);
    if (!original) return "Novedades";

    const parts = original
      .split(">")
      .map((entry) => this.clean(entry))
      .filter((entry) => entry.length > 0);
    const leaf = (parts[parts.length - 1] || original).toLowerCase();

    const map: Record<string, string> = {
      pantalon: "Pantalones",
      pantalones: "Pantalones",
      short: "Shorts",
      shorts: "Shorts",
      blusa: "Blusas",
      blusas: "Blusas",
      playera: "Playeras",
      playeras: "Playeras",
      vestido: "Vestidos",
      vestidos: "Vestidos",
      falda: "Faldas",
      faldas: "Faldas",
      zapato: "Zapatos",
      zapatos: "Zapatos",
      tenis: "Tenis",
      sandalia: "Sandalias",
      sandalias: "Sandalias",
      correa: "Correas",
      correas: "Correas",
      bolsa: "Bolsas",
      bolsas: "Bolsas",
      accesorios: "Accesorios",
      tecnologia: "Tecnología",
    };

    if (map[leaf]) return map[leaf];
    return this.toTitleCase(parts[parts.length - 1] || original);
  }

  private isImageAllowed(url: string): boolean {
    const normalized = url.toLowerCase();
    return !this.blockedImageTokens.some((token) => this.hasBlockedToken(normalized, token));
  }

  private isHeroImageBlockedByProduct(product: PublicProduct): boolean {
    const blob = `${this.clean(product.name)} ${this.clean(product.category)}`.toLowerCase();
    return this.blockedHeroTokens.some((token) => blob.includes(token));
  }

  private isHeroImageBlockedByUrl(imageUrl: string): boolean {
    const normalized = this.clean(imageUrl).toLowerCase();
    if (!normalized) return false;
    return this.blockedHeroImageTokens.some((token) => normalized.includes(token));
  }

  private isAppleWatchCategory(categoryHint: unknown): boolean {
    const category = this.clean(categoryHint).toLowerCase();
    return category.includes("apple watch");
  }

  private hasBlockedToken(value: string, token: string): boolean {
    if (!value.includes(token)) return false;

    // Tokens cortos como "cm" o "num" se validan con bordes para evitar falsos positivos.
    if (token.length <= 2) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const compactMatch = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
      return compactMatch.test(value);
    }

    return true;
  }

  private timestampToMs(value: unknown): number {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;

    if (typeof value === "object" && value !== null) {
      const withToDate = value as { toDate?: () => Date };
      if (typeof withToDate.toDate === "function") {
        return withToDate.toDate().getTime();
      }
    }

    return 0;
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

  private toTitleCase(value: string): string {
    return value
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => entry.charAt(0).toUpperCase() + entry.slice(1))
      .join(" ");
  }
}
