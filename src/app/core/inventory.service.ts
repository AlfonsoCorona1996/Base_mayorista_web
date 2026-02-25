import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
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
  // Backward-compatible field used by current UI cards as available stock.
  quantity_on_hand: number;
  on_hand_qty?: number;
  reserved_qty?: number;
  available_qty?: number;
  unit_price: number | null;
  notes: string | null;
  image_urls: string[];
  source_reason: "devolucion" | "ajuste_manual";
  reservations?: Record<string, InventoryReservation>;
  idempotency_keys?: Record<string, string>;
  created_at?: any;
  updated_at?: any;
}

export interface InventoryReservation {
  qty: number;
  order_number: string;
  status: "reserved" | "released" | "consumed";
  updated_at: string;
}

export interface ReserveStockInput {
  sku: string;
  qty: number;
  orderId: string;
  orderItemId: string;
  idempotencyKey: string;
}

export interface ReleaseReservationInput {
  sku: string;
  qty: number;
  orderId: string;
  orderItemId: string;
  idempotencyKey: string;
}

export interface ConsumeOnDeliveryInput {
  sku: string;
  qty: number;
  orderId: string;
  orderItemId: string;
  idempotencyKey: string;
}

export interface ReceiveInboundInput {
  sku: string;
  qty: number;
  supplierOperationId: string;
  lineId: string;
  idempotencyKey: string;
  title?: string;
  supplier_id?: string | null;
  variant_name?: string | null;
  color_name?: string | null;
  image_url?: string | null;
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

  async save(item: InventoryItem, idempotencyKey?: string): Promise<string> {
    const itemId = (item.inventory_id || "").trim() || this.buildInventoryId(item.title);
    const ref = doc(this.colRef, itemId);
    const idKey = idempotencyKey ? this.safeIdempotencyKey(idempotencyKey) : null;
    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? this.normalizeItem(snap.data() as Partial<InventoryItem>, snap.id) : null;
      const idMap = current?.idempotency_keys || {};
      if (idKey && idMap[idKey]) return;

      const onHand = this.toSafeQty(item.on_hand_qty ?? item.available_qty ?? item.quantity_on_hand);
      const reserved = this.toSafeQty(item.reserved_qty ?? 0);
      const available = this.toSafeQty(item.available_qty ?? onHand - reserved);
      const nowIso = new Date().toISOString();
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
        on_hand_qty: onHand,
        reserved_qty: reserved,
        available_qty: available,
        quantity_on_hand: available,
        unit_price: this.toSafePrice(item.unit_price),
        notes: item.notes || null,
        image_urls: Array.isArray(item.image_urls) ? item.image_urls.filter(Boolean) : [],
        source_reason: item.source_reason || "devolucion",
        reservations: this.normalizeReservations(item.reservations),
        created_at: current?.created_at ?? item.created_at ?? nowIso,
        updated_at: nowIso,
        idempotency_keys: this.withIdempotency(idMap, idKey, nowIso),
      };

