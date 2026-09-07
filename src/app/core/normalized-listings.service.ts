import { Injectable, computed, inject, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  startAfter,
  QueryDocumentSnapshot,
  DocumentData,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  setDoc,
  Unsubscribe,
} from "firebase/firestore";
import type {
  NormalizedListingDoc,
  NormalizedListingDocV3,
  ListPage,
  RawPost,
  ReviewPatch,
  PartialNormalizedUpdate,
  StockState,
  WorkflowStatus,
} from "./firestore-contracts";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

// Re-exportar tipos para compatibilidad
export type {
  NormalizedListingDoc,
  ListPage,
  ReviewPatch,
  PartialNormalizedUpdate,
  StockState,
};

@Injectable({ providedIn: "root" })
export class NormalizedListingsService {
  private colRef = collection(FIRESTORE, "normalized_listings");
  private businessScope = inject(BusinessScopeService);

  /** Primera página de listings pendientes de revisión, actualizada en tiempo real. */
  readonly liveFirstPage = signal<NormalizedListingDoc[]>([]);
  readonly scopedLiveFirstPage = computed(() => this.filterByBusiness(this.liveFirstPage()));
  readonly liveFirstPageLoading = signal(false);
  private firstPageUnsub?: Unsubscribe;

  /**
   * Inicia un listener en tiempo real sobre la primera página de `needs_review`.
   * Útil para el badge de pendientes y la vista inicial del inbox.
   * Seguro llamarlo múltiples veces: solo abre un listener.
   */
  startListeningFirstPage(pageSize = 20): void {
    if (this.firstPageUnsub) return;

    this.liveFirstPageLoading.set(true);
    const q = query(
      this.colRef,
      where("workflow.status", "==", "needs_review"),
      where("business_id", "in", this.businessScope.availableBusinessIds()),
      orderBy("created_at", "desc"),
      limit(pageSize),
    );

    this.firstPageUnsub = onSnapshot(
      q,
      (snap) => {
        this.liveFirstPage.set(this.filterByBusiness(snap.docs.map((d) => d.data() as NormalizedListingDoc)));
        this.liveFirstPageLoading.set(false);
      },
      (error) => {
        console.error("[NormalizedListingsService] onSnapshot error:", error);
        this.liveFirstPageLoading.set(false);
      },
    );
  }

  stopListeningFirstPage(): void {
    this.firstPageUnsub?.();
    this.firstPageUnsub = undefined;
  }

  private async listByWorkflowStatus(
    status: WorkflowStatus,
    pageSize = 20,
    cursor?: QueryDocumentSnapshot<DocumentData> | null
  ): Promise<ListPage<NormalizedListingDoc>> {
    const fetchSize = Math.max(1, pageSize) + 1;
    let q = query(
      this.colRef,
      where("workflow.status", "==", status),
      where("business_id", "in", this.businessScope.availableBusinessIds()),
      orderBy("created_at", "desc"),
      limit(fetchSize)
    );

    if (cursor) {
      q = query(q, startAfter(cursor));
    }

    const snap = await getDocs(q);
    const hasMore = snap.docs.length > pageSize;
    const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
    const docs = this.filterByBusiness(pageDocs.map((d) => d.data() as NormalizedListingDoc));
    const nextCursor = hasMore && pageDocs.length ? pageDocs[pageDocs.length - 1] : null;

    return { docs, nextCursor };
  }

  private filterByBusiness<T extends { business_id?: "bm" | "catalogo" }>(rows: T[]): T[] {
    const active = this.businessScope.activeBusinessIds();
    return rows.filter((row) => active.includes(normalizeBusinessId(row.business_id)));
  }

  async listNeedsReview(
    pageSize = 20,
    cursor?: QueryDocumentSnapshot<DocumentData> | null
  ): Promise<ListPage<NormalizedListingDoc>> {
    return this.listByWorkflowStatus("needs_review", pageSize, cursor);
  }

  async listValidated(
    pageSize = 50,
    cursor?: QueryDocumentSnapshot<DocumentData> | null
  ): Promise<ListPage<NormalizedListingDoc>> {
    return this.listByWorkflowStatus("validated", pageSize, cursor);
  }

  private static readonly ALL_VALIDATED_TTL_MS = 5 * 60_000;
  private static readonly ALL_VALIDATED_PAGE_SIZE = 300;
  private static readonly ALL_VALIDATED_MAX_PAGES = 40;

