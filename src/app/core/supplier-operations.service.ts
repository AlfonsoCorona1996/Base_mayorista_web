import { Injectable, computed, inject, signal } from "@angular/core";
import { InventoryService } from "./inventory.service";
import type { Order, OrderItem } from "./orders.service";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

export type SupplierOperationStatus = "por_levantar" | "levantado" | "en_camino" | "recibido";

export interface SupplierOperationRow {
  op_id: string;
  business_id: BusinessId;
  order_id: string;
  reserved_for_order_id: string;
  order_item_id: string;
  supplier_id: string;
  supplier_name: string | null;
  customer_id: string;
  customer_name: string;
  title: string;
  variant: string | null;
  color: string | null;
  image_url: string | null;
  quantity: number;
  product_id: string | null;
  status: SupplierOperationStatus;
  inventory_item_id: string | null;
  received_to_inventory: boolean;
  reservation_applied: boolean;
  received_qty: number;
  reserved_qty_for_order: number;
  idempotency_keys?: Record<string, string>;
  created_at: string;
  updated_at: string;
}

@Injectable({ providedIn: "root" })
export class SupplierOperationsService {
  private colRef = collection(FIRESTORE, "supplier_operations");
  private inventory = inject(InventoryService);
  private businessScope = inject(BusinessScopeService);

  private rowsSignal = signal<SupplierOperationRow[]>([]);

