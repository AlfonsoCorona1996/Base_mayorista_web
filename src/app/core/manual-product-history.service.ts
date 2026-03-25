import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

export interface ManualProductEntry {
  id: string;
  title: string;
  variant: string;
  color: string;
  price_clienta: number | null;
  price_cost: number | null;
  used_count: number;
  last_used_at: string;
  created_at: string;
}

@Injectable({ providedIn: "root" })
export class ManualProductHistoryService {
  private colRef = collection(FIRESTORE, "manual_product_suggestions");

  readonly entries = signal<ManualProductEntry[]>([]);
  readonly loading = signal(false);

  async load(): Promise<void> {
    this.loading.set(true);
    const q = query(this.colRef, orderBy("used_count", "desc"), orderBy("last_used_at", "desc"));
    const snap = await getDocs(q);
    const rows = snap.docs.map(d => this.normalize(d.id, d.data()));
    this.entries.set(rows);
    this.loading.set(false);
  }

  /**
   * Busca sugerencias que coincidan con el texto escrito (insensible a mayúsculas).
   * Retorna máximo 8 resultados.
   */
  search(query: string): ManualProductEntry[] {
    const q = query.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return this.entries()
      .filter(e => e.title.toLowerCase().includes(q))
      .slice(0, 8);
  }

  /**
   * Registra un producto manual como usado (crea o actualiza el historial).
   * Llama esto justo después de confirmar un item manual exitosamente.
   */
  async record(entry: Pick<ManualProductEntry, "title" | "variant" | "color" | "price_clienta" | "price_cost">): Promise<void> {
    const title = entry.title?.trim();
    if (!title) return;

    // Buscar si ya existe una entrada con el mismo título normalizado
    const normalized = title.toLowerCase();
    const existing = this.entries().find(e => e.title.toLowerCase() === normalized);

    const now = new Date().toISOString();

    if (existing) {
      // Actualizar contador de uso
      const ref = doc(this.colRef, existing.id);
      await updateDoc(ref, {
        used_count: existing.used_count + 1,
        last_used_at: serverTimestamp(),
        // Actualizar precio si cambió
        price_clienta: entry.price_clienta ?? existing.price_clienta,
        price_cost: entry.price_cost ?? existing.price_cost,
        variant: entry.variant || existing.variant,
        color: entry.color || existing.color,
      });
      this.entries.update(rows => rows.map(r =>
        r.id === existing.id
          ? { ...r, used_count: r.used_count + 1, last_used_at: now, ...entry }
          : r
      ));
    } else {
      // Crear nueva entrada
      const id = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newEntry: ManualProductEntry = {
        id,
        title: title,
        variant: entry.variant || "",
        color: entry.color || "",
        price_clienta: entry.price_clienta ?? null,
        price_cost: entry.price_cost ?? null,
        used_count: 1,
        last_used_at: now,
        created_at: now,
      };
      await setDoc(doc(this.colRef, id), {
        ...newEntry,
        last_used_at: serverTimestamp(),
        created_at: serverTimestamp(),
      });
      this.entries.update(rows => [newEntry, ...rows]);
    }
  }

  async delete(id: string): Promise<void> {
    await deleteDoc(doc(this.colRef, id));
    this.entries.update(rows => rows.filter(r => r.id !== id));
  }

  private normalize(id: string, data: any): ManualProductEntry {
    return {
      id,
      title:         String(data.title ?? ""),
      variant:       String(data.variant ?? ""),
      color:         String(data.color ?? ""),
      price_clienta: data.price_clienta != null ? Number(data.price_clienta) : null,
      price_cost:    data.price_cost != null ? Number(data.price_cost) : null,
      used_count:    Number(data.used_count ?? 1),
      last_used_at:  data.last_used_at?.toDate?.()?.toISOString?.() ?? data.last_used_at ?? "",
      created_at:    data.created_at?.toDate?.()?.toISOString?.() ?? data.created_at ?? "",
    };
  }
}
