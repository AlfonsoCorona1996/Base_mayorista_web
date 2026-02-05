import { Injectable } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  startAfter,
  QueryDocumentSnapshot,
  DocumentData,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type {
  NormalizedListingDoc,
  ListPage,
  ReviewPatch,
  PartialNormalizedUpdate,
  StockState,
  WorkflowStatus,
} from "./firestore-contracts";

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

  private async listByWorkflowStatus(
    status: WorkflowStatus,
    pageSize = 20,
    cursor?: QueryDocumentSnapshot<DocumentData> | null
  ): Promise<ListPage<NormalizedListingDoc>> {
    let q = query(
      this.colRef,
      where("workflow.status", "==", status),
      orderBy("created_at", "desc"),
      limit(pageSize)
    );

    if (cursor) {
      q = query(q, startAfter(cursor));
    }

    const snap = await getDocs(q);
    const docs = snap.docs.map((d) => d.data() as NormalizedListingDoc);
    const nextCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;

    return { docs, nextCursor };
  }

  async listNeedsReview(
    pageSize = 20,
    cursor?: QueryDocumentSnapshot<DocumentData> | null
  ): Promise<ListPage<NormalizedListingDoc>> {
    return this.listByWorkflowStatus("needs_review", pageSize, cursor);
  }

  async listValidated(
    pageSize = 20,
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