      tx.set(ref, {
        ...payload,
        created_at: snap.exists() ? (snap.data() as any)["created_at"] ?? serverTimestamp() : serverTimestamp(),
        updated_at: serverTimestamp(),
      }, { merge: true });
    });
    await this.loadFromFirestore();
    return itemId;
  }

  async delete(itemId: string, idempotencyKey?: string): Promise<void> {
    const ref = doc(this.colRef, itemId);
    const idKey = idempotencyKey ? this.safeIdempotencyKey(idempotencyKey) : null;
    if (!idKey) {
      await deleteDoc(ref);
      await this.loadFromFirestore();
      return;
    }

    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data() as Record<string, any>;
      const idMap = (data["idempotency_keys"] || {}) as Record<string, string>;
      if (idMap[idKey]) return;
      tx.delete(ref);
    });
    await this.loadFromFirestore();
  }

  async adjustQuantity(itemId: string, delta: number, idempotencyKey?: string): Promise<void> {
    const ref = doc(this.colRef, itemId);
    const idKey = idempotencyKey ? this.safeIdempotencyKey(idempotencyKey) : null;
    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const row = this.normalizeItem(snap.data() as Partial<InventoryItem>, snap.id);
      if (idKey && row.idempotency_keys?.[idKey]) return;

      const currentOnHand = this.toSafeQty(row.on_hand_qty ?? row.available_qty ?? row.quantity_on_hand);
      const reserved = this.toSafeQty(row.reserved_qty ?? 0);
      const nextOnHand = Math.max(reserved, this.toSafeQty(currentOnHand + delta));
      const nextAvailable = this.toSafeQty(nextOnHand - reserved);
      const nowIso = new Date().toISOString();
      tx.update(ref, {
        on_hand_qty: nextOnHand,
        reserved_qty: reserved,
        available_qty: nextAvailable,
        quantity_on_hand: nextAvailable,
        updated_at: serverTimestamp(),
        idempotency_keys: this.withIdempotency(row.idempotency_keys || {}, idKey, nowIso),
      });
    });
    await this.loadFromFirestore();
  }

  async reserveStock(input: ReserveStockInput): Promise<void> {
    const inventoryId = (input.sku || "").trim();
    if (!inventoryId) throw new Error("sku requerido para reservar");
    const qty = this.toSafeQty(input.qty);
    const idKey = this.safeIdempotencyKey(input.idempotencyKey);
    const ref = doc(this.colRef, inventoryId);

    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error(`Inventario no encontrado para sku ${inventoryId}`);
      const row = this.normalizeItem(snap.data() as Partial<InventoryItem>, snap.id);
      if (row.idempotency_keys?.[idKey]) return;

      const onHand = this.toSafeQty(row.on_hand_qty ?? row.available_qty ?? row.quantity_on_hand);
      const reserved = this.toSafeQty(row.reserved_qty ?? 0);
      const available = this.toSafeQty(row.available_qty ?? onHand - reserved);
      const reservations = this.normalizeReservations(row.reservations);
      if (qty > available) {
        throw new Error(`Stock insuficiente para ${inventoryId}. Disponible ${available}, requerido ${qty}.`);
      }

      const nextReserved = reserved + qty;
      const nextAvailable = Math.max(0, onHand - nextReserved);
      const nextReservations = this.addReservation(reservations, input.orderId, qty);
      const nowIso = new Date().toISOString();
      tx.update(ref, {
        reserved_qty: nextReserved,
        available_qty: nextAvailable,
        quantity_on_hand: nextAvailable,
        reservations: nextReservations,
        updated_at: serverTimestamp(),
        idempotency_keys: this.withIdempotency(row.idempotency_keys || {}, idKey, nowIso),
      });
    });

    await this.loadFromFirestore();
  }

  async releaseReservation(input: ReleaseReservationInput): Promise<void> {
    const inventoryId = (input.sku || "").trim();
    if (!inventoryId) throw new Error("sku requerido para liberar reserva");
    const qty = this.toSafeQty(input.qty);
    const idKey = this.safeIdempotencyKey(input.idempotencyKey);
    const ref = doc(this.colRef, inventoryId);

    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const row = this.normalizeItem(snap.data() as Partial<InventoryItem>, snap.id);
      if (row.idempotency_keys?.[idKey]) return;

      const onHand = this.toSafeQty(row.on_hand_qty ?? row.available_qty ?? row.quantity_on_hand);
      const reserved = this.toSafeQty(row.reserved_qty ?? 0);
      const nextReserved = Math.max(0, reserved - qty);
      const nextAvailable = Math.max(0, onHand - nextReserved);
      const reservations = this.normalizeReservations(row.reservations);
      const nextReservations = this.removeReservation(reservations, input.orderId, qty);
      const nowIso = new Date().toISOString();
      tx.update(ref, {
        reserved_qty: nextReserved,
        available_qty: nextAvailable,
        quantity_on_hand: nextAvailable,
        reservations: nextReservations,
        updated_at: serverTimestamp(),
        idempotency_keys: this.withIdempotency(row.idempotency_keys || {}, idKey, nowIso),
      });
    });

    await this.loadFromFirestore();
  }

  async consumeOnDelivery(input: ConsumeOnDeliveryInput): Promise<void> {
    const inventoryId = (input.sku || "").trim();
    if (!inventoryId) throw new Error("sku requerido para consumo en entrega");
    const qty = this.toSafeQty(input.qty);
    const idKey = this.safeIdempotencyKey(input.idempotencyKey);
    const ref = doc(this.colRef, inventoryId);

    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const row = this.normalizeItem(snap.data() as Partial<InventoryItem>, snap.id);
      if (row.idempotency_keys?.[idKey]) return;

      const onHand = this.toSafeQty(row.on_hand_qty ?? row.available_qty ?? row.quantity_on_hand);
      const reserved = this.toSafeQty(row.reserved_qty ?? 0);
      const consumedQty = Math.min(qty, reserved, onHand);
      const nextOnHand = Math.max(0, onHand - consumedQty);
      const nextReserved = Math.max(0, reserved - consumedQty);
      const nextAvailable = Math.max(0, nextOnHand - nextReserved);
      const reservations = this.normalizeReservations(row.reservations);
      const nextReservations = this.removeReservation(reservations, input.orderId, consumedQty);
      const nowIso = new Date().toISOString();
      tx.update(ref, {
        on_hand_qty: nextOnHand,
        reserved_qty: nextReserved,
        available_qty: nextAvailable,
        quantity_on_hand: nextAvailable,
        reservations: nextReservations,
        updated_at: serverTimestamp(),
        idempotency_keys: this.withIdempotency(row.idempotency_keys || {}, idKey, nowIso),
      });
    });

    await this.loadFromFirestore();
  }

  async receiveInbound(input: ReceiveInboundInput): Promise<void> {
    const inventoryId = (input.sku || "").trim();
    if (!inventoryId) throw new Error("sku requerido para recepción");
    const qty = this.toSafeQty(input.qty);
    const idKey = this.safeIdempotencyKey(input.idempotencyKey);
    const ref = doc(this.colRef, inventoryId);

    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(ref);
      const nowIso = new Date().toISOString();

      if (!snap.exists()) {
        const onHand = qty;
        const reserved = 0;
        const available = onHand;
        const created: InventoryItem = {
          inventory_id: inventoryId,
          title: (input.title || "Producto sin nombre").trim(),
          sku: inventoryId,
          category_hint: null,
          supplier_id: input.supplier_id ?? null,
          variant_name: input.variant_name ?? null,
          color_name: input.color_name ?? null,
          size_label: null,
          quantity_on_hand: available,
          on_hand_qty: onHand,
          reserved_qty: reserved,
          available_qty: available,
          unit_price: null,
          notes: `Alta automática desde proveedor (${input.supplierOperationId}).`,
          image_urls: input.image_url ? [input.image_url] : [],
          source_reason: "ajuste_manual",
          reservations: {},
          created_at: nowIso,
          updated_at: nowIso,
          idempotency_keys: this.withIdempotency({}, idKey, nowIso),
        };
        tx.set(ref, { ...created, created_at: serverTimestamp(), updated_at: serverTimestamp() }, { merge: true });
        return;
      }

      const row = this.normalizeItem(snap.data() as Partial<InventoryItem>, snap.id);
      if (row.idempotency_keys?.[idKey]) return;

      const onHand = this.toSafeQty(row.on_hand_qty ?? row.available_qty ?? row.quantity_on_hand);
      const reserved = this.toSafeQty(row.reserved_qty ?? 0);
      const nextOnHand = onHand + qty;
      const nextAvailable = Math.max(0, nextOnHand - reserved);
      tx.update(ref, {
        on_hand_qty: nextOnHand,
        reserved_qty: reserved,
        available_qty: nextAvailable,
        quantity_on_hand: nextAvailable,
        updated_at: serverTimestamp(),
        idempotency_keys: this.withIdempotency(row.idempotency_keys || {}, idKey, nowIso),
      });
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
    const onHand = this.toSafeQty(data.on_hand_qty ?? data.available_qty ?? data.quantity_on_hand);
    const reserved = this.toSafeQty(data.reserved_qty ?? 0);
    const available = this.toSafeQty(data.available_qty ?? onHand - reserved);

    return {
      inventory_id: data.inventory_id || fallbackId,
      title,
      sku: (data.sku || this.generateSku(title)).trim(),
      category_hint: data.category_hint || null,
      supplier_id: data.supplier_id || null,
      variant_name: data.variant_name || null,
      color_name: data.color_name || null,
      size_label: data.size_label || null,
      on_hand_qty: onHand,
      reserved_qty: reserved,
      available_qty: available,
      quantity_on_hand: available,
      unit_price: this.toSafePrice(data.unit_price),
      notes: data.notes || null,
      image_urls: Array.isArray(data.image_urls) ? data.image_urls.filter(Boolean) : [],
      source_reason: data.source_reason || "devolucion",
      reservations: this.normalizeReservations(data.reservations),
      idempotency_keys: this.normalizeIdempotencyMap(data.idempotency_keys),
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

  private safeIdempotencyKey(raw: string): string {
    return String(raw || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 120);
  }

  private withIdempotency(source: Record<string, string>, key: string | null, nowIso: string): Record<string, string> {
    if (!key) return source;
    return {
      ...source,
      [key]: nowIso,
    };
  }

  private normalizeIdempotencyMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!k) continue;
      if (typeof v === "string") out[k] = v;
      else if (v instanceof Timestamp) out[k] = v.toDate().toISOString();
      else out[k] = String(v);
    }
    return out;
  }

  private normalizeReservations(value: unknown): Record<string, InventoryReservation> {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, InventoryReservation> = {};
    for (const [orderId, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!orderId || !raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const qty = this.toSafeQty(row["qty"]);
      if (qty <= 0) continue;
      const statusRaw = String(row["status"] || "reserved");
      const status: "reserved" | "released" | "consumed" =
        statusRaw === "released" || statusRaw === "consumed" ? statusRaw : "reserved";
      out[orderId] = {
        qty,
        order_number: String(row["order_number"] || orderId),
        status,
        updated_at: String(row["updated_at"] || new Date().toISOString()),
      };
    }
    return out;
  }

  private addReservation(
    source: Record<string, InventoryReservation>,
    orderId: string,
    qty: number,
  ): Record<string, InventoryReservation> {
    const key = (orderId || "").trim();
    if (!key || qty <= 0) return source;
    const nowIso = new Date().toISOString();
    const current = source[key];
    return {
      ...source,
      [key]: {
        qty: this.toSafeQty((current?.qty || 0) + qty),
        order_number: current?.order_number || key,
        status: "reserved",
        updated_at: nowIso,
      },
    };
  }

  private removeReservation(
    source: Record<string, InventoryReservation>,
    orderId: string,
    qty: number,
  ): Record<string, InventoryReservation> {
    const key = (orderId || "").trim();
    if (!key || qty <= 0) return source;
    const current = source[key];
    if (!current) return source;
    const remaining = this.toSafeQty(current.qty - qty);
    if (remaining <= 0) {
      const clone = { ...source };
      delete clone[key];
      return clone;
    }
    return {
      ...source,
      [key]: {
        ...current,
        qty: remaining,
        status: "reserved",
        updated_at: new Date().toISOString(),
      },
    };
  }
}
