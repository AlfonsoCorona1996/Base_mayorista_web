import { Injectable, computed, inject, signal } from "@angular/core";
import { lastValueFrom } from "rxjs";
import {
  DocumentData,
  QueryDocumentSnapshot,
  QueryConstraint,
  Unsubscribe,
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  where,
  writeBatch,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { UserAdminApiService } from "../services/user-admin-api.service";

export type CatalogProductImageStatus = "PENDING" | "FETCHED" | "NOT_FOUND" | "NO_IMAGE" | "ERROR";

export interface CatalogProduct {
  product_id: string;
  catalog_product_id: string;
  business_id: BusinessId;
  sku: string;
  sku_normalized: string;
  name: string;
  brand_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  category: string | null;
  color: string | null;
  size: string | null;
  price_cost_excel: number | null;
  price_cost_discount_pct: number | null;
  price_cost: number | null;
  price_clienta_markup_pct: number | null;
  price_clienta: number | null;
  stock_qty: number | null;
  impuls_product_id: string | null;
  image_status: CatalogProductImageStatus | null;
  image_url: string | null;
  image_storage_path: string | null;
  image_provider: string | null;
  impuls_image_source_url: string | null;
  impuls_image_fetched_at?: unknown;
  impuls_image_error: string | null;
  notes: string | null;
  original_row?: Record<string, unknown>;
  last_import_id?: string | null;
  last_imported_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface CatalogProductImportRow {
  sku: string;
  name: string;
  brand_name?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  category?: string | null;
  color?: string | null;
  size?: string | null;
  price_cost_excel?: number | null;
  price_cost_discount_pct?: number | null;
  price_cost?: number | null;
  price_clienta_markup_pct?: number | null;
  price_clienta?: number | null;
  impuls_product_id?: string | null;
  stock_qty?: number | null;
  image_url?: string | null;
  notes?: string | null;
  original_row?: Record<string, unknown>;
}

export interface CatalogProductImportResult {
  importId: string;
  processed: number;
  batches: number;
}

export interface CatalogProductsPageState {
  rows: CatalogProduct[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

export interface ResolveImpulsImageResult {
  ok?: boolean;
  found?: boolean;
  reason?: string | null;
  images?: string[];
  image_url?: string | null;
  image_storage_path?: string | null;
  image_status?: CatalogProductImageStatus | string | null;
}

@Injectable({ providedIn: "root" })
export class CatalogProductsService {
  private colRef = collection(FIRESTORE, "catalog_products");
  private businessScope = inject(BusinessScopeService);
  private api = inject(UserAdminApiService);
  private rows = signal<CatalogProduct[]>([]);
  private pageRows = signal<CatalogProduct[]>([]);
  private pageCursor: QueryDocumentSnapshot<DocumentData> | null = null;
  private unsubscribePage: Unsubscribe | null = null;
  private activePageKey = "";

  readonly pageState = signal<CatalogProductsPageState>({
    rows: [],
    loading: false,
    error: null,
    hasMore: false,
  });

  products = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rows().filter((row) => active.includes(row.business_id || "bm"));
  });

  catalogoProducts = computed(() =>
    this.businessScope.canAccessBusiness("catalogo")
      ? this.rows().filter((row) => row.business_id === "catalogo")
      : [],
  );

  catalogoPageProducts = computed(() =>
    this.businessScope.canAccessBusiness("catalogo") ? this.pageRows() : [],
  );

  async loadFromFirestore(): Promise<void> {
    const snap = await getDocs(query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalizeProduct(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
    this.rows.set(rows);
  }

  async importRows(rows: CatalogProductImportRow[], businessId: BusinessId = "catalogo"): Promise<CatalogProductImportResult> {
    const cleanRows = rows.filter((row) => row.sku.trim());
    const importId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const resolvedBusinessId = normalizeBusinessId(businessId);
    let batch = writeBatch(FIRESTORE);
    let ops = 0;
    let batches = 0;

    for (const row of cleanRows) {
      const sku = row.sku.trim();
      const productId = this.productDocId(resolvedBusinessId, sku);
      const ref = doc(this.colRef, productId);
      batch.set(
        ref,
        {
          product_id: productId,
          catalog_product_id: productId,
          business_id: resolvedBusinessId,
          sku,
          sku_normalized: this.normalizeSku(sku),
          name: row.name.trim() || sku,
          brand_name: this.nullableText(row.brand_name),
          supplier_id: this.nullableText(row.supplier_id),
          supplier_name: this.nullableText(row.supplier_name),
          category: this.nullableText(row.category),
          color: this.nullableText(row.color),
          size: this.nullableText(row.size),
          impuls_product_id: this.nullableText(row.impuls_product_id),
          price_cost_excel: this.nullableNumber(row.price_cost_excel),
          price_cost_discount_pct: this.nullablePercent(row.price_cost_discount_pct),
          price_cost: this.nullableNumber(row.price_cost),
          price_clienta_markup_pct: this.nullablePercent(row.price_clienta_markup_pct),
          price_clienta: this.nullableNumber(row.price_clienta),
          stock_qty: this.nullableInteger(row.stock_qty),
          image_url: this.nullableText(row.image_url),
          notes: this.nullableText(row.notes),
          original_row: row.original_row || {},
          last_import_id: importId,
          last_imported_at: serverTimestamp(),
          updated_at: serverTimestamp(),
          created_at: serverTimestamp(),
        },
        { merge: true },
      );
      ops += 1;

      if (ops >= 450) {
        await batch.commit();
        batches += 1;
        batch = writeBatch(FIRESTORE);
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
      batches += 1;
    }

    this.mergeRows(
      cleanRows.map((row) => {
        const sku = row.sku.trim();
        return this.normalizeProduct(this.productDocId(resolvedBusinessId, sku), {
          ...row,
          product_id: this.productDocId(resolvedBusinessId, sku),
          catalog_product_id: this.productDocId(resolvedBusinessId, sku),
          business_id: resolvedBusinessId,
          sku,
          sku_normalized: this.normalizeSku(sku),
        });
      }),
    );
    return { importId, processed: cleanRows.length, batches };
  }

  watchCatalogPage(options?: { businessId?: BusinessId; searchSku?: string; pageSize?: number }): void {
    const businessId = normalizeBusinessId(options?.businessId || "catalogo");
    const pageSize = Math.max(10, Math.min(Math.trunc(options?.pageSize || 80), 200));
    const searchSku = this.normalizeSku(options?.searchSku || "");
    const key = `${businessId}:${searchSku}:${pageSize}`;
    if (this.activePageKey === key && this.unsubscribePage) return;

    this.stopWatchingPage();
    this.activePageKey = key;
    this.pageCursor = null;
    this.pageRows.set([]);
    this.pageState.set({ rows: [], loading: true, error: null, hasMore: false });

    const constraints: QueryConstraint[] = [
      where("business_id", "==", businessId),
      orderBy("sku_normalized"),
      fsLimit(pageSize),
    ];
    if (searchSku) {
      constraints.splice(1, 0, where("sku_normalized", ">=", searchSku), where("sku_normalized", "<=", `${searchSku}\uf8ff`));
    }

    this.unsubscribePage = onSnapshot(
      query(this.colRef, ...constraints),
      (snap) => {
        const rows = snap.docs.map((entry) => this.normalizeProduct(entry.id, entry.data() as Record<string, unknown>));
        this.pageCursor = snap.docs[snap.docs.length - 1] || null;
        this.pageRows.set(rows);
        this.pageState.set({
          rows,
          loading: false,
          error: null,
          hasMore: snap.docs.length >= pageSize,
        });
        this.mergeRows(rows);
      },
      (error) => {
        this.pageState.set({
          rows: this.pageRows(),
          loading: false,
          error: error.message || "No se pudieron cargar productos de Catalogo.",
          hasMore: false,
        });
      },
    );
  }

  stopWatchingPage(): void {
    this.unsubscribePage?.();
    this.unsubscribePage = null;
    this.activePageKey = "";
  }

  async loadMoreCatalogPage(options?: { businessId?: BusinessId; searchSku?: string; pageSize?: number }): Promise<void> {
    if (!this.pageCursor) return;
    const businessId = normalizeBusinessId(options?.businessId || "catalogo");
    const pageSize = Math.max(10, Math.min(Math.trunc(options?.pageSize || 80), 200));
    const searchSku = this.normalizeSku(options?.searchSku || "");
    this.pageState.update((current) => ({ ...current, loading: true, error: null }));

    const constraints: QueryConstraint[] = [
      where("business_id", "==", businessId),
      orderBy("sku_normalized"),
      startAfter(this.pageCursor),
      fsLimit(pageSize),
    ];
    if (searchSku) {
      constraints.splice(1, 0, where("sku_normalized", ">=", searchSku), where("sku_normalized", "<=", `${searchSku}\uf8ff`));
    }

    try {
      const snap = await getDocs(query(this.colRef, ...constraints));
      const nextRows = snap.docs.map((entry) => this.normalizeProduct(entry.id, entry.data() as Record<string, unknown>));
      this.pageCursor = snap.docs[snap.docs.length - 1] || null;
      const merged = this.mergeById([...this.pageRows(), ...nextRows]);
      this.pageRows.set(merged);
      this.pageState.set({ rows: merged, loading: false, error: null, hasMore: snap.docs.length >= pageSize });
      this.mergeRows(nextRows);
    } catch (error: any) {
      this.pageState.update((current) => ({
        ...current,
        loading: false,
        error: error?.message || "No se pudieron cargar mas productos.",
      }));
    }
  }

  async getBySku(sku: string, businessId: BusinessId = "catalogo"): Promise<CatalogProduct | null> {
    const cleanSku = sku.trim();
    if (!cleanSku) return null;
    const resolvedBusinessId = normalizeBusinessId(businessId);
    const snap = await getDoc(doc(this.colRef, this.productDocId(resolvedBusinessId, cleanSku)));
    if (!snap.exists()) return null;
    const row = this.normalizeProduct(snap.id, snap.data() as Record<string, unknown>);
    this.mergeRows([row]);
    return row;
  }

  async searchBySkuPrefix(sku: string, businessId: BusinessId = "catalogo", maxRows = 8): Promise<CatalogProduct[]> {
    const normalized = this.normalizeSku(sku);
    if (!normalized) return [];
    const resolvedBusinessId = normalizeBusinessId(businessId);
    const snap = await getDocs(query(
      this.colRef,
      where("business_id", "==", resolvedBusinessId),
      where("sku_normalized", ">=", normalized),
      where("sku_normalized", "<=", `${normalized}\uf8ff`),
      orderBy("sku_normalized"),
      fsLimit(Math.max(1, Math.min(Math.trunc(maxRows), 20))),
    ));
    const rows = snap.docs.map((entry) => this.normalizeProduct(entry.id, entry.data() as Record<string, unknown>));
    this.mergeRows(rows);
    return rows;
  }

  async resolveImpulsImage(product: CatalogProduct): Promise<ResolveImpulsImageResult> {
    const catalogProductId = product.catalog_product_id || product.product_id;
    if (!catalogProductId) return { ok: true, found: false, reason: "MISSING_CATALOG_PRODUCT_ID", images: [] };
    const result = await lastValueFrom(
      this.api.post<ResolveImpulsImageResult>("/api/admin/catalog-products/resolve-impuls-image", {
        business_id: "catalogo",
        catalog_product_id: catalogProductId,
      }),
    );
    const imageUrl = this.nullableText(result.image_url);
    const patch: Partial<CatalogProduct> = {
      ...product,
      image_url: imageUrl ?? product.image_url,
      image_storage_path: this.nullableText(result.image_storage_path) ?? product.image_storage_path,
      image_status: this.normalizeImageStatus(result.image_status) ?? product.image_status,
      image_provider: imageUrl ? "impuls" : product.image_provider,
    };
    this.mergeRows([{ ...product, ...patch }]);
    return result;
  }

  productDocId(businessId: BusinessId, sku: string): string {
    const encoded = encodeURIComponent(sku.trim()).replace(/\./g, "%2E");
    const safe = encoded.length <= 900 ? encoded : this.hashSku(sku);
    return `${businessId}_${safe}`;
  }

  private normalizeProduct(id: string, data: Record<string, unknown>): CatalogProduct {
    return {
      product_id: String(data["product_id"] || id),
      catalog_product_id: String(data["catalog_product_id"] || data["product_id"] || id),
      business_id: normalizeBusinessId(data["business_id"] || "catalogo"),
      sku: String(data["sku"] || ""),
      sku_normalized: this.normalizeSku(String(data["sku_normalized"] || data["sku"] || "")),
      name: String(data["name"] || data["sku"] || "Producto sin nombre"),
      brand_name: this.nullableText(data["brand_name"]),
      supplier_id: this.nullableText(data["supplier_id"]),
      supplier_name: this.nullableText(data["supplier_name"]),
      category: this.nullableText(data["category"]),
      color: this.nullableText(data["color"]),
      size: this.nullableText(data["size"]),
      price_cost_excel: this.nullableNumber(data["price_cost_excel"]),
      price_cost_discount_pct: this.nullablePercent(data["price_cost_discount_pct"]),
      price_cost: this.nullableNumber(data["price_cost"]),
      price_clienta_markup_pct: this.nullablePercent(data["price_clienta_markup_pct"]),
      price_clienta: this.nullableNumber(data["price_clienta"]),
      stock_qty: this.nullableInteger(data["stock_qty"]),
      impuls_product_id: this.nullableText(data["impuls_product_id"]),
      image_status: this.normalizeImageStatus(data["image_status"]),
      image_url: this.nullableText(data["image_url"]),
      image_storage_path: this.nullableText(data["image_storage_path"]),
      image_provider: this.nullableText(data["image_provider"]),
      impuls_image_source_url: this.nullableText(data["impuls_image_source_url"]),
      impuls_image_fetched_at: data["impuls_image_fetched_at"] ?? null,
      impuls_image_error: this.nullableText(data["impuls_image_error"]),
      notes: this.nullableText(data["notes"]),
      original_row: (data["original_row"] || {}) as Record<string, unknown>,
      last_import_id: this.nullableText(data["last_import_id"]),
      last_imported_at: data["last_imported_at"] ?? null,
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private nullableText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  private nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(number)) return null;
    return Number(Math.max(0, number).toFixed(2));
  }

  private nullablePercent(value: unknown): number | null {
    const number = this.nullableNumber(value);
    return number === null ? null : Math.max(0, Math.min(100, number));
  }

  private nullableInteger(value: unknown): number | null {
    const number = this.nullableNumber(value);
    return number === null ? null : Math.max(0, Math.trunc(number));
  }

  private normalizeImageStatus(value: unknown): CatalogProductImageStatus | null {
    const status = String(value || "").trim().toUpperCase();
    if (status === "PENDING" || status === "FETCHED" || status === "NOT_FOUND" || status === "NO_IMAGE" || status === "ERROR") return status;
    return null;
  }

  private hashSku(value: string): string {
    let hash = 0;
    const source = value.trim();
    for (let idx = 0; idx < source.length; idx += 1) {
      hash = (hash * 31 + source.charCodeAt(idx)) >>> 0;
    }
    return `sku_${hash.toString(36)}`;
  }

  normalizeSku(value: unknown): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  private mergeRows(rows: CatalogProduct[]): void {
    if (rows.length === 0) return;
    this.rows.update((current) => this.mergeById([...rows, ...current]));
  }

  private mergeById(rows: CatalogProduct[]): CatalogProduct[] {
    const map = new Map<string, CatalogProduct>();
    for (const row of rows) map.set(row.product_id, row);
    return [...map.values()].sort((a, b) =>
      (a.sku_normalized || a.sku).localeCompare(b.sku_normalized || b.sku, "es", { sensitivity: "base" }),
    );
  }
}
