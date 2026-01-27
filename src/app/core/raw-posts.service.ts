import { Injectable } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { doc, getDoc, updateDoc } from "firebase/firestore";

export type RawPost = {
  raw_post_id: string;
  created_at?: any;
  message?: {
    raw_text?: string;
  };
  media?: {
    images?: Array<{
      media_id?: string;
      url?: string; // 👈 tu URL pública (token)
      content_type?: string;
    }>;
  };
};

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

    const data: any = snap.data();
    const imgs: any[] = data?.media?.images ?? [];

    const nextImgs = imgs.filter((x) => x?.url !== url);

    await updateDoc(ref, {
      "media.images": nextImgs,
      updated_at: new Date(),
    });
  }

}
