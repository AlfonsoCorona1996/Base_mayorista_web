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
    deleteDoc,
} from "firebase/firestore";

export type StockState = "in_stock" | "last_pair" | "unknown_qty";

export type NormalizedListingDoc = {
  normalized_id: string;
  raw_post_id: string;
  schema_version: string;

  preview_image_url?: string | null;
  excluded_image_urls?: string[]; // opcional

  created_at?: any;
  updated_at?: any;

  supplier_id?: string | null;

  listing: {
    title: string | null;
    category_hint: string | null;
    price_tiers_global: any[];
    items: any[];
  };

  workflow: {
    status: "needs_review" | "validated" | "deleted";
    validated_by: string | null;
    validated_at: any | null;
  };
};

export type ListPage<T> = {
  docs: T[];
  nextCursor: any | null; // QueryDocumentSnapshot | null si quieres tiparlo más estricto
};




export interface ReviewPatch {
    preview_image_url?: string | null;
    excluded_image_urls?: string[];
    edited_by?: string | null;
}

export type PartialNormalizedUpdate = Partial<Pick<
  NormalizedListingDoc,
  "supplier_id" | "preview_image_url" | "excluded_image_urls" | "listing"
>>;


@Injectable({ providedIn: "root" })
export class NormalizedListingsService {
  private colRef = collection(FIRESTORE, "normalized_listings");

async listNeedsReview(pageSize = 20): Promise<ListPage<NormalizedListingDoc>> {
    const q = query(
      this.colRef,
      where("workflow.status", "==", "needs_review"),
      orderBy("created_at", "desc"),
      limit(pageSize)
    );
    const snap = await getDocs(q);
  const docs = snap.docs.map(d => d.data() as NormalizedListingDoc);
  const nextCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;

  return { docs, nextCursor };
  }









  async getById(id: string): Promise<NormalizedListingDoc> {
    const ref = doc(this.colRef, id);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Not found");
    return snap.data() as NormalizedListingDoc;
  }

  async updateListing(id: string, patch: PartialNormalizedUpdate): Promise<void> {
    const ref = doc(this.colRef, id);
    await updateDoc(ref, patch as any);
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
      "workflow.validated_at": new Date(),
    } as any);
  }


  async discard(id: string): Promise<void> {
    const ref = doc(this.colRef, id);
    await deleteDoc(ref);
  }
}
