import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

export interface RoutePlan {
  route_id: string;
  name: string;
  locality_ids: string[];
  active: boolean;
  notes?: string;
  created_at?: any;
  updated_at?: any;
}

@Injectable({ providedIn: "root" })
export class RoutesService {
  private colRef = collection(FIRESTORE, "routes");
  routes = signal<RoutePlan[]>([]);

  async loadFromFirestore(): Promise<void> {
    const q = query(this.colRef, orderBy("name", "asc"));
    const snap = await getDocs(q);

    const rows = snap.docs.map((entry) => {
      const data = entry.data() as Partial<RoutePlan>;
      return this.normalizeRoute(data, entry.id);
    });

    this.routes.set(rows);
  }

  getActive(): RoutePlan[] {
    return this.routes().filter((route) => route.active);
  }

  getById(id: string): RoutePlan | null {
    return this.routes().find((route) => route.route_id === id) || null;
  }

  async save(route: RoutePlan): Promise<void> {
    const routeId = (route.route_id || "").trim();
    if (!routeId) throw new Error("route_id requerido");

    const now = serverTimestamp();
    const payload: RoutePlan = {
      ...route,
      route_id: routeId,
      name: (route.name || routeId).trim(),
      locality_ids: Array.isArray(route.locality_ids) ? route.locality_ids.filter(Boolean) : [],
      active: route.active ?? true,
      created_at: route.created_at ?? now,
      updated_at: now,
      notes: route.notes || "",
    };

    await setDoc(doc(this.colRef, routeId), payload, { merge: true });
    await this.loadFromFirestore();
  }

  async setActive(routeId: string, active: boolean): Promise<void> {
    await updateDoc(doc(this.colRef, routeId), {
      active,
      updated_at: serverTimestamp(),
    });
    await this.loadFromFirestore();
  }

  private normalizeRoute(data: Partial<RoutePlan>, fallbackId: string): RoutePlan {
    const routeId = (data.route_id || fallbackId || "").trim();
    return {
      route_id: routeId,
      name: (data.name || routeId).trim(),
      locality_ids: Array.isArray(data.locality_ids) ? data.locality_ids.filter(Boolean) : [],
      active: data.active ?? true,
      notes: data.notes || "",
      created_at: data.created_at ?? null,
      updated_at: data.updated_at ?? null,
    };
  }
}
