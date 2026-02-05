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
} from "firebase/firestore";

export interface InventoryItem {
  inventory_id: string;
  title: string;
  sku?: string;
  category_hint: string | null;
  supplier_id: string | null;
  variant_name: string | null;
  color_name: string | null;
  size_label: string | null;
  quantity_on_hand: number;
  unit_price: number | null;
  notes: string | null;
  image_urls: string[];
  source_reason: "devolucion" | "ajuste_manual";
  created_at?: any;
  updated_at?: any;
}

@Injectable({ providedIn: "root" })
export class InventoryService {
  private colRef = collection(FIRESTORE, "inventory_items");

  items = signal<InventoryItem[]>([]);

  async loadFromFirestore(): Promise<void> {
    const q = query(this.colRef, orderBy("updated_at", "desc"));
    const snapshot = await getDocs(q);

    const rows = snapshot.docs.map((entry) => {
      const data = entry.data() as Partial<InventoryItem>;
      return this.normalizeItem(data, entry.id);
    });

    this.items.set(rows);
  }

  async save(item: InventoryItem): Promise<string> {
    const itemId = (item.inventory_id || "").trim() || this.buildInventoryId(item.title);
    const now = serverTimestamp();

    const payload: InventoryItem = {
      ...item,
      inventory_id: itemId,
      title: (item.title || "").trim(),
      sku: (item.sku || this.generateSku(item.title)).trim(),
      category_hint: item.category_hint || null,
      supplier_id: item.supplier_id || null,
      variant_name: item.variant_name || null,
      color_name: item.color_name || null,
      size_label: item.size_label || null,
      quantity_on_hand: this.toSafeQty(item.quantity_on_hand),
      unit_price: this.toSafePrice(item.unit_price),
      notes: item.notes || null,
      image_urls: Array.isArray(item.image_urls) ? item.image_urls.filter(Boolean) : [],
      source_reason: item.source_reason || "devolucion",
      created_at: item.created_at ?? now,
      updated_at: now,
    };

    await setDoc(doc(this.colRef, itemId), payload, { merge: true });
    await this.loadFromFirestore();
    return itemId;
  }

  async delete(itemId: string): Promise<void> {
    await deleteDoc(doc(this.colRef, itemId));
    await this.loadFromFirestore();
  }

  async adjustQuantity(itemId: string, delta: number): Promise<void> {
    const current = this.items().find((item) => item.inventory_id === itemId);
    if (!current) return;

    const nextQty = this.toSafeQty(current.quantity_on_hand + delta);
    await updateDoc(doc(this.colRef, itemId), {
      quantity_on_hand: nextQty,
      updated_at: serverTimestamp(),
    });

    await this.loadFromFirestore();
  }

  generateSku(title: string): string {
    const base = this.slugify(title).slice(0, 8).toUpperCase() || "INV";
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `INV-${base}-${suffix}`;
  }

  private normalizeItem(data: Partial<InventoryItem>, fallbackId: string): InventoryItem {
    const title = (data.title || "Producto sin nombre").trim();

    return {
      inventory_id: data.inventory_id || fallbackId,
      title,
      sku: (data.sku || this.generateSku(title)).trim(),
      category_hint: data.category_hint || null,
      supplier_id: data.supplier_id || null,
      variant_name: data.variant_name || null,
      color_name: data.color_name || null,
      size_label: data.size_label || null,
      quantity_on_hand: this.toSafeQty(data.quantity_on_hand),
      unit_price: this.toSafePrice(data.unit_price),
      notes: data.notes || null,
      image_urls: Array.isArray(data.image_urls) ? data.image_urls.filter(Boolean) : [],
      source_reason: data.source_reason || "devolucion",
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  private buildInventoryId(title: string): string {
    const base = this.slugify(title) || "inventario";
    const suffix = Date.now().toString(36);
    return `${base}-${suffix}`;
  }

  private slugify(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private toSafeQty(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.round(n));
  }

  private toSafePrice(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Number(n.toFixed(2)));
  }
}
