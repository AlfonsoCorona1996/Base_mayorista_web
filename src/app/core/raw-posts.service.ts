import { Injectable } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import type { RawPost } from "./firestore-contracts";

// Re-exportar tipo para compatibilidad
export type { RawPost };

@Injectable({ providedIn: "root" })
export class RawPostsService {

  async getById(rawPostId: string) {
    const snap = await getDoc(doc(FIRESTORE, "raw_posts", rawPostId));
    if (!snap.exists()) return null;
    return snap.data() as RawPost;
  }


  async removeImageUrl(rawPostId: string, url: string) {
    const ref = doc(FIRESTORE, "raw_posts", rawPostId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("RAW post no existe");

    const data = snap.data() as RawPost;
    const imgs = data?.media?.images ?? [];

    const nextImgs = imgs.filter((x) => x?.url !== url);

    await updateDoc(ref, {
      "media.images": nextImgs,
    } as any);
  }

}
