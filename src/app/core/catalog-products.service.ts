import { Injectable, computed, inject, signal } from "@angular/core";
import { lastValueFrom } from "rxjs";
import {
  Unsubscribe,
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { UserAdminApiService } from "../services/user-admin-api.service";

export type CatalogProductImageStatus = "PENDING" | "FETCHED" | "NOT_FOUND" | "NO_IMAGE" | "ERROR";

export type CatalogProductIdentifierType =
  | "barcode"
  | "supplier_sku"
  | "supplier_variant"
  | "generic"
  | "internet"
  | "model"
  | "style"
  | "bundle"
  | "ocr_alias"
  | "custom"
  | "legacy_sku";

export type CatalogProductIdentifierScope = "variant" | "group" | "bundle";

export interface CatalogProductPrices {
  cost: number | null;
  clienta: number | null;
  currency: string;
}

export interface CatalogProductIdentifier {
  identifier_id: string | null;
  type: CatalogProductIdentifierType;
  value: string;
  normalized_value: string;
  scope: CatalogProductIdentifierScope;
  namespace: string | null;
  supplier_id: string | null;
  is_primary: boolean;
  product_id?: string | null;
  is_active?: boolean;
  revision?: number;
}

export interface CatalogProductSourceRef {
  import_id?: string | null;
  listing_id?: string | null;
  sheet?: string | null;
  row?: number | null;
  [key: string]: unknown;
}

export interface CatalogProductGroup {
  group_id: string;
  business_id: BusinessId;
  supplier_id: string | null;
  name: string;
  model: string | null;
  color: string | null;
  attributes: Record<string, unknown>;
}

export interface CatalogProductBundleComponent {
  component_id: string;
  component_product_id: string | null;
  component_identifier: string | null;
  quantity: number;
  resolution_status: "resolved" | "pending";
}

export interface CatalogProductBundle {
  bundle_id: string;
  business_id: BusinessId;
  supplier_id: string | null;
  code: string;
  name: string;
  sellable: boolean;
  prices: CatalogProductPrices;
  components: CatalogProductBundleComponent[];
}

export interface CatalogProductSearchResult {
  result_id: string;
  product: CatalogProduct | null;
  group: CatalogProductGroup | null;
  bundle: CatalogProductBundle | null;
  variants: CatalogProduct[];
  matched_identifier: CatalogProductIdentifier | null;
  requires_selection: boolean;
}

export interface CatalogProductSearchOptions {
  businessId?: BusinessId;
  supplierId?: string | null;
  types?: CatalogProductIdentifierType[];
  limit?: number;
  exact?: boolean;
  sellableOnly?: boolean;
}

export function catalogProductIdentifierLabel(type: CatalogProductIdentifierType): string {
  const labels: Record<CatalogProductIdentifierType, string> = {
    barcode: "código de barras",
    supplier_sku: "SKU de proveedor",
    supplier_variant: "código de variante",
    generic: "código genérico",
    internet: "código de internet",
    model: "modelo",
    style: "estilo",
    bundle: "combo",
    ocr_alias: "alias OCR",
    custom: "código personalizado",
    legacy_sku: "SKU anterior",
  };
  return labels[type];
}

export interface CatalogProduct {
  product_id: string;
  catalog_product_id: string;
  business_id: BusinessId;
  primary_barcode: string | null;
  supplier_sku: string | null;
  group_id: string | null;
  prices: CatalogProductPrices;
  identifiers: CatalogProductIdentifier[];
  revision: number;
  attributes: Record<string, unknown>;
  source_refs: CatalogProductSourceRef[];
  catalog_generation_id: string | null;
  catalog_status: string | null;
  needs_price_review: boolean;
  sellable: boolean;
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
  cklass_model: string | null;
  cklass_color: string | null;
  cklass_size: string | null;
  cklass_barcode: string | null;
  cklass_catalog: string | null;
  cklass_model_display: string | null;
  cklass_product_code: string | null;
  image_key: string | null;
  image_status: CatalogProductImageStatus | null;
  image_url: string | null;
  image_storage_path: string | null;
  image_provider: string | null;
  impuls_image_source_url: string | null;
  impuls_image_fetched_at?: unknown;
  impuls_image_error: string | null;
  cklass_image_source_url: string | null;
  cklass_image_fetched_at?: unknown;
  cklass_image_error: string | null;
  notes: string | null;
  original_row?: Record<string, unknown>;
  active?: boolean;
  last_import_id?: string | null;
  last_imported_at?: unknown;
  last_price_import_id?: string | null;
  last_price_imported_at?: unknown;
  last_price_imported_by?: string | null;
  last_import_row_id?: string | null;
  last_import_status?: string | null;
  price_health_flags?: string[];
  reverted_from_import_id?: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface CatalogProductImportRow {
  sku: string;
  name: string;
  row_number?: number | null;
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
  cklass_model?: string | null;
  cklass_color?: string | null;
  cklass_size?: string | null;
  cklass_barcode?: string | null;
  cklass_catalog?: string | null;
  cklass_model_display?: string | null;
  cklass_product_code?: string | null;
  image_key?: string | null;
  stock_qty?: number | null;
  image_url?: string | null;
  notes?: string | null;
  original_row?: Record<string, unknown>;
}

export interface CatalogProductsPageState {
  rows: CatalogProduct[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

export interface CatalogProductMetrics {
  total: number;
  active: number;
  updated: number;
  stale: number;
  missing_price: number;
  review: number;
  provisional: number;
  groups: number;
  variants: number;
  quality_issues: number;
}

interface CatalogProductsListResult {
  ok?: boolean;
  products?: unknown[];
  next_cursor?: string | null;
  active_generation_ids?: string[];
}

interface CatalogProductDetailResult {
  ok?: boolean;
  product?: unknown;
  active_generation_id?: string | null;
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

export type ResolveCklassImageResult = ResolveImpulsImageResult;

@Injectable({ providedIn: "root" })
export class CatalogProductsService {
  private colRef = collection(FIRESTORE, "catalog_products");
  private businessScope = inject(BusinessScopeService);
  private api = inject(UserAdminApiService);
  private rows = signal<CatalogProduct[]>([]);
  private pageRows = signal<CatalogProduct[]>([]);
  private pageCursor: string | null = null;
  private unsubscribePage: Unsubscribe | null = null;
  private activePageKey = "";
  private activeGenerationFingerprint = "";
  private pageLoadSequence = 0;

  readonly pageState = signal<CatalogProductsPageState>({
    rows: [],
    loading: false,
    error: null,
    hasMore: false,
  });

  products = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rows().filter((row) => active.includes(row.business_id || "bm") && row.active !== false);
  });

  catalogoProducts = computed(() =>
    this.businessScope.canAccessBusiness("catalogo")
      ? this.rows().filter((row) => row.business_id === "catalogo" && row.active !== false)
      : [],
  );

  catalogoPageProducts = computed(() =>
    this.businessScope.canAccessBusiness("catalogo") ? this.pageRows() : [],
  );

  async loadFromFirestore(): Promise<void> {
    const snap = await getDocs(query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalizeProduct(entry.id, entry.data() as Record<string, unknown>))
      // Los documentos v2 son una proyección técnica que puede ir por delante de
      // la generación activa; solo el backend debe resolverlos. Este fallback es
      // exclusivamente para documentos legacy sin generación.
      .filter((row) => row.active !== false && !row.catalog_generation_id)
      .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
    this.rows.set(rows);
  }

  watchCatalogPage(options?: { businessId?: BusinessId; searchSku?: string; supplierId?: string | null; pageSize?: number }): void {
    const businessId = normalizeBusinessId(options?.businessId || "catalogo");
    const pageSize = Math.max(10, Math.min(Math.trunc(options?.pageSize || 80), 200));
    const searchSku = this.normalizeSku(options?.searchSku || "");
    const supplierId = this.nullableText(options?.supplierId);
    const key = `${businessId}:${searchSku}:${supplierId || ""}:${pageSize}`;
    if (this.activePageKey === key && this.unsubscribePage) return;

    this.stopWatchingPage();
    this.activePageKey = key;
    this.pageCursor = null;
    this.pageRows.set([]);
    this.pageState.set({ rows: [], loading: true, error: null, hasMore: false });

    const reloadActiveGeneration = () => {
      this.pageCursor = null;
      void this.loadCatalogPageFromApi({ businessId, searchSku, supplierId, pageSize, key, append: false });
    };
    if (!supplierId) {
      reloadActiveGeneration();
      return;
    }

    const generationsRef = collection(FIRESTORE, "catalog_generations");
    this.unsubscribePage = onSnapshot(
      query(
        generationsRef,
        where("business_id", "==", businessId),
        where("supplier_id", "==", supplierId),
        where("status", "==", "active"),
      ),
      (snap) => {
        const fingerprint = snap.docs.map((entry) => entry.id).sort().join("|");
        if (fingerprint === this.activeGenerationFingerprint && !this.pageState().loading) return;
        this.activeGenerationFingerprint = fingerprint;
        reloadActiveGeneration();
      },
      () => reloadActiveGeneration(),
    );
  }

  stopWatchingPage(): void {
    this.unsubscribePage?.();
    this.unsubscribePage = null;
    this.activePageKey = "";
    this.activeGenerationFingerprint = "";
    this.pageLoadSequence += 1;
  }

  async loadMoreCatalogPage(options?: { businessId?: BusinessId; searchSku?: string; supplierId?: string | null; pageSize?: number }): Promise<void> {
    if (!this.pageCursor) return;
    const businessId = normalizeBusinessId(options?.businessId || "catalogo");
    const pageSize = Math.max(10, Math.min(Math.trunc(options?.pageSize || 80), 200));
    const searchSku = this.normalizeSku(options?.searchSku || "");
    const supplierId = this.nullableText(options?.supplierId);
    const key = `${businessId}:${searchSku}:${supplierId || ""}:${pageSize}`;
    if (key !== this.activePageKey || searchSku) return;
    await this.loadCatalogPageFromApi({ businessId, searchSku, supplierId, pageSize, key, append: true });
  }

  private async loadCatalogPageFromApi(options: {
    businessId: BusinessId;
    searchSku: string;
    supplierId: string | null;
    pageSize: number;
    key: string;
    append: boolean;
  }): Promise<void> {
    const requestSequence = ++this.pageLoadSequence;
    this.pageState.update((current) => ({ ...current, loading: true, error: null }));
    try {
      let nextRows: CatalogProduct[] = [];
      let nextCursor: string | null = null;
      if (options.searchSku) {
        const results = await this.searchCatalog(options.searchSku, {
          businessId: options.businessId,
          supplierId: options.supplierId,
          limit: Math.min(50, options.pageSize),
        });
        nextRows = this.mergeById(results.flatMap((result) => result.variants));
      } else {
        const params = new URLSearchParams({
          business_id: options.businessId,
          limit: String(Math.min(100, options.pageSize)),
          include_stale: "true",
          include_inactive: "true",
        });
        if (options.supplierId) params.set("supplier_id", options.supplierId);
        if (options.append && this.pageCursor) params.set("cursor", this.pageCursor);
        const result = await lastValueFrom(
          this.api.get<CatalogProductsListResult>(`/api/admin/catalog-products?${params.toString()}`),
        );
        nextRows = (Array.isArray(result.products) ? result.products : [])
          .map((entry, index) => {
            const product = this.objectRecord(entry);
            return this.normalizeProduct(
              String(product["product_id"] || product["catalog_product_id"] || `catalog_page_${index}`),
              product,
            );
          });
        nextCursor = this.nullableText(result.next_cursor);
      }
      if (requestSequence !== this.pageLoadSequence || options.key !== this.activePageKey) return;
      this.pageCursor = nextCursor;
      const rows = options.append
        ? this.mergeById([...this.pageRows(), ...nextRows])
        : this.mergeById(nextRows);
      this.pageRows.set(rows);
      this.pageState.set({ rows, loading: false, error: null, hasMore: nextCursor !== null });
      this.mergeRows(nextRows);
    } catch (error: unknown) {
      if (requestSequence !== this.pageLoadSequence || options.key !== this.activePageKey) return;
      this.pageState.update((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "No se pudieron cargar productos de Catálogo.",
        hasMore: false,
      }));
    }
  }

  async getBySku(sku: string, businessId: BusinessId = "catalogo"): Promise<CatalogProduct | null> {
    const cleanSku = sku.trim();
    if (!cleanSku) return null;
    const resolvedBusinessId = normalizeBusinessId(businessId);
    const snap = await getDoc(doc(this.colRef, this.productDocId(resolvedBusinessId, cleanSku)));
    if (snap.exists()) {
      const row = this.normalizeProduct(snap.id, snap.data() as Record<string, unknown>);
      if (row.active !== false && !row.catalog_generation_id) {
        this.mergeRows([row]);
        return row;
      }
    }

    const results = await this.searchCatalog(cleanSku, {
      businessId: resolvedBusinessId,
      types: ["barcode", "supplier_sku", "supplier_variant"],
      limit: 5,
      exact: true,
    });
    const exact = results.find((result) => !result.requires_selection && !!result.product)?.product || null;
    return exact;
  }

  async getLegacyBySku(sku: string, businessId: BusinessId = "catalogo"): Promise<CatalogProduct | null> {
    const cleanSku = sku.trim();
    if (!cleanSku) return null;
    const resolvedBusinessId = normalizeBusinessId(businessId);
    const snap = await getDoc(doc(this.colRef, this.productDocId(resolvedBusinessId, cleanSku)));
    if (!snap.exists()) return null;
    const row = this.normalizeProduct(snap.id, snap.data() as Record<string, unknown>);
    if (row.active === false || row.catalog_generation_id) return null;
    this.mergeRows([row]);
    return row;
  }

  async getById(productId: string, businessId: BusinessId = "catalogo"): Promise<CatalogProduct | null> {
    const cleanId = productId.trim();
    if (!cleanId) return null;
    const resolvedBusinessId = normalizeBusinessId(businessId);
    try {
      const params = new URLSearchParams({ business_id: resolvedBusinessId });
      const result = await lastValueFrom(
        this.api.get<CatalogProductDetailResult>(
          `/api/admin/catalog-products/${encodeURIComponent(cleanId)}?${params.toString()}`,
        ),
      );
      const rawProduct = this.objectRecord(result.product);
      if (!Object.keys(rawProduct).length) return null;
      const row = this.normalizeProduct(
        String(rawProduct["product_id"] || rawProduct["catalog_product_id"] || cleanId),
        rawProduct,
      );
      if (row.active === false || row.business_id !== resolvedBusinessId) return null;
      this.mergeRows([row]);
      return row;
    } catch {
      // Compatibilidad temporal: nunca exponer una proyeccion v2 que pueda ir
      // por delante de la generacion activa; solo se admite el documento legacy.
      const snap = await getDoc(doc(this.colRef, cleanId));
      if (!snap.exists()) return null;
      const row = this.normalizeProduct(snap.id, snap.data() as Record<string, unknown>);
      if (row.active === false || row.catalog_generation_id || row.business_id !== resolvedBusinessId) return null;
      this.mergeRows([row]);
      return row;
    }
  }

  /**
   * Resolvedor comun de Catalogo v2. Conserva un fallback de solo lectura para
   * documentos legacy mientras termina la reimportacion blue/green.
   */
  async searchCatalog(searchText: string, options: CatalogProductSearchOptions = {}): Promise<CatalogProductSearchResult[]> {
    const cleanQuery = String(searchText || "").trim();
    if (!cleanQuery) return [];

    const businessId = normalizeBusinessId(options.businessId || "catalogo");
    const maxRows = Math.max(1, Math.min(Math.trunc(options.limit || 25), 50));
    const queryParams = new URLSearchParams({
      business_id: businessId,
      q: cleanQuery,
      limit: String(maxRows),
    });
    const supplierId = this.nullableText(options.supplierId);
    if (supplierId) queryParams.set("supplier_id", supplierId);
    if (options.types?.length) queryParams.set("types", [...new Set(options.types)].join(","));

    try {
      const response = await lastValueFrom(
        this.api.get<unknown>(`/api/admin/catalog-products/search?${queryParams.toString()}`),
      );
      const results = this.normalizeSearchResponse(
        response,
        businessId,
        cleanQuery,
        Boolean(options.exact),
        Boolean(options.sellableOnly),
      );
      this.mergeRows(results.flatMap((result) => result.variants));
      return results;
    } catch {
      const legacyRows = await this.searchLegacyBySkuPrefix(cleanQuery, businessId, maxRows);
      const normalizedQuery = this.normalizeSku(cleanQuery);
      const exactRows = options.exact
        ? legacyRows.filter((row) => this.normalizeSku(row.sku) === normalizedQuery)
        : legacyRows;
      const rows = options.sellableOnly ? exactRows.filter((row) => row.sellable !== false) : exactRows;
      return rows.map((product) => this.legacySearchResult(product, cleanQuery));
    }
  }

  async getMetrics(options: { businessId?: BusinessId; supplierId?: string | null } = {}): Promise<CatalogProductMetrics> {
    const businessId = normalizeBusinessId(options.businessId || "catalogo");
    const queryParams = new URLSearchParams({ business_id: businessId });
    const supplierId = this.nullableText(options.supplierId);
    if (supplierId) queryParams.set("supplier_id", supplierId);
    const response = await lastValueFrom(
      this.api.get<unknown>(`/api/admin/catalog-products/metrics?${queryParams.toString()}`),
    );
    const root = this.objectRecord(response);
    const metrics = this.objectRecord(root["metrics"]);
    return {
      total: this.nonNegativeInteger(metrics["total"]),
      active: this.nonNegativeInteger(metrics["active"]),
      updated: this.nonNegativeInteger(metrics["updated"]),
      stale: this.nonNegativeInteger(metrics["stale"]),
      missing_price: this.nonNegativeInteger(metrics["missing_price"]),
      review: this.nonNegativeInteger(metrics["review"]),
      provisional: this.nonNegativeInteger(metrics["provisional"]),
      groups: this.nonNegativeInteger(metrics["groups"]),
      variants: this.nonNegativeInteger(metrics["variants"]),
      quality_issues: this.nonNegativeInteger(metrics["quality_issues"]),
    };
  }

  async saveOcrAlias(
    productId: string,
    value: string,
    businessId: BusinessId = "catalogo",
  ): Promise<CatalogProductIdentifier> {
    const cleanProductId = productId.trim();
    const cleanValue = value.trim();
    if (!cleanProductId || !cleanValue) throw new Error("Producto y alias OCR son obligatorios.");
    const response = await lastValueFrom(
      this.api.post<unknown>(
        `/api/admin/catalog-products/${encodeURIComponent(cleanProductId)}/identifiers`,
        {
          business_id: normalizeBusinessId(businessId),
          type: "ocr_alias",
          value: cleanValue,
          source: "scanner_ocr",
          namespace: "scanner_ocr",
        },
      ),
    );
    const root = this.objectRecord(response);
    const identifier = this.normalizeIdentifier(root["identifier"]);
    if (!identifier) throw new Error("El backend no devolvió el alias creado.");
    return identifier;
  }

  async searchBySkuPrefix(sku: string, businessId: BusinessId = "catalogo", maxRows = 8): Promise<CatalogProduct[]> {
    const results = await this.searchCatalog(sku, { businessId, limit: maxRows });
    return this.mergeById(results.flatMap((result) => result.variants));
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

  async resolveCklassImage(product: CatalogProduct): Promise<ResolveCklassImageResult> {
    const catalogProductId = product.catalog_product_id || product.product_id;
    if (!catalogProductId) return { ok: true, found: false, reason: "MISSING_CATALOG_PRODUCT_ID", images: [] };
    const result = await lastValueFrom(
      this.api.post<ResolveCklassImageResult>("/api/admin/catalog-products/resolve-cklass-image", {
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
      image_provider: imageUrl ? "CKLASS" : product.image_provider,
    };
    this.mergeRows([{ ...product, ...patch }]);
    return result;
  }

  productDocId(businessId: BusinessId, sku: string): string {
    const encoded = encodeURIComponent(sku.trim()).replace(/\./g, "%2E");
    const safe = encoded.length <= 900 ? encoded : this.hashSku(sku);
    return `${businessId}_${safe}`;
  }

  private async searchLegacyBySkuPrefix(sku: string, businessId: BusinessId, maxRows: number): Promise<CatalogProduct[]> {
    const normalized = this.normalizeSku(sku);
    if (!normalized) return [];
    const snap = await getDocs(query(
      this.colRef,
      where("business_id", "==", businessId),
      where("sku_normalized", ">=", normalized),
      where("sku_normalized", "<=", `${normalized}\uf8ff`),
      orderBy("sku_normalized"),
      fsLimit(Math.max(1, Math.min(Math.trunc(maxRows), 50))),
    ));
    const rows = snap.docs
      .map((entry) => this.normalizeProduct(entry.id, entry.data() as Record<string, unknown>))
      .filter((row) => row.active !== false && !row.catalog_generation_id);
    this.mergeRows(rows);
    return rows;
  }

  private legacySearchResult(product: CatalogProduct, queryText: string): CatalogProductSearchResult {
    const identifier: CatalogProductIdentifier = {
      identifier_id: null,
      type: "legacy_sku",
      value: product.sku || queryText,
      normalized_value: this.normalizeSku(product.sku || queryText),
      scope: "variant",
      namespace: null,
      supplier_id: product.supplier_id,
      is_primary: true,
    };
    return {
      result_id: `legacy:${product.product_id}`,
      product,
      group: null,
      bundle: null,
      variants: [product],
      matched_identifier: identifier,
      requires_selection: false,
    };
  }

  private normalizeSearchResponse(
    raw: unknown,
    businessId: BusinessId,
    queryText: string,
    exact: boolean,
    sellableOnly: boolean,
  ): CatalogProductSearchResult[] {
    const response = this.objectRecord(raw);
    const nestedData = this.objectRecord(response["data"]);
    const rawResults = this.firstArray(response["results"], response["rows"], response["matches"], nestedData["results"]);
    const normalizedQuery = this.normalizeSku(queryText);
    const results: CatalogProductSearchResult[] = [];

    for (const [index, rawResult] of rawResults.entries()) {
      const result = this.objectRecord(rawResult);
      if (!Object.keys(result).length) continue;
      const rawProduct = this.objectRecord(result["product"]);
      const productSource = Object.keys(rawProduct).length
        ? rawProduct
        : (result["product_id"] || result["sku"] ? result : {});
      const normalizedProduct = Object.keys(productSource).length
        ? this.normalizeProduct(String(productSource["product_id"] || productSource["catalog_product_id"] || `search_${index}`), productSource)
        : null;
      const product = normalizedProduct && normalizedProduct.active !== false && (!sellableOnly || normalizedProduct.sellable !== false)
        ? normalizedProduct
        : null;

      const variantsSource = this.firstArray(result["variants"], result["products"]);
      const variants = this.mergeById([
        ...variantsSource
          .map((entry, variantIndex) => {
            const variant = this.objectRecord(entry);
            if (!Object.keys(variant).length) return null;
            return this.normalizeProduct(
              String(variant["product_id"] || variant["catalog_product_id"] || `search_${index}_${variantIndex}`),
              variant,
            );
          })
          .filter((entry): entry is CatalogProduct => entry !== null),
        ...(product ? [product] : []),
      ]).filter((entry) => entry.active !== false && (!sellableOnly || entry.sellable !== false));

      const identifier = this.normalizeIdentifier(result["matched_identifier"] ?? result["identifier"]);
      if (exact && !this.isExactSearchResult(identifier, variants, normalizedQuery)) continue;

      const group = this.normalizeGroup(result["group"], businessId, variants[0] || product);
      const bundle = this.normalizeBundle(result["bundle"], businessId);
      const groupScope = identifier?.scope === "group";
      const requiresSelection = Boolean(result["requires_selection"] ?? result["requiresSelection"])
        || bundle !== null
        || groupScope
        || (!product && variants.length > 0)
        || variants.length > 1;
      const baseResultId = this.nullableText(result["result_id"])
        || identifier?.identifier_id
        || `${bundle?.bundle_id || group?.group_id || product?.product_id || "result"}:${identifier?.type || "unknown"}:${identifier?.normalized_value || index}`;
      const targetKey = bundle?.bundle_id || group?.group_id || product?.product_id || variants.map((variant) => variant.product_id).join(",") || String(index);
      const resultId = `${baseResultId}:${targetKey}`;

      results.push({
        result_id: resultId,
        product: requiresSelection ? null : (product || variants[0] || null),
        group,
        bundle,
        variants,
        matched_identifier: identifier,
        requires_selection: requiresSelection,
      });
    }

    return this.dedupeSearchResults(results);
  }

  private isExactSearchResult(
    identifier: CatalogProductIdentifier | null,
    variants: CatalogProduct[],
    normalizedQuery: string,
  ): boolean {
    if (!normalizedQuery) return false;
    if (identifier?.normalized_value && this.normalizeSku(identifier.normalized_value) === normalizedQuery) return true;
    return variants.some((product) => [product.primary_barcode, product.supplier_sku, product.sku]
      .some((value) => this.normalizeSku(value) === normalizedQuery));
  }

  private normalizeIdentifier(raw: unknown): CatalogProductIdentifier | null {
    const data = this.objectRecord(raw);
    const value = this.nullableText(data["value"]);
    if (!value) return null;
    const type = this.normalizeIdentifierType(data["type"]);
    const scope = this.normalizeIdentifierScope(data["scope"]);
    return {
      identifier_id: this.nullableText(data["identifier_id"] ?? data["id"]),
      type,
      value,
      normalized_value: this.nullableText(data["normalized_value"]) || this.normalizeSku(value),
      scope,
      namespace: this.nullableText(data["namespace"]),
      supplier_id: this.nullableText(data["supplier_id"]),
      is_primary: Boolean(data["is_primary"] ?? false),
      product_id: this.nullableText(data["product_id"]),
      is_active: data["is_active"] === false ? false : true,
      revision: this.nonNegativeInteger(data["revision"]),
    };
  }

  private normalizeIdentifiers(raw: unknown): CatalogProductIdentifier[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => this.normalizeIdentifier(entry))
      .filter((entry): entry is CatalogProductIdentifier => entry !== null);
  }

  private normalizeIdentifierType(raw: unknown): CatalogProductIdentifierType {
    const value = String(raw || "").trim().toLowerCase();
    const supported: CatalogProductIdentifierType[] = [
      "barcode",
      "supplier_sku",
      "supplier_variant",
      "generic",
      "internet",
      "model",
      "style",
      "bundle",
      "ocr_alias",
      "custom",
      "legacy_sku",
    ];
    return supported.includes(value as CatalogProductIdentifierType)
      ? value as CatalogProductIdentifierType
      : "custom";
  }

  private normalizeIdentifierScope(raw: unknown): CatalogProductIdentifierScope {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "group" || value === "bundle") return value;
    return "variant";
  }

  private normalizeGroup(raw: unknown, businessId: BusinessId, fallback?: CatalogProduct | null): CatalogProductGroup | null {
    const data = this.objectRecord(raw);
    const groupId = this.nullableText(data["group_id"] ?? data["id"]) || fallback?.group_id || null;
    if (!groupId) return null;
    return {
      group_id: groupId,
      business_id: normalizeBusinessId(data["business_id"] || fallback?.business_id || businessId),
      supplier_id: this.nullableText(data["supplier_id"]) || fallback?.supplier_id || null,
      name: this.nullableText(data["name"] ?? data["title"]) || fallback?.name || groupId,
      model: this.nullableText(data["model"]),
      color: this.nullableText(data["color"]),
      attributes: this.objectRecord(data["attributes"]),
    };
  }

  private normalizeBundle(raw: unknown, businessId: BusinessId): CatalogProductBundle | null {
    const data = this.objectRecord(raw);
    const bundleId = this.nullableText(data["bundle_id"] ?? data["id"]);
    if (!bundleId) return null;
    const rawPrices = this.objectRecord(data["prices"]);
    const components = Array.isArray(data["components"])
      ? data["components"].map((entry, index) => {
          const component = this.objectRecord(entry);
          return {
            component_id: this.nullableText(component["component_id"] ?? component["id"]) || `${bundleId}:${index}`,
            component_product_id: this.nullableText(component["component_product_id"]),
            component_identifier: this.nullableText(component["component_identifier"]),
            quantity: Math.max(1, this.nonNegativeInteger(component["quantity"] || 1)),
            resolution_status: component["resolution_status"] === "resolved" ? "resolved" as const : "pending" as const,
          };
        })
      : [];
    return {
      bundle_id: bundleId,
      business_id: normalizeBusinessId(data["business_id"] || businessId),
      supplier_id: this.nullableText(data["supplier_id"]),
      code: this.nullableText(data["code"]) || bundleId,
      name: this.nullableText(data["name"] ?? data["title"]) || this.nullableText(data["code"]) || bundleId,
      sellable: data["sellable"] === true,
      prices: {
        cost: this.nullableNumber(rawPrices["cost"]),
        clienta: this.nullableNumber(rawPrices["clienta"]),
        currency: this.nullableText(rawPrices["currency"]) || "MXN",
      },
      components,
    };
  }

  private normalizeSourceRefs(raw: unknown): CatalogProductSourceRef[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => this.objectRecord(entry))
      .filter((entry) => Object.keys(entry).length > 0) as CatalogProductSourceRef[];
  }

  private dedupeSearchResults(results: CatalogProductSearchResult[]): CatalogProductSearchResult[] {
    const seen = new Set<string>();
    return results.filter((result) => {
      const variantKey = result.variants.map((variant) => variant.product_id).sort().join(",");
      const key = `${result.result_id}:${variantKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private firstArray(...values: unknown[]): unknown[] {
    return values.find((value): value is unknown[] => Array.isArray(value)) || [];
  }

  private objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private normalizeProduct(id: string, data: Record<string, unknown>): CatalogProduct {
    const priceData = this.objectRecord(data["prices"]);
    const legacySku = String(data["sku"] || "").trim();
    const isV2Document = Number(data["schema_version"]) >= 2
      || "group_id" in data
      || "prices" in data
      || "identifiers" in data
      || "primary_barcode" in data
      || "supplier_sku" in data
      || "catalog_generation_id" in data;
    const explicitBarcode = this.nullableText(data["primary_barcode"])
      || this.nullableText(data["barcode"])
      || this.nullableText(data["cklass_barcode"]);
    const primaryBarcode = explicitBarcode || (!isV2Document ? this.nullableText(legacySku) : null);
    const supplierSku = this.nullableText(data["supplier_sku"]);
    const cost = this.nullableNumber(priceData["cost"] ?? data["price_cost"]);
    const clienta = this.nullableNumber(priceData["clienta"] ?? data["price_clienta"]);
    const sku = legacySku || primaryBarcode || supplierSku || "";
    return {
      product_id: String(data["product_id"] || id),
      catalog_product_id: String(data["catalog_product_id"] || data["product_id"] || id),
      business_id: normalizeBusinessId(data["business_id"] || "catalogo"),
      primary_barcode: primaryBarcode,
      supplier_sku: supplierSku,
      group_id: this.nullableText(data["group_id"]),
      prices: {
        cost,
        clienta,
        currency: this.nullableText(priceData["currency"] ?? data["price_currency"]) || "MXN",
      },
      identifiers: this.normalizeIdentifiers(data["identifiers"]),
      revision: this.nonNegativeInteger(data["revision"]),
      attributes: this.objectRecord(data["attributes"]),
      source_refs: this.normalizeSourceRefs(data["source_refs"]),
      catalog_generation_id: this.nullableText(data["catalog_generation_id"] ?? data["generation_id"]),
      catalog_status: this.nullableText(data["catalog_status"]),
      needs_price_review: Boolean(data["needs_price_review"] ?? false),
      sellable: data["sellable"] === false ? false : true,
      sku,
      sku_normalized: this.normalizeSku(String(data["sku_normalized"] || sku)),
      name: String(data["name"] || sku || "Producto sin nombre"),
      brand_name: this.nullableText(data["brand_name"]),
      supplier_id: this.nullableText(data["supplier_id"]),
      supplier_name: this.nullableText(data["supplier_name"]),
      category: this.nullableText(data["category"]),
      color: this.nullableText(data["color"]),
      size: this.nullableText(data["size"]),
      price_cost_excel: this.nullableNumber(data["price_cost_excel"]),
      price_cost_discount_pct: this.nullablePercent(data["price_cost_discount_pct"]),
      price_cost: cost,
      price_clienta_markup_pct: this.nullablePercent(data["price_clienta_markup_pct"]),
      price_clienta: clienta,
      stock_qty: this.nullableInteger(data["stock_qty"]),
      impuls_product_id: this.nullableText(data["impuls_product_id"]),
      cklass_model: this.nullableText(data["cklass_model"]),
      cklass_color: this.nullableText(data["cklass_color"]),
      cklass_size: this.nullableText(data["cklass_size"]),
      cklass_barcode: this.nullableText(data["cklass_barcode"]),
      cklass_catalog: this.nullableText(data["cklass_catalog"]),
      cklass_model_display: this.nullableText(data["cklass_model_display"]),
      cklass_product_code: this.nullableText(data["cklass_product_code"]),
      image_key: this.nullableText(data["image_key"]),
      image_status: this.normalizeImageStatus(data["image_status"]),
      image_url: this.nullableText(data["image_url"]),
      image_storage_path: this.nullableText(data["image_storage_path"]),
      image_provider: this.nullableText(data["image_provider"]),
      impuls_image_source_url: this.nullableText(data["impuls_image_source_url"]),
      impuls_image_fetched_at: data["impuls_image_fetched_at"] ?? null,
      impuls_image_error: this.nullableText(data["impuls_image_error"]),
      cklass_image_source_url: this.nullableText(data["cklass_image_source_url"]),
      cklass_image_fetched_at: data["cklass_image_fetched_at"] ?? null,
      cklass_image_error: this.nullableText(data["cklass_image_error"]),
      notes: this.nullableText(data["notes"]),
      original_row: (data["original_row"] || {}) as Record<string, unknown>,
      active: data["active"] === false ? false : true,
      last_import_id: this.nullableText(data["last_import_id"]),
      last_imported_at: data["last_imported_at"] ?? null,
      last_price_import_id: this.nullableText(data["last_price_import_id"]),
      last_price_imported_at: data["last_price_imported_at"] ?? null,
      last_price_imported_by: this.nullableText(data["last_price_imported_by"]),
      last_import_row_id: this.nullableText(data["last_import_row_id"]),
      last_import_status: this.nullableText(data["last_import_status"]),
      price_health_flags: Array.isArray(data["price_health_flags"]) ? data["price_health_flags"].map((value) => String(value)) : [],
      reverted_from_import_id: this.nullableText(data["reverted_from_import_id"]),
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

  private nonNegativeInteger(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
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