  private allValidatedCache = new Map<BusinessId, { rows: NormalizedListingDoc[]; at: number }>();
  private allValidatedInFlight = new Map<BusinessId, Promise<NormalizedListingDoc[]>>();

  /**
   * Trae TODOS los listings validados de un negocio, paginando con cursor.
   *
   * Reemplaza a `listValidated(n)` en las pantallas que filtran en memoria. Con una
   * sola pagina los productos mas antiguos quedaban fuera del buscador: BM tenia 131
   * validados contra un tope de 120 en pedido-detalle, asi que los 11 mas viejos eran
   * invisibles por mas que se escribiera su nombre completo.
   *
   * El resultado se cachea por negocio y las llamadas concurrentes comparten la misma
   * promesa, para que abrir un pedido no vuelva a descargar el catalogo.
   */
  async loadAllValidated(
    businessId: BusinessId = "bm",
    options: { force?: boolean } = {},
  ): Promise<NormalizedListingDoc[]> {
    const scope = normalizeBusinessId(businessId);
    if (!this.businessScope.availableBusinessIds().includes(scope)) return [];

    const cached = this.allValidatedCache.get(scope);
    const fresh = cached && Date.now() - cached.at < NormalizedListingsService.ALL_VALIDATED_TTL_MS;
    if (!options.force && fresh) return cached.rows;

    const inFlight = this.allValidatedInFlight.get(scope);
    if (inFlight) return inFlight;

    const request = (async () => {
      const seen = new Set<string>();
      const rows: NormalizedListingDoc[] = [];
      let cursor: QueryDocumentSnapshot<DocumentData> | null | undefined;

      for (let page = 0; page < NormalizedListingsService.ALL_VALIDATED_MAX_PAGES; page += 1) {
        const result = await this.listValidatedForBusiness(scope, cursor);
        for (const row of result.docs) {
          if (!row?.normalized_id || seen.has(row.normalized_id)) continue;
          seen.add(row.normalized_id);
          rows.push(row);
        }
        // Cortar por cursor y no por docs.length: una pagina puede venir vacia
        // sin que la coleccion se haya agotado.
        cursor = result.nextCursor;
        if (!cursor) break;
      }

      this.allValidatedCache.set(scope, { rows, at: Date.now() });
      return rows;
    })().finally(() => {
      this.allValidatedInFlight.delete(scope);
    });

    this.allValidatedInFlight.set(scope, request);
    return request;
  }

  /** Invalida el cache de `loadAllValidated` tras editar o validar un listing. */
  invalidateAllValidated(businessId?: BusinessId): void {
    if (!businessId) {
      this.allValidatedCache.clear();
      return;
    }
    this.allValidatedCache.delete(normalizeBusinessId(businessId));
  }

  private async listValidatedForBusiness(
    businessId: BusinessId,
    cursor?: QueryDocumentSnapshot<DocumentData> | null,
  ): Promise<ListPage<NormalizedListingDoc>> {
    const pageSize = NormalizedListingsService.ALL_VALIDATED_PAGE_SIZE;
    let q = query(
      this.colRef,
      where("business_id", "==", businessId),
      where("workflow.status", "==", "validated"),
      orderBy("created_at", "desc"),
      limit(pageSize + 1),
    );
    if (cursor) q = query(q, startAfter(cursor));

    const snap = await getDocs(q);
    const hasMore = snap.docs.length > pageSize;
    const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;

    return {
      docs: pageDocs.map((entry) => entry.data() as NormalizedListingDoc),
      nextCursor: hasMore && pageDocs.length ? pageDocs[pageDocs.length - 1] : null,
    };
  }

  async findValidatedByVariantSku(sku: string, businessId: BusinessId = "bm", pageSize = 8): Promise<NormalizedListingDoc[]> {
    const normalizedSku = this.normalizeSku(sku);
    if (!normalizedSku) return [];
    const snap = await getDocs(query(
      this.colRef,
      where("business_id", "==", normalizeBusinessId(businessId)),
      where("workflow.status", "==", "validated"),
      where("variant_skus_normalized", "array-contains", normalizedSku),
      limit(Math.max(1, Math.min(pageSize, 20))),
    ));
    return this.filterByBusiness(snap.docs.map((d) => d.data() as NormalizedListingDoc));
  }

