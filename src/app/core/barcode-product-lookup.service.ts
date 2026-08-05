import { Injectable, inject } from "@angular/core";
import {
  CatalogProduct,
  CatalogProductGroup,
  CatalogProductIdentifier,
  CatalogProductsService,
} from "./catalog-products.service";
import { InventoryItem, InventoryService } from "./inventory.service";
import { NormalizedListingDoc, NormalizedListingsService } from "./normalized-listings.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

export type BarcodeProductMatch =
  | {
      kind: "catalog_product";
      code: string;
      label: string;
      business_id: BusinessId;
      product: CatalogProduct;
      group: CatalogProductGroup | null;
      matched_identifier: CatalogProductIdentifier | null;
      selection_required: boolean;
    }
  | {
      kind: "inventory";
      code: string;
      label: string;
      business_id: BusinessId;
      item: InventoryItem;
      selection_required: false;
    }
  | {
      kind: "normalized_listing";
      code: string;
      label: string;
      business_id: BusinessId;
      doc: NormalizedListingDoc;
      variant: Record<string, unknown>;
      color: string;
      selection_required: false;
    };

@Injectable({ providedIn: "root" })
export class BarcodeProductLookupService {
  private catalogProducts = inject(CatalogProductsService);
  private inventory = inject(InventoryService);
  private normalizedListings = inject(NormalizedListingsService);

  async findMatches(code: string, businessId: BusinessId): Promise<BarcodeProductMatch[]> {
    const cleanCode = this.cleanCode(code);
    if (!cleanCode) return [];
    const resolvedBusinessId = normalizeBusinessId(businessId);
    const matches: BarcodeProductMatch[] = [];

    if (resolvedBusinessId === "catalogo") {
      const searchResults = await this.catalogProducts.searchCatalog(cleanCode, {
        businessId: "catalogo",
        types: ["barcode", "ocr_alias"],
        limit: 25,
        exact: true,
      }).catch(() => []);
      const requiresSelection = searchResults.length > 1 || searchResults.some((result) => result.requires_selection);
      for (const result of searchResults) {
        for (const product of result.variants) {
          const codeLabel = product.primary_barcode || product.sku || product.supplier_sku || cleanCode;
          matches.push({
            kind: "catalog_product",
            code: cleanCode,
            label: `${product.name} · ${codeLabel}`,
            business_id: "catalogo",
            product,
            group: result.group,
            matched_identifier: result.matched_identifier,
            selection_required: requiresSelection || result.requires_selection,
          });
        }
      }
    } else {
      const inventoryMatch = await this.inventory.getBySku(cleanCode, resolvedBusinessId).catch(() => null);
      if (inventoryMatch) {
        matches.push({
          kind: "inventory",
          code: cleanCode,
          label: `${inventoryMatch.title} · Inventario`,
          business_id: resolvedBusinessId,
          item: inventoryMatch,
          selection_required: false,
        });
      }
      const docs = await this.normalizedListings.findValidatedByVariantSku(cleanCode, "bm", 8).catch(() => []);
      for (const doc of docs) {
        for (const variant of this.matchingVariants(doc, cleanCode)) {
          matches.push({
            kind: "normalized_listing",
            code: cleanCode,
            label: `${doc.listing?.title || "Producto BM"} · ${String(variant["variant_name"] || cleanCode)}`,
            business_id: "bm",
            doc,
            variant,
            color: this.firstVariantColor(variant),
            selection_required: false,
          });
        }
      }
    }

    return this.dedupe(matches);
  }

  cleanCode(value: unknown): string {
    return String(value || "").trim();
  }

  normalizeCode(value: unknown): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  private matchingVariants(doc: NormalizedListingDoc, code: string): Array<Record<string, unknown>> {
    const normalized = this.normalizeCode(code);
    const items = Array.isArray(doc.listing?.items) ? doc.listing.items : [];
    return (items as unknown as Array<Record<string, unknown>>).filter((item) => this.normalizeCode(item["sku"]) === normalized);
  }

  private firstVariantColor(variant: Record<string, unknown>): string {
    const colorStock = Array.isArray(variant["color_stock"]) ? variant["color_stock"] as Array<Record<string, unknown>> : [];
    const firstStockColor = String(colorStock[0]?.["color_name"] || "").trim();
    if (firstStockColor) return firstStockColor;

    const colorNames = Array.isArray(variant["color_names"]) ? variant["color_names"] as unknown[] : [];
    const firstColorName = String(colorNames[0] || "").trim();
    if (firstColorName) return firstColorName;

    const legacyColors = Array.isArray(variant["colors"]) ? variant["colors"] as unknown[] : [];
    return String(legacyColors[0] || variant["color"] || "").trim();
  }

  private dedupe(matches: BarcodeProductMatch[]): BarcodeProductMatch[] {
    const seen = new Set<string>();
    return matches.filter((match) => {
      const key = match.kind === "inventory"
        ? `${match.kind}:${match.item.inventory_id}`
        : match.kind === "catalog_product"
          ? `${match.kind}:${match.product.product_id}`
          : `${match.kind}:${match.doc.normalized_id}:${this.normalizeCode(match.variant["sku"])}:${match.color}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
