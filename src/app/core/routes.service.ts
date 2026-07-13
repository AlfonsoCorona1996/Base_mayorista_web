import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

export interface RoutePlan {
  route_id: string;
  name: string;
  locality_ids: string[];
  active: boolean;
  estimated_run_expense?: number | null;
  estimated_run_expense_notes?: string | null;
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
      estimated_run_expense: this.toSafeAmount(route.estimated_run_expense),
      estimated_run_expense_notes: this.toOptionalText(route.estimated_run_expense_notes),
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
      estimated_run_expense: this.toSafeAmount(data.estimated_run_expense),
      estimated_run_expense_notes: this.toOptionalText(data.estimated_run_expense_notes),
      notes: data.notes || "",
      created_at: data.created_at ?? null,
      updated_at: data.updated_at ?? null,
    };
  }

  private toSafeAmount(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Number(parsed.toFixed(2)));
  }

  private toOptionalText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  }
}
