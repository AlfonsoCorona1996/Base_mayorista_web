import { Injectable } from "@angular/core";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";

@Injectable({ providedIn: "root" })
export class AuditService {
  async log(action: string, meta: Record<string, any> = {}) {
    const user = FIREBASE_AUTH.currentUser;
    await addDoc(collection(FIRESTORE, "audit_logs"), {
      action,
      meta,
      actor_uid: user?.uid || null,
      actor_email: user?.email || null,
      created_at: serverTimestamp(),
    }).catch(() => null);
  }
}
