import { Injectable } from "@angular/core";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { CatalogProduct } from "./catalog-products.service";

export interface CatalogBarcodeAlias {
  alias_id: string;
  business_id: BusinessId;
  barcode: string;
  barcode_normalized: string;
  product_id: string;
  sku: string;
  sku_normalized: string;
  product_name: string;
  source: "ocr_fallback" | "manual";
  created_at?: unknown;
  updated_at?: unknown;
}

@Injectable({ providedIn: "root" })
export class CatalogBarcodeAliasService {
  private readonly collectionPath = "catalog_barcode_aliases";

  async getByBarcode(barcode: string, businessId: BusinessId = "catalogo"): Promise<CatalogBarcodeAlias | null> {
    const resolvedBusinessId = normalizeBusinessId(businessId);
    const normalized = this.normalizeBarcode(barcode);
    if (!normalized) return null;

    const snap = await getDoc(doc(FIRESTORE, this.collectionPath, this.aliasDocId(resolvedBusinessId, normalized)));
    if (!snap.exists()) return null;
    return this.normalizeAlias(snap.id, snap.data() as Record<string, unknown>);
  }

  async saveOcrAlias(barcode: string, product: CatalogProduct): Promise<CatalogBarcodeAlias | null> {
    const businessId = normalizeBusinessId(product.business_id || "catalogo");
    if (businessId !== "catalogo") return null;

    const barcodeNormalized = this.normalizeBarcode(barcode);
    const skuNormalized = this.normalizeBarcode(product.sku);
    if (!barcodeNormalized || !skuNormalized || barcodeNormalized === skuNormalized) return null;

    const aliasId = this.aliasDocId(businessId, barcodeNormalized);
    const ref = doc(FIRESTORE, this.collectionPath, aliasId);
    const existing = await getDoc(ref);
    const payload: Record<string, unknown> = {
      alias_id: aliasId,
      business_id: businessId,
      barcode: String(barcode || "").trim(),
      barcode_normalized: barcodeNormalized,
      product_id: product.product_id,
      sku: product.sku,
      sku_normalized: skuNormalized,
      product_name: product.name || product.sku,
      source: "ocr_fallback",
      updated_at: serverTimestamp(),
    };
    if (!existing.exists()) payload["created_at"] = serverTimestamp();

    await setDoc(ref, payload, { merge: true });
    return this.normalizeAlias(aliasId, payload);
  }

  normalizeBarcode(value: unknown): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  private aliasDocId(businessId: BusinessId, normalizedBarcode: string): string {
    const encoded = encodeURIComponent(normalizedBarcode).replace(/\./g, "%2E");
    const safe = encoded.length <= 900 ? encoded : this.hashCode(normalizedBarcode);
    return `${businessId}_${safe}`;
  }

  private normalizeAlias(id: string, data: Record<string, unknown>): CatalogBarcodeAlias {
    return {
      alias_id: String(data["alias_id"] || id),
      business_id: normalizeBusinessId(data["business_id"] || "catalogo"),
      barcode: String(data["barcode"] || ""),
      barcode_normalized: this.normalizeBarcode(data["barcode_normalized"] || data["barcode"] || ""),
      product_id: String(data["product_id"] || ""),
      sku: String(data["sku"] || ""),
      sku_normalized: this.normalizeBarcode(data["sku_normalized"] || data["sku"] || ""),
      product_name: String(data["product_name"] || data["sku"] || "Producto sin nombre"),
      source: data["source"] === "manual" ? "manual" : "ocr_fallback",
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private hashCode(value: string): string {
    let hash = 0;
    for (let idx = 0; idx < value.length; idx += 1) {
      hash = (hash * 31 + value.charCodeAt(idx)) >>> 0;
    }
    return `barcode_${hash.toString(36)}`;
  }
}
