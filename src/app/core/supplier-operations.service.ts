import { Injectable, computed, inject, signal } from "@angular/core";
import { InventoryService } from "./inventory.service";
import type { Order, OrderItem, OrderStatus } from "./orders.service";
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
import {
  canAdvanceSupplierOperationStatus,
  isSupplierReceiptComplete,
  supplierOperationReservedForOrderId,
} from "./supplier-operation-state";

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
  price_cost: number | null;
  product_id: string | null;
  variant_id: string | null;
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

export interface SupplierReceiptOptions {
  refreshInventory?: boolean;
  reloadSupplierOperations?: boolean;
  syncOrderStatus?: boolean;
}

@Injectable({ providedIn: "root" })
export class SupplierOperationsService {
  private colRef = collection(FIRESTORE, "supplier_operations");
  private inventory = inject(InventoryService);
  private businessScope = inject(BusinessScopeService);

  private rowsSignal = signal<SupplierOperationRow[]>([]);
  private loadRequestId = 0;

  rows = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rowsSignal().filter((row) => active.includes(row.business_id || "bm"));
  });

  async loadFromFirestore(): Promise<void> {
    const requestId = ++this.loadRequestId;
    const q = query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds()));
    const snap = await getDocs(q);
    const rows = snap.docs
      .map((entry) => this.normalize(entry.id, entry.data() as Record<string, any>))
      .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
    if (requestId !== this.loadRequestId) return;
    this.rowsSignal.set(rows);
  }

  /**
   * Carga solo las líneas de un pedido y las mezcla con las ya cargadas. El detalle de
   * pedido no necesita las operaciones de todo el negocio para decidir sus botones.
   */
  async loadForOrder(orderId: string): Promise<void> {
    const target = String(orderId || "").trim();
    if (!target) return;
    const requestId = ++this.loadRequestId;
    const snap = await getDocs(query(this.colRef, where("order_id", "==", target)));
    if (requestId !== this.loadRequestId) return;
    const fresh = snap.docs.map((entry) => this.normalize(entry.id, entry.data() as Record<string, any>));
    this.rowsSignal.update((current) => [
      ...fresh,
      ...current.filter((row) => row.order_id !== target),
    ]);
  }

  async upsertFromConfirmedOrder(order: Order, customerName: string): Promise<number> {
    const toCreate = this.confirmedSupplierItems(order);
    if (toCreate.length === 0) return 0;

    let createdOrUpdated = 0;

    await this.forEachWithConcurrency(toCreate, 4, async (item) => {
      const supplierId = (item.supplier_id || "").trim();
      if (!supplierId) return;

      const opId = this.buildOpId(order.order_id, item.item_id);
      const ref = doc(this.colRef, opId);
      await runTransaction(FIRESTORE, async (tx) => {
        const existingSnap = await tx.get(ref);
        const existing = existingSnap.exists()
          ? this.normalize(existingSnap.id, existingSnap.data() as Record<string, any>)
          : null;
        const payload = {
          op_id: opId,
          business_id: normalizeBusinessId(order.business_id),
          order_id: order.order_id,
          reserved_for_order_id: order.order_id,
          order_item_id: item.item_id,
          supplier_id: supplierId,
          supplier_name: existing?.supplier_name || null,
          customer_id: order.customer_id,
          customer_name: (customerName || "").trim() || "Clienta",
          title: item.title || "Producto sin nombre",
          variant: item.variant || null,
          color: item.color || null,
          image_url: existing?.image_url || item.image_url || null,
          quantity: this.safeQty(item.confirmed_qty ?? item.quantity),
          price_cost: item.price_cost ?? existing?.price_cost ?? null,
          product_id: item.product_id || null,
          variant_id: item.variant_id || null,
          updated_at: serverTimestamp(),
          ...(existing
            ? {}
            : {
                status: "por_levantar" as const,
                inventory_item_id: null,
                received_to_inventory: false,
                reservation_applied: false,
                received_qty: 0,
                reserved_qty_for_order: 0,
                idempotency_keys: {},
                created_at: serverTimestamp(),
              }),
        };
        tx.set(ref, payload, { merge: true });
      });
      createdOrUpdated += 1;
    });

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
    const lineRef = doc(this.colRef, lineId);
    const currentSnap = await getDoc(lineRef);
    if (!currentSnap.exists()) {
      throw new Error("Operacion de proveedor no encontrada");
    }
    const current = this.normalize(currentSnap.id, currentSnap.data() as Record<string, any>);

    if (newState === "recibido") {
      if (isSupplierReceiptComplete(current)) {
        if (reload) await this.loadFromFirestore();
        return;
      }
      await this.receiveLineAndAllocate(
        lineId,
        idempotencyKey || `${lineId}:${newState}`,
        { reloadSupplierOperations: reload },
      );
      return;
    }

    const transition = await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(lineRef);
      if (!snap.exists()) throw new Error("Operacion de proveedor no encontrada");
      const fresh = this.normalize(snap.id, snap.data() as Record<string, any>);
      if (fresh.status === newState) return { updated: false, row: fresh };
      if (!canAdvanceSupplierOperationStatus(fresh.status, newState)) {
        return { updated: false, row: fresh };
      }
      tx.update(lineRef, {
        status: newState,
        updated_at: serverTimestamp(),
      });
      return { updated: true, row: fresh };
    });

    if (transition.updated) {
      await this.syncOrderStatus(transition.row.order_id);
      await this.logOrderEvent(transition.row.order_id, "SUPPLIER_OP_STATUS_CHANGED", `Proveedor: ${lineId} -> ${newState}`, {
        opId: lineId,
        nextStatus: newState,
      });
    }

    if (reload) {
      await this.loadFromFirestore();
    }
  }

  async receiveLineAndAllocate(
    lineId: string,
    idempotencyKey: string,
    options: SupplierReceiptOptions = {},
  ): Promise<void> {
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

    const targetQty = this.safeQty(row.quantity);
    const inventoryId = row.inventory_item_id || this.buildInventoryIdForLine(row);
    // Solo se recibe lo que falta. Si la linea ya ingreso piezas a inventario y luego subio
    // su cantidad, la diferencia entra con su propia llave (`..._from<n>_to<m>`); la primera
    // recepcion conserva la llave original, por lo que reintentos y dos sesiones siguen
    // siendo idempotentes. Antes, la segunda recepcion reutilizaba la llave original,
    // no movia inventario y aun asi marcaba recibida la cantidad completa.
    const alreadyReceived = row.received_to_inventory ? Math.min(this.safeQty(row.received_qty), targetQty) : 0;
    const alreadyReserved = row.reservation_applied ? Math.min(this.safeQty(row.reserved_qty_for_order), targetQty) : 0;
    const qty = Math.max(0, targetQty - alreadyReceived);
    const reserveQty = Math.max(0, targetQty - alreadyReserved);
    const stepSuffix = alreadyReceived > 0 ? `_from${alreadyReceived}_to${targetQty}` : "";
    const reserveSuffix = alreadyReserved > 0 ? `_from${alreadyReserved}_to${targetQty}` : "";

    if (qty > 0) await this.inventory.receiveInbound(
      {
        sku: inventoryId,
        product_id: row.product_id,
        variant_id: row.variant_id,
        business_id: row.business_id,
        qty,
        unit_price: row.price_cost,
        supplierOperationId: row.op_id,
        lineId: row.order_item_id,
        idempotencyKey: this.safeIdempotencyKey(`inbound_${safeRoot}${stepSuffix}`),
        title: row.title,
        supplier_id: row.supplier_id || null,
        variant_name: row.variant || null,
        color_name: row.color || null,
        image_url: row.image_url || null,
      },
      { refreshCache: options.refreshInventory !== false },
    );
    if (qty > 0) await this.logOrderEvent(row.order_id, "INVENTORY_INBOUND_RECEIVED", `Recepcion inventario para ${row.title}`, {
      opId: row.op_id,
      inventoryId,
      qty,
      previouslyReceived: alreadyReceived,
      idempotencyKey: `inbound_${safeRoot}${stepSuffix}`,
    }).catch(() => undefined);

    const reserveForOrderId = String(row.reserved_for_order_id || "").trim();
    const canReserveForOrder = !!reserveForOrderId && !!String(row.order_item_id || "").trim() && targetQty > 0;
    if (canReserveForOrder && reserveQty > 0) {
      await this.inventory.reserveStock(
        {
          sku: inventoryId,
          qty: reserveQty,
          orderId: reserveForOrderId,
          orderItemId: row.order_item_id,
          idempotencyKey: this.safeIdempotencyKey(`reserve_${safeRoot}${reserveSuffix}`),
        },
        { refreshCache: options.refreshInventory !== false },
      );
      await this.logOrderEvent(row.order_id, "INVENTORY_RESERVED", `Reserva inventario para ${row.title}`, {
        opId: row.op_id,
        inventoryId,
        qty: reserveQty,
        orderId: reserveForOrderId,
        idempotencyKey: `reserve_${safeRoot}${reserveSuffix}`,
      }).catch(() => undefined);
    }

    const finalizeKey = this.safeIdempotencyKey(`final_${safeRoot}${stepSuffix}`);
    await runTransaction(FIRESTORE, async (tx) => {
      const snap = await tx.get(opRef);
      if (!snap.exists()) return;
      const current = this.normalize(snap.id, snap.data() as Record<string, any>);
      const idMap = current.idempotency_keys || {};
      if (idMap[finalizeKey] && isSupplierReceiptComplete(current)) return;
      const nowIso = new Date().toISOString();
      tx.update(opRef, {
        status: "recibido",
        inventory_item_id: inventoryId,
        received_to_inventory: true,
        reservation_applied: canReserveForOrder,
        // Nunca se reduce lo ya registrado: si la cantidad bajó después de recibir, la
        // diferencia sigue apartada y closeOnDelivery la libera al entregar.
        received_qty: Math.max(row.received_to_inventory ? this.safeQty(row.received_qty) : 0, alreadyReceived + qty),
        reserved_qty_for_order: canReserveForOrder
          ? Math.max(row.reservation_applied ? this.safeQty(row.reserved_qty_for_order) : 0, alreadyReserved + reserveQty)
          : 0,
        updated_at: serverTimestamp(),
        idempotency_keys: {
          ...idMap,
          [finalizeKey]: nowIso,
        },
      });
    });

    const completedSnap = await getDoc(opRef);
    if (
      !completedSnap.exists()
      || !isSupplierReceiptComplete(
        this.normalize(completedSnap.id, completedSnap.data() as Record<string, any>),
      )
    ) {
      throw new Error("La recepcion de proveedor no completo inventario y reserva");
    }

    await this.logOrderEvent(row.order_id, "SUPPLIER_LINE_RECEIVED", `Linea de proveedor recibida: ${row.title}`, {
      opId: row.op_id,
      inventoryId,
      qty: alreadyReceived + qty,
      receivedNow: qty,
      idempotencyKey: safeRoot,
    }).catch(() => undefined);
    if (options.syncOrderStatus !== false) {
      await this.syncOrderStatus(row.order_id);
    }

    if (options.reloadSupplierOperations !== false) {
      await this.loadFromFirestore();
    }
  }

  async removeByOrder(orderId: string): Promise<void> {
    const q = query(this.colRef, where("order_id", "==", orderId));
    const snap = await getDocs(q);
    const rows = snap.docs.map((entry) => this.normalize(entry.id, entry.data() as Record<string, any>));
    for (const row of rows) {
      await this.releaseReservationIfNeeded(row, "order_delete").catch(() => null);
    }
    const writes = snap.docs.map((entry) => deleteDoc(entry.ref));
    await Promise.all(writes);
    await this.loadFromFirestore();
  }

  /**
   * Cierra las lineas de proveedor de un pedido entregado. La mercancia recibida y
   * apartada para el pedido SALE del inventario (consumo); solo se libera a disponible
   * lo apartado de mas (p. ej. si se redujo la cantidad despues de recibir).
   * Antes, la entrega borraba la linea liberando la reserva: lo entregado volvia a
   * "disponible" (inventario fantasma, Auditoria 03 P0-02).
   */
  async closeOnDelivery(order: Pick<Order, "order_id" | "items">): Promise<void> {
    const orderId = order.order_id;
    const snap = await getDocs(query(this.colRef, where("order_id", "==", orderId)));
    const itemsById = new Map((order.items || []).map((item) => [item.item_id, item]));
    for (const entry of snap.docs) {
      const row = this.normalize(entry.id, entry.data() as Record<string, any>);
      const inventoryId = (row.inventory_item_id || "").trim();
      const reservedFor = (row.reserved_for_order_id || "").trim();
      const reserved = this.safeQty(row.reserved_qty_for_order || (row.reservation_applied ? row.quantity : 0));
      if (inventoryId && reservedFor === orderId && reserved > 0) {
        const item = itemsById.get(row.order_item_id);
        const delivered = item
          ? Math.max(0, this.safeQty(item.confirmed_qty ?? item.quantity) - this.safeQty(item.returned_qty))
          : 0;
        const consume = Math.min(reserved, delivered);
        if (consume > 0) {
          // Misma llave que OrdersService.consumeInventoryForDelivery usa para el articulo:
          // si el articulo ya apuntaba a este inventario, el consumo no se duplica.
          await this.inventory.consumeOnDelivery({
            sku: inventoryId,
            qty: consume,
            orderId,
            orderItemId: row.order_item_id,
            idempotencyKey: `delivery_${orderId}_close_${row.order_item_id}`,
          });
        }
        const leftover = reserved - consume;
        if (leftover > 0) {
          await this.inventory.releaseReservation({
            sku: inventoryId,
            qty: leftover,
            orderId,
            orderItemId: row.order_item_id,
            idempotencyKey: this.safeIdempotencyKey(`supplier_release_${row.op_id}_delivery_leftover`),
          });
        }
        await this.logOrderEvent(orderId, "SUPPLIER_LINE_DELIVERED", `Entrega de linea de proveedor: ${row.title}`, {
          opId: row.op_id, inventoryId, consumed: consume, released: leftover,
        }).catch(() => undefined);
      }
      await deleteDoc(entry.ref);
    }
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

  private safePrice(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const price = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(price)) return null;
    return Math.max(0, Number(price.toFixed(2)));
  }

  private async getByOpId(opId: string): Promise<SupplierOperationRow | null> {
    if (!opId) return null;
    const snap = await getDoc(doc(this.colRef, opId));
    if (!snap.exists()) return null;
    return this.normalize(snap.id, snap.data() as Record<string, any>);
  }

  private async releaseReservationIfNeeded(row: SupplierOperationRow, reason: string): Promise<void> {
    const inventoryId = (row.inventory_item_id || "").trim();
    const orderId = (row.reserved_for_order_id || "").trim();
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
    const onHand = this.safeQty(inv.on_hand_qty);
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

  private async forEachWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    task: (item: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await task(items[index]);
      }
    };
    const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency)));
    const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async syncOrderStatus(orderId: string): Promise<void> {
    if (!orderId) return;
    const snap = await getDocs(query(this.colRef, where("order_id", "==", orderId)));
    const statuses = snap.docs
      .map((entry) => {
        const data = entry.data() as Record<string, unknown>;
        const reservedFor = supplierOperationReservedForOrderId(data);
        if (reservedFor !== orderId) return null;
        const status = (data["status"] || "por_levantar") as SupplierOperationStatus;
        return status === "recibido" && !isSupplierReceiptComplete(data)
          ? "en_camino"
          : status;
      })
      .filter((status): status is SupplierOperationStatus => !!status);
    if (statuses.length === 0) return;

    // Tipado como OrderStatus a proposito: asi el compilador impide volver a
    // escribir un nombre fuera del vocabulario canonico.
    let nextStatus: OrderStatus = "supplier_processing";
    if (statuses.every((status) => status === "recibido")) {
      nextStatus = "recibido_qa";
    } else if (statuses.some((status) => status === "en_camino")) {
      nextStatus = "en_transito";
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
    // Una linea de proveedor no saca al pedido de captura: eso solo lo hace
    // "Confirmar existencias" (RC-01). Tampoco reescribe pedidos ya entregados o cerrados.
    if (["borrador", "delivered", "entregado_parcial", "pagado_parcial", "closed"].includes(currentStatus)) {
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
      reserved_for_order_id: supplierOperationReservedForOrderId(data),
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
      price_cost: this.safePrice(data["price_cost"]),
      product_id: data["product_id"] || null,
      variant_id: data["variant_id"] || null,
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