  async getById(id: string): Promise<NormalizedListingDoc> {
    const ref = doc(this.colRef, id);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Not found");
    return snap.data() as NormalizedListingDoc;
  }

  async getRawPostImageUrls(rawPostId: string): Promise<string[]> {
    const cleanId = rawPostId.trim();
    if (!cleanId) return [];

    const snap = await getDoc(doc(FIRESTORE, "raw_posts", cleanId));
    if (!snap.exists()) return [];

    const rawPost = snap.data() as Partial<RawPost>;
    return (rawPost.media?.images || [])
      .map((image) => String(image?.url || "").trim())
      .filter((url): url is string => Boolean(url));
  }

  async updateListing(id: string, patch: PartialNormalizedUpdate): Promise<void> {
    const ref = doc(this.colRef, id);
    const skuPatch = patch.listing
      ? { variant_skus_normalized: this.variantSkuIndexFromListing(patch.listing) }
      : {};
    await updateDoc(ref, {
      ...(patch as any),
      ...skuPatch,
      updated_at: serverTimestamp(),
    });
  }

  variantSkuIndexFromListing(listing: NormalizedListingDoc["listing"] | NormalizedListingDocV3["listing"] | null | undefined): string[] {
    const items = Array.isArray(listing?.items) ? listing.items : [];
    const skus = new Set<string>();
    for (const item of items as unknown as Array<Record<string, unknown>>) {
      const sku = this.normalizeSku(item["sku"]);
      if (sku) skus.add(sku);
    }
    return [...skus].slice(0, 500);
  }

  normalizeSku(value: unknown): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  async updateReview(id: string, patch: ReviewPatch) {
    await setDoc(
      doc(FIRESTORE, "normalized_listings", id),
      {
        review: {
          ...patch,
          edited_at: serverTimestamp(),
        },
      },
      { merge: true }
    );
  }

  /**
   * Persiste la edicion humana y, opcionalmente, publica el listing en una
   * sola escritura. Asi el estado "validated" nunca puede quedar separado
   * de los datos que el usuario acaba de revisar.
   */
  async saveReviewDecision(
    id: string,
    patch: PartialNormalizedUpdate,
    reviewPatch: ReviewPatch,
    options: {
      businessId?: BusinessId | null;
      validatedBy?: string | null;
    } = {},
  ): Promise<void> {
    const ref = doc(this.colRef, id);
    const skuPatch = patch.listing
      ? { variant_skus_normalized: this.variantSkuIndexFromListing(patch.listing) }
      : {};
    const update: Record<string, unknown> = {
      ...patch,
      ...skuPatch,
      "review.edited_at": serverTimestamp(),
      updated_at: serverTimestamp(),
    };

    if (reviewPatch.preview_image_url !== undefined) {
      update["review.preview_image_url"] = reviewPatch.preview_image_url;
    }
    if (reviewPatch.excluded_image_urls !== undefined) {
      update["review.excluded_image_urls"] = reviewPatch.excluded_image_urls;
    }
    if (reviewPatch.edited_by !== undefined) {
      update["review.edited_by"] = reviewPatch.edited_by;
    }

    if (options.validatedBy) {
      update["business_id"] = normalizeBusinessId(options.businessId || "bm");
      update["workflow.status"] = "validated";
      update["workflow.validated_by"] = options.validatedBy;
      update["workflow.validated_at"] = serverTimestamp();
    }

    await updateDoc(ref, update);
  }

  async validate(id: string, uid: string): Promise<void> {
    const ref = doc(this.colRef, id);
    const snap = await getDoc(ref);
    const current = snap.exists() ? snap.data() as NormalizedListingDoc : null;
    await updateDoc(ref, {
      business_id: normalizeBusinessId(current?.business_id || "bm"),
      "workflow.status": "validated",
      "workflow.validated_by": uid,
      "workflow.validated_at": serverTimestamp(),
      ...(current?.listing ? { variant_skus_normalized: this.variantSkuIndexFromListing(current.listing) } : {}),
    } as any);
  }

  /**
   * Rechaza un listing (no lo borra, solo marca como rejected)
   * Mantiene trazabilidad segun principios del sistema.
   */
  async reject(id: string, uid: string): Promise<void> {
    const ref = doc(this.colRef, id);
    await updateDoc(ref, {
      "workflow.status": "rejected",
      "workflow.validated_by": uid,
      "workflow.validated_at": serverTimestamp(),
    } as any);
  }
}
