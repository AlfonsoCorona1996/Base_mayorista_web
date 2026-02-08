import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

export interface Locality {
  locality_id: string;
  name: string;
  active: boolean;
  notes?: string;
  created_at?: any;
  updated_at?: any;
}

@Injectable({ providedIn: "root" })
export class LocalitiesService {
  private colRef = collection(FIRESTORE, "localities");
  localities = signal<Locality[]>([]);

  async loadFromFirestore(): Promise<void> {
    const q = query(this.colRef, orderBy("name", "asc"));
    const snap = await getDocs(q);

    const rows = snap.docs.map((entry) => {
      const data = entry.data() as Partial<Locality>;
      return this.normalizeLocality(data, entry.id);
    });

    this.localities.set(rows);
  }

  getActive(): Locality[] {
    return this.localities().filter((locality) => locality.active);
  }

  getById(id: string): Locality | null {
    return this.localities().find((locality) => locality.locality_id === id) || null;
  }

  async save(locality: Locality): Promise<void> {
    const localityId = (locality.locality_id || "").trim();
    if (!localityId) throw new Error("locality_id requerido");

    const now = serverTimestamp();
    const payload: Locality = {
      ...locality,
      locality_id: localityId,
      name: (locality.name || localityId).trim(),
      active: locality.active ?? true,
      created_at: locality.created_at ?? now,
      updated_at: now,
      notes: locality.notes || "",
    };

    await setDoc(doc(this.colRef, localityId), payload, { merge: true });
    await this.loadFromFirestore();
  }

  async setActive(localityId: string, active: boolean): Promise<void> {
    await updateDoc(doc(this.colRef, localityId), {
      active,
      updated_at: serverTimestamp(),
    });
    await this.loadFromFirestore();
  }

  private normalizeLocality(data: Partial<Locality>, fallbackId: string): Locality {
    const localityId = (data.locality_id || fallbackId || "").trim();
    return {
      locality_id: localityId,
      name: (data.name || localityId).trim(),
      active: data.active ?? true,
      notes: data.notes || "",
      created_at: data.created_at ?? null,
      updated_at: data.updated_at ?? null,
    };
  }
}