  rows = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rowsSignal().filter((row) => active.includes(row.business_id || "bm"));
  });

  async loadFromFirestore(): Promise<void> {
    const q = query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds()));
    const snap = await getDocs(q);
    const rows = snap.docs
      .map((entry) => this.normalize(entry.id, entry.data() as Record<string, any>))
      .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
    this.rowsSignal.set(rows);
  }

  async upsertFromConfirmedOrder(order: Order, customerName: string): Promise<number> {
    const toCreate = this.confirmedSupplierItems(order);
    if (toCreate.length === 0) return 0;

    const nowIso = new Date().toISOString();
    let createdOrUpdated = 0;

    for (const item of toCreate) {
      const supplierId = (item.supplier_id || "").trim();
      if (!supplierId) continue;

      const opId = this.buildOpId(order.order_id, item.item_id);
      const ref = doc(this.colRef, opId);
      const existingSnap = await getDoc(ref);
      const existing = existingSnap.exists()
        ? this.normalize(existingSnap.id, existingSnap.data() as Record<string, any>)
        : null;

      const payload: Partial<SupplierOperationRow> = {
        op_id: opId,
        business_id: normalizeBusinessId(order.business_id),
        order_id: order.order_id,
        reserved_for_order_id: order.order_id,
        order_item_id: item.item_id,
        supplier_id: supplierId,
        supplier_name: null,
        customer_id: order.customer_id,
        customer_name: (customerName || "").trim() || "Clienta",
        title: item.title || "Producto sin nombre",
        variant: item.variant || null,
        color: item.color || null,
        image_url: existing?.image_url || item.image_url || null,
        quantity: this.safeQty(item.confirmed_qty ?? item.quantity),
        product_id: item.product_id || null,
        status: existing?.status || "por_levantar",
        inventory_item_id: existing?.inventory_item_id || null,
        received_to_inventory: existing?.received_to_inventory || false,
        reservation_applied: existing?.reservation_applied || false,
        received_qty: existing?.received_qty ?? 0,
        reserved_qty_for_order: existing?.reserved_qty_for_order ?? 0,
        created_at: existing ? existing.created_at : nowIso,
        updated_at: nowIso,
      };

      await setDoc(
        ref,
        {
          ...payload,
          created_at: existing ? existing.created_at : serverTimestamp(),
          updated_at: serverTimestamp(),
        },
        { merge: true },
      );
      createdOrUpdated += 1;
    }

    await this.loadFromFirestore();
    return createdOrUpdated;
  }

  async updateStatus(opId: string, nextStatus: SupplierOperationStatus): Promise<void> {
    await this.updateLineState(opId, nextStatus);
  }

  async updateLineState(
    lineId: string,
    newState: SupplierOperationStatus,
    idempotencyKey?: string,
    options?: { reload?: boolean },
  ): Promise<void> {
    const reload = options?.reload !== false;

    let current = this.rowsSignal().find((row) => row.op_id === lineId) || null;
    if (!current) {
      const snap = await getDoc(doc(this.colRef, lineId));
      if (snap.exists()) {
        current = this.normalize(snap.id, snap.data() as Record<string, any>);
      }
    }
    if (!current) return;
    if (current.status === newState) return;

    if (newState === "recibido") {
      await this.receiveLineAndAllocate(lineId, idempotencyKey || `${lineId}:${newState}`);
      if (!reload) return;
      return;
    }

    await updateDoc(doc(this.colRef, lineId), {
      status: newState,
      updated_at: serverTimestamp(),
    });

    await this.syncOrderStatus(current.order_id);
    await this.logOrderEvent(current.order_id, "SUPPLIER_OP_STATUS_CHANGED", `Proveedor: ${lineId} -> ${newState}`, {
      opId: lineId,
      nextStatus: newState,
    });

    if (reload) {
      await this.loadFromFirestore();
    }
  }

  async receiveLineAndAllocate(lineId: string, idempotencyKey: string): Promise<void> {
    const opRef = doc(this.colRef, lineId);
    const safeRoot = this.safeIdempotencyKey(idempotencyKey || `supplier-receive-${lineId}`);
    const txKey = `tx_${safeRoot}`;

    const row = await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(opRef);
      if (!snap.exists()) throw new Error("Operacion de proveedor no encontrada");
      const current = this.normalize(snap.id, snap.data() as Record<string, any>);
      const idMap = current.idempotency_keys || {};
      if (!idMap[txKey]) {
        const nowIso = new Date().toISOString();
        tx.update(opRef, {
          status: "recibido",
          updated_at: serverTimestamp(),
          idempotency_keys: {
            ...idMap,
            [txKey]: nowIso,
          },
        });
      }
      return current;
    });

    const qty = this.safeQty(row.quantity);
    const inventoryId = row.inventory_item_id || this.buildInventoryIdForLine(row);

    await this.inventory.receiveInbound({
      sku: inventoryId,
      business_id: row.business_id,
      qty,
      supplierOperationId: row.op_id,
      lineId: row.order_item_id,
      idempotencyKey: `inbound_${safeRoot}`,
      title: row.title,
      supplier_id: row.supplier_id || null,
      variant_name: row.variant || null,
      color_name: row.color || null,
      image_url: row.image_url || null,
    });
    await this.logOrderEvent(row.order_id, "INVENTORY_INBOUND_RECEIVED", `Recepcion inventario para ${row.title}`, {
      opId: row.op_id,
      inventoryId,
      qty,
      idempotencyKey: `inbound_${safeRoot}`,
    });

    const reserveForOrderId = String(row.reserved_for_order_id || "").trim();
    const canReserveForOrder = !!reserveForOrderId && !!String(row.order_item_id || "").trim() && qty > 0;
    if (canReserveForOrder) {
      await this.inventory.reserveStock({
        sku: inventoryId,
        qty,
        orderId: reserveForOrderId,
        orderItemId: row.order_item_id,
        idempotencyKey: `reserve_${safeRoot}`,
      });
      await this.logOrderEvent(row.order_id, "INVENTORY_RESERVED", `Reserva inventario para ${row.title}`, {
        opId: row.op_id,
        inventoryId,
        qty,
        orderId: reserveForOrderId,
        idempotencyKey: `reserve_${safeRoot}`,
      });
    }

    const finalizeKey = `final_${safeRoot}`;
    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(opRef);
      if (!snap.exists()) return;
      const current = this.normalize(snap.id, snap.data() as Record<string, any>);
      const idMap = current.idempotency_keys || {};
      if (idMap[finalizeKey]) return;
      const nowIso = new Date().toISOString();
      tx.update(opRef, {
        status: "recibido",
        inventory_item_id: inventoryId,
        received_to_inventory: true,
        reservation_applied: canReserveForOrder && qty > 0,
        received_qty: qty,
        reserved_qty_for_order: canReserveForOrder ? qty : 0,
        updated_at: serverTimestamp(),
        idempotency_keys: {
          ...idMap,
          [finalizeKey]: nowIso,
        },
      });
    });

    await this.logOrderEvent(row.order_id, "SUPPLIER_LINE_RECEIVED", `Linea de proveedor recibida: ${row.title}`, {
      opId: row.op_id,
      inventoryId,
      qty,
      idempotencyKey: safeRoot,
    });
    await this.syncOrderStatus(row.order_id);
    await this.loadFromFirestore();
  }

  async removeByOrder(orderId: string): Promise<void> {
    const q = query(this.colRef, where("order_id", "==", orderId));
    const snap = await getDocs(q);
    const writes = snap.docs.map((entry) => deleteDoc(entry.ref));
    await Promise.all(writes);
    await this.loadFromFirestore();
  }

  async getByOrderItem(orderId: string, orderItemId: string): Promise<SupplierOperationRow | null> {
    const opId = this.buildOpId(orderId, orderItemId);
    return this.getByOpId(opId);
  }

  async detachLineFromOrder(
    opId: string,
    options?: { releaseReservation?: boolean; clearOrderItemLink?: boolean },
  ): Promise<void> {
    const row = await this.getByOpId(opId);
    if (!row) return;

    const releaseReservation = options?.releaseReservation !== false;
    if (releaseReservation) {
      await this.releaseReservationIfNeeded(row, "detach");
    }

    await updateDoc(doc(this.colRef, opId), {
      reserved_for_order_id: "",
      reservation_applied: false,
      reserved_qty_for_order: 0,
      order_item_id: options?.clearOrderItemLink ? "" : row.order_item_id,
      updated_at: serverTimestamp(),
    });

    await this.logOrderEvent(row.order_id, "SUPPLIER_OP_DETACHED_ORDER", `Linea proveedor separada del pedido: ${row.title}`, {
      opId: row.op_id,
      status: row.status,
      supplierId: row.supplier_id,
    });

    await this.syncOrderStatus(row.order_id);
    await this.loadFromFirestore();
  }

  async deleteLine(
    opId: string,
    options?: { releaseReservation?: boolean; rollbackReceivedInventory?: boolean },
  ): Promise<void> {
    const row = await this.getByOpId(opId);
    if (!row) return;

    const releaseReservation = options?.releaseReservation !== false;
    if (releaseReservation) {
      await this.releaseReservationIfNeeded(row, "delete");
    }
    if (options?.rollbackReceivedInventory) {
      await this.rollbackReceivedInventoryIfNeeded(row, "delete");
    }

    await deleteDoc(doc(this.colRef, opId));
    await this.logOrderEvent(row.order_id, "SUPPLIER_OP_DELETED", `Linea proveedor eliminada: ${row.title}`, {
      opId: row.op_id,
      status: row.status,
      supplierId: row.supplier_id,
      rollbackReceivedInventory: options?.rollbackReceivedInventory === true,
    });
    await this.syncOrderStatus(row.order_id);
    await this.loadFromFirestore();
  }

  private confirmedSupplierItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => {
      if (item.source === "inventario") return false;
      if (!item.supplier_id) return false;
      return item.confirmation_state === "confirmed";
    });
  }

  private safeQty(value: unknown): number {
    const qty = Number(value || 0);
    if (!Number.isFinite(qty)) return 0;
    return Math.max(0, Math.round(qty));
  }

  private async getByOpId(opId: string): Promise<SupplierOperationRow | null> {
    if (!opId) return null;
    const cached = this.rowsSignal().find((row) => row.op_id === opId) || null;
    if (cached) return cached;

    const snap = await getDoc(doc(this.colRef, opId));
    if (!snap.exists()) return null;
    return this.normalize(snap.id, snap.data() as Record<string, any>);
  }

  private async releaseReservationIfNeeded(row: SupplierOperationRow, reason: string): Promise<void> {
    const inventoryId = (row.inventory_item_id || "").trim();
    const orderId = (row.reserved_for_order_id || row.order_id || "").trim();
    const qty = this.safeQty(row.reserved_qty_for_order || (row.reservation_applied ? row.quantity : 0));
    if (!inventoryId || !orderId || qty <= 0) return;

    const idKey = this.safeIdempotencyKey(`supplier_release_${row.op_id}_${reason}`);
    await this.inventory.releaseReservation({
      sku: inventoryId,
      qty,
      orderId,
      orderItemId: row.order_item_id || row.op_id,
      idempotencyKey: idKey,
    });
    await this.logOrderEvent(row.order_id, "INVENTORY_RESERVATION_RELEASED", `Reserva liberada por ajuste de proveedor: ${row.title}`, {
      opId: row.op_id,
      inventoryId,
      qty,
      reason,
      idempotencyKey: idKey,
    });
  }

  private async rollbackReceivedInventoryIfNeeded(row: SupplierOperationRow, reason: string): Promise<void> {
    if (!row.received_to_inventory) return;
    const inventoryId = (row.inventory_item_id || "").trim();
    const qty = this.safeQty(row.received_qty || row.quantity);
    if (!inventoryId || qty <= 0) return;

    const adjustKey = this.safeIdempotencyKey(`supplier_rollback_inbound_${row.op_id}_${reason}`);
    await this.inventory.adjustQuantity(inventoryId, -qty, adjustKey);
    await this.logOrderEvent(row.order_id, "INVENTORY_INBOUND_ROLLBACK", `Recepcion revertida: ${row.title}`, {
      opId: row.op_id,
      inventoryId,
      qty,
      reason,
      idempotencyKey: adjustKey,
    });

    const inv = this.inventory.items().find((entry) => entry.inventory_id === inventoryId) || null;
    if (!inv) return;
    const onHand = this.safeQty(inv.on_hand_qty ?? inv.quantity_on_hand);
    const reserved = this.safeQty(inv.reserved_qty ?? 0);
    const note = String(inv.notes || "");
    const autoCreatedFromLine = note.includes(row.op_id);
    if (autoCreatedFromLine && onHand <= 0 && reserved <= 0) {
      const deleteKey = this.safeIdempotencyKey(`supplier_rollback_delete_${row.op_id}_${reason}`);
      await this.inventory.delete(inventoryId, deleteKey);
      await this.logOrderEvent(row.order_id, "INVENTORY_ITEM_DELETED", `Inventario eliminado por rollback: ${row.title}`, {
        opId: row.op_id,
        inventoryId,
        reason,
        idempotencyKey: deleteKey,
      });
    }
  }

  private buildOpId(orderId: string, orderItemId: string): string {
    return `op-${orderId}-${orderItemId}`;
  }

  private buildInventoryIdForLine(row: SupplierOperationRow): string {
    const seed = [row.supplier_id, row.product_id || row.title, row.variant || "", row.color || ""]
      .join("-")
      .trim();
    return `inv-${this.slugify(seed || row.op_id)}`;
  }

  private slugify(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  private safeIdempotencyKey(raw: string): string {
    return String(raw || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 120);
  }

  private async syncOrderStatus(orderId: string): Promise<void> {
    if (!orderId) return;
    const snap = await getDocs(query(this.colRef, where("order_id", "==", orderId)));
    const statuses = snap.docs
      .map((entry) => {
        const data = entry.data() as any;
        const reservedFor = String(data["reserved_for_order_id"] || data["order_id"] || "");
        if (reservedFor !== orderId) return null;
        return (data["status"] || "por_levantar") as SupplierOperationStatus;
      })
      .filter((status): status is SupplierOperationStatus => !!status);
    if (statuses.length === 0) return;

    let nextStatus: "supplier_processing" | "inbound_in_transit" | "recibido_qa" = "supplier_processing";
    if (statuses.every((status) => status === "recibido")) {
      nextStatus = "recibido_qa";
    } else if (statuses.some((status) => status === "en_camino")) {
      nextStatus = "inbound_in_transit";
    }

    const orderSnap = await getDoc(doc(FIRESTORE, "orders", orderId));
    const currentStatus = orderSnap.exists() ? String((orderSnap.data() as any)["status"] || "") : "";
    const lockedStatuses = new Set([
      "recibido_qa",
      "empaque",
      "en_ruta",
      "entregado",
      "pago_pendiente",
      "pagado",
      "cancelado",
      "devuelto",
    ]);
    if (lockedStatuses.has(currentStatus) && currentStatus !== nextStatus) {
      return;
    }

    await updateDoc(doc(FIRESTORE, "orders", orderId), {
      status: nextStatus,
      updated_at: serverTimestamp(),
    });
  }

  private async logOrderEvent(orderId: string, type: string, message: string, meta?: any): Promise<void> {
    if (!orderId) return;
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const user = FIREBASE_AUTH.currentUser;
    await setDoc(doc(FIRESTORE, "orders", orderId, "events", eventId), {
      id: eventId,
      orderId,
      type,
      message,
      meta: meta ?? null,
      actor: user
        ? { uid: user.uid, name: user.displayName || user.email || "Usuario" }
        : { uid: "system", name: "Sistema" },
      createdAt: serverTimestamp(),
    });
  }

  private normalize(id: string, data: Record<string, any>): SupplierOperationRow {
    const toIso = (value: any) => {
      if (!value) return new Date().toISOString();
      if (value.toDate) return value.toDate().toISOString();
      return String(value);
    };

    return {
      op_id: data["op_id"] || id,
      business_id: normalizeBusinessId(data["business_id"]),
      order_id: data["order_id"] || "",
      reserved_for_order_id: data["reserved_for_order_id"] || data["order_id"] || "",
      order_item_id: data["order_item_id"] || "",
      supplier_id: data["supplier_id"] || "",
      supplier_name: data["supplier_name"] || null,
      customer_id: data["customer_id"] || "",
      customer_name: data["customer_name"] || "Clienta",
      title: data["title"] || "Producto sin nombre",
      variant: data["variant"] || null,
      color: data["color"] || null,
      image_url: data["image_url"] || null,
      quantity: this.safeQty(data["quantity"]),
      product_id: data["product_id"] || null,
      status: (data["status"] as SupplierOperationStatus) || "por_levantar",
      inventory_item_id: data["inventory_item_id"] || null,
      received_to_inventory: data["received_to_inventory"] === true,
      reservation_applied: data["reservation_applied"] === true,
      received_qty: this.safeQty(data["received_qty"]),
      reserved_qty_for_order: this.safeQty(data["reserved_qty_for_order"]),
      idempotency_keys: (data["idempotency_keys"] as Record<string, string>) || {},
      created_at: toIso(data["created_at"]),
      updated_at: toIso(data["updated_at"]),
    };
  }
}
