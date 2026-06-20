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
  ListPage,
  ReviewPatch,
  PartialNormalizedUpdate,
  StockState,
  WorkflowStatus,
} from "./firestore-contracts";
import { BusinessScopeService } from "./business-scope.service";
import { normalizeBusinessId } from "./rbac.constants";

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

  async getById(id: string): Promise<NormalizedListingDoc> {
    const ref = doc(this.colRef, id);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Not found");
    return snap.data() as NormalizedListingDoc;
  }

  async updateListing(id: string, patch: PartialNormalizedUpdate): Promise<void> {
    const ref = doc(this.colRef, id);
    await updateDoc(ref, {
      ...(patch as any),
      updated_at: serverTimestamp(),
    });
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

  async validate(id: string, uid: string): Promise<void> {
    const ref = doc(this.colRef, id);
    await updateDoc(ref, {
      "workflow.status": "validated",
      "workflow.validated_by": uid,
      "workflow.validated_at": serverTimestamp(),
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
