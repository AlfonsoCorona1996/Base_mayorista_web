import { Injectable, computed, inject, signal } from "@angular/core";
import {
  Unsubscribe,
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService } from "./inventory.service";
import { Order, OrderItem } from "./orders.service";
import { availableReturnQty, calculateOrderFinancials, money, toPersistedOrderTotals } from "./order-financials";
import { FeatureFlagsService } from "./feature-flags.service";

export type ReturnDisposition = "available" | "review" | "damaged";
export type ReturnStatus = "restocked" | "pending_review" | "damaged";
export type ReturnPaymentResolution = "credit" | "refund" | "not_required";

export interface ReturnRecord {
  return_id: string;
  business_id: BusinessId;
  order_id: string;
  order_item_id: string;
  qty: number;
  disposition: ReturnDisposition;
  status: ReturnStatus;
  inventory_id: string | null;
  reason: string | null;
  product_snapshot: Record<string, unknown>;
  created_by: string | null;
  customer_id: string | null;
  stage_at_return: string | null;
  package_id: string | null;
  unit_price_public: number;
  unit_price_customer: number;
  unit_cost: number;
  gross_return_amount: number;
  discount_share: number;
  net_return_amount: number;
  returned_cost_amount: number;
  profit_impact: number;
  payment_resolution: ReturnPaymentResolution;
  resolution_amount: number;
  refund_account_id: string | null;
  refund_method: string | null;
  refund_reference: string | null;
  created_at?: any;
  updated_at?: any;
  restocked_at?: any;
}

export interface RegisterReturnInput {
  order: Order;
  item: OrderItem;
  qty: number;
  disposition: ReturnDisposition;
  reason?: string | null;
  createdBy?: string | null;
  paymentResolution?: ReturnPaymentResolution;
  refundAccountId?: string | null;
  refundMethod?: string | null;
  refundReference?: string | null;
  packageId?: string | null;
}

@Injectable({ providedIn: "root" })
export class ReturnsService {
  private colRef = collection(FIRESTORE, "returns");
  private businessScope = inject(BusinessScopeService);
  private inventory = inject(InventoryService);
  private features = inject(FeatureFlagsService);
  private unsubscribe: Unsubscribe | null = null;
  private rows = signal<ReturnRecord[]>([]);

  returns = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rows().filter((row) => active.includes(row.business_id || "bm"));
  });

  pendingReview = computed(() => this.returns().filter((row) => row.status === "pending_review"));

  watch(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onSnapshot(
      query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds())),
      (snap) => {
        const rows = snap.docs
          .map((entry) => this.normalize(entry.id, entry.data() as Record<string, unknown>))
          .sort((a, b) => this.toMillis(b.updated_at || b.created_at) - this.toMillis(a.updated_at || a.created_at));
        this.rows.set(rows);
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async registerReturn(input: RegisterReturnInput): Promise<ReturnRecord> {
    if (!this.features.enabled("returnsV2")) throw new Error("La fase de devoluciones V2 está desactivada.");
    const businessId = normalizeBusinessId(input.order.business_id);
    const requestedQty = Math.max(1, Math.trunc(Number(input.qty) || 1));
    const returnId = `ret_${input.order.order_id}_${input.item.item_id}_${Date.now()}`;
    const requestedInventoryId = String(input.item.inventory_id || "").trim() || this.buildInventoryId(businessId, input.item);
    const ref = doc(this.colRef, returnId);
    const orderRef = doc(FIRESTORE, "orders", input.order.order_id);
    let savedRecord: ReturnRecord | null = null;

    await runTransaction(FIRESTORE, async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) throw new Error("El pedido ya no existe.");
      const rawOrder = orderSnap.data() as Record<string, any>;
      const liveOrder = { ...rawOrder, order_id: orderSnap.id } as Order;
      const allowedStages = new Set([
        "packing", "empaque", "ready_for_route", "assigned_to_run", "in_transit", "en_ruta",
        "delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed",
      ]);
      if (!allowedStages.has(String(liveOrder.status || ""))) {
        throw new Error("Las devoluciones sólo se permiten desde empaque en adelante.");
      }
      const liveItems = Array.isArray(liveOrder.items) ? liveOrder.items : [];
      const itemIndex = liveItems.findIndex((row) => row.item_id === input.item.item_id);
      if (itemIndex < 0) throw new Error("El producto ya no pertenece al pedido.");
      const liveItem = liveItems[itemIndex];
      const remaining = availableReturnQty(liveItem);
      if (requestedQty > remaining) {
        throw new Error(`Sólo quedan ${remaining} pieza(s) disponibles para devolver.`);
      }

      const deliveredStages = new Set(["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed"]);
      const afterDelivery = deliveredStages.has(String(liveOrder.status || ""));
      const inventoryId = String(liveItem.inventory_id || "").trim() || requestedInventoryId;
      const inventoryRef = doc(FIRESTORE, "inventory_items", inventoryId);
      const stopRef = liveOrder.route_run_id
        ? doc(FIRESTORE, "route_runs", liveOrder.route_run_id, "stops", liveOrder.route_stop_id || liveOrder.order_id)
        : null;
      const runRef = liveOrder.route_run_id ? doc(FIRESTORE, "route_runs", liveOrder.route_run_id) : null;
      const customerRef = doc(FIRESTORE, "customers", liveOrder.customer_id);
      const accountRef = input.paymentResolution === "refund" && input.refundAccountId
        ? doc(FIRESTORE, "finance_accounts", input.refundAccountId)
        : null;

      const [inventorySnap, stopSnap, runSnap, customerSnap, accountSnap] = await Promise.all([
        tx.get(inventoryRef),
        stopRef ? tx.get(stopRef) : Promise.resolve(null),
        runRef ? tx.get(runRef) : Promise.resolve(null),
        tx.get(customerRef),
        accountRef ? tx.get(accountRef) : Promise.resolve(null),
      ]);

      const currentReturned = Math.max(0, Math.trunc(Number(liveItem.returned_qty || 0)));
      const currentRestockable = Math.max(0, Math.trunc(Number(liveItem.returned_restockable_qty || 0)));
      const currentDamaged = Math.max(0, Math.trunc(Number(liveItem.returned_damaged_qty || 0)));
      const nextReturned = currentReturned + requestedQty;
      const isDamaged = input.disposition === "damaged";
      const nextItem: OrderItem = {
        ...liveItem,
        returned_qty: nextReturned,
        returned_restockable_qty: currentRestockable + (isDamaged ? 0 : requestedQty),
        returned_damaged_qty: currentDamaged + (isDamaged ? requestedQty : 0),
        state: nextReturned >= Math.max(0, Number(liveItem.confirmed_qty ?? liveItem.quantity ?? 0)) ? "devuelto" : liveItem.state,
        inventory_id: inventoryId,
      };
      const nextItems = liveItems.map((row, index) => index === itemIndex ? nextItem : row);
      const beforeFinancials = calculateOrderFinancials(liveOrder);
      const nextFinancials = calculateOrderFinancials({ ...liveOrder, items: nextItems });
      const persistedTotals = toPersistedOrderTotals({ ...liveOrder, items: nextItems });
      const resolutionAmount = Math.max(0, money(nextFinancials.overpaymentAmount - beforeFinancials.overpaymentAmount));
      const paymentResolution: ReturnPaymentResolution = resolutionAmount > 0
        ? (input.paymentResolution === "credit" || input.paymentResolution === "refund" ? input.paymentResolution : "not_required")
        : "not_required";
      if (resolutionAmount > 0 && paymentResolution === "not_required") {
        throw new Error("Selecciona saldo a favor o devolución de dinero para el monto pagado de más.");
      }
      if (paymentResolution === "credit" && !customerSnap.exists()) {
        throw new Error("La clienta no existe; no se puede crear el saldo a favor.");
      }
      if (paymentResolution === "credit" && normalizeBusinessId(customerSnap.data()?.["business_id"]) !== businessId) {
        throw new Error("La clienta pertenece a otro negocio.");
      }
      if (paymentResolution === "refund" && (!accountRef || !accountSnap?.exists() || !String(input.refundMethod || "").trim())) {
        throw new Error("Selecciona cuenta y método para registrar la devolución de dinero.");
      }
      if (paymentResolution === "refund" && normalizeBusinessId(accountSnap?.data()?.["business_id"]) !== businessId) {
        throw new Error("La cuenta de reembolso pertenece a otro negocio.");
      }

      const status = this.statusForDisposition(input.disposition);
      const snapshot = this.productSnapshot(liveItem);
      const grossReturnAmount = money((liveItem.price_clienta ?? liveItem.price_public ?? 0) * requestedQty);
      const discountShare = money(beforeFinancials.netAmount - nextFinancials.netAmount < grossReturnAmount
        ? grossReturnAmount - (beforeFinancials.netAmount - nextFinancials.netAmount)
        : 0);
      const returnedCostAmount = isDamaged ? 0 : money((liveItem.price_cost || 0) * requestedQty);
      const record: ReturnRecord = {
        return_id: returnId,
        business_id: businessId,
        order_id: liveOrder.order_id,
        order_item_id: liveItem.item_id,
        qty: requestedQty,
        disposition: input.disposition,
        status,
        inventory_id: inventoryId,
        reason: input.reason?.trim() || null,
        product_snapshot: snapshot,
        created_by: input.createdBy || null,
        customer_id: liveOrder.customer_id || null,
        stage_at_return: String(liveOrder.status || ""),
        package_id: input.packageId || null,
        unit_price_public: money(liveItem.price_public ?? liveItem.price_clienta),
        unit_price_customer: money(liveItem.price_clienta ?? liveItem.price_public),
        unit_cost: money(liveItem.price_cost),
        gross_return_amount: grossReturnAmount,
        discount_share: discountShare,
        net_return_amount: money(beforeFinancials.netAmount - nextFinancials.netAmount),
        returned_cost_amount: returnedCostAmount,
        profit_impact: money(beforeFinancials.grossProfit - nextFinancials.grossProfit),
        payment_resolution: paymentResolution,
        resolution_amount: resolutionAmount,
        refund_account_id: input.refundAccountId || null,
        refund_method: input.refundMethod?.trim() || null,
        refund_reference: input.refundReference?.trim() || null,
      };

      const inventoryData = inventorySnap.exists() ? inventorySnap.data() as Record<string, any> : {};
      const onHand = Math.max(0, Math.trunc(Number(inventoryData["on_hand_qty"] ?? inventoryData["quantity_on_hand"] ?? 0)));
      const reserved = Math.max(0, Math.trunc(Number(inventoryData["reserved_qty"] || 0)));
      const available = Math.max(0, Math.trunc(Number(inventoryData["available_qty"] ?? inventoryData["quantity_on_hand"] ?? Math.max(0, onHand - reserved))));
      const inReview = Math.max(0, Math.trunc(Number(inventoryData["in_review_qty"] || 0)));
      const damaged = Math.max(0, Math.trunc(Number(inventoryData["damaged_qty"] || 0)));
      const reservations = { ...(inventoryData["reservations"] || {}) } as Record<string, any>;
      const reservationKeys = Object.keys(reservations).filter((key) =>
        (key === liveOrder.order_id || key.startsWith(`${liveOrder.order_id}:`))
        && (!key.includes(":") || key.endsWith(`:${liveItem.item_id}`)),
      );
      const reservedForOrder = reservationKeys.reduce((sum, key) => sum + Math.max(0, Math.trunc(Number(reservations[key]?.qty || 0))), 0);
      const released = afterDelivery ? 0 : Math.min(requestedQty, reserved, reservedForOrder || reserved);
      const incoming = afterDelivery ? requestedQty : Math.max(0, requestedQty - released);
      const nextReserved = Math.max(0, reserved - released);
      let releaseRemaining = released;
      for (const key of reservationKeys) {
        if (releaseRemaining <= 0) break;
        const currentQty = Math.max(0, Math.trunc(Number(reservations[key]?.qty || 0)));
        const fromKey = Math.min(currentQty, releaseRemaining);
        const remainingQty = currentQty - fromKey;
        releaseRemaining -= fromKey;
        reservations[key] = { ...reservations[key], qty: remainingQty, status: remainingQty > 0 ? "reserved" : "released", updated_at: new Date().toISOString() };
      }
      const addAvailable = input.disposition === "available" ? requestedQty : 0;
      const addReview = input.disposition === "review" ? requestedQty : 0;
      const addDamaged = input.disposition === "damaged" ? requestedQty : 0;
      const nextOnHand = onHand + incoming;
      const nextAvailable = available + addAvailable;
      const nextInReview = inReview + addReview;
      const nextDamaged = damaged + addDamaged;
      tx.set(inventoryRef, {
        inventory_id: inventoryId,
        business_id: businessId,
        title: String(liveItem.title || "Producto devuelto"),
        sku: String(liveItem.sku || liveItem.product_id || inventoryId),
        product_id: liveItem.product_id || null,
        variant_id: liveItem.variant_id || null,
        supplier_id: liveItem.supplier_id || null,
        variant_name: liveItem.variant || null,
        color_name: liveItem.color || null,
        on_hand_qty: nextOnHand,
        reserved_qty: nextReserved,
        available_qty: nextAvailable,
        quantity_on_hand: nextAvailable,
        in_review_qty: nextInReview,
        damaged_qty: nextDamaged,
        unit_price: liveItem.price_cost ?? inventoryData["unit_price"] ?? null,
        image_urls: inventoryData["image_urls"] || (liveItem.image_url ? [liveItem.image_url] : []),
        source_reason: inventoryData["source_reason"] || "devolucion",
        reservations,
        created_at: inventorySnap.exists() ? inventoryData["created_at"] || serverTimestamp() : serverTimestamp(),
        updated_at: serverTimestamp(),
      }, { merge: true });

      const movementId = `return_${returnId}`;
      tx.set(doc(FIRESTORE, "inventory_movements", movementId), {
        movement_id: movementId,
        business_id: businessId,
        inventory_id: inventoryId,
        type: input.disposition === "damaged" ? "damage" : "return",
        delta_on_hand: incoming,
        delta_available: addAvailable,
        delta_reserved: -released,
        delta_in_review: addReview,
        delta_damaged: addDamaged,
        order_id: liveOrder.order_id,
        order_item_id: liveItem.item_id,
        return_id: returnId,
        reason: input.reason?.trim() || null,
        actor: input.createdBy || null,
        idempotency_key: movementId,
        created_at: serverTimestamp(),
      });

      const nextPackages = afterDelivery ? liveOrder.packages : this.removeReturnedQtyFromPackages(liveOrder.packages || [], liveItem, requestedQty);
      const allReturned = nextItems.length > 0 && nextItems.every((row) => availableReturnQty(row) === 0);
      const eventLabel = `Devolución registrada: ${liveItem.title} (${requestedQty})`;
      const timeline = [...(liveOrder.timeline || []), { id: `t-${returnId}`, label: eventLabel, created_at: new Date().toISOString(), actor: input.createdBy || undefined }];
      tx.update(orderRef, {
        items: nextItems,
        packages: nextPackages,
        totals: persistedTotals,
        has_returns: true,
        status: allReturned ? "devuelto" : liveOrder.status,
        timeline,
        updated_at: serverTimestamp(),
      });
      tx.set(ref, { ...record, created_at: serverTimestamp(), updated_at: serverTimestamp(), restocked_at: status === "restocked" ? serverTimestamp() : null });
      tx.set(doc(FIRESTORE, "orders", liveOrder.order_id, "events", returnId), {
        id: returnId,
        orderId: liveOrder.order_id,
        type: "RETURN_REGISTERED",
        message: eventLabel,
        meta: { returnId, itemId: liveItem.item_id, qty: requestedQty, disposition: input.disposition, inventoryId },
        actor: input.createdBy ? { uid: "return", name: input.createdBy } : null,
        createdAt: serverTimestamp(),
      });

      if (stopRef && stopSnap?.exists()) {
        const stopData = stopSnap.data() as Record<string, any>;
        const amountDelta = money(nextFinancials.netAmount - beforeFinancials.netAmount);
        const balanceDelta = money(nextFinancials.balanceDue - beforeFinancials.balanceDue);
        const summaries = { ...(stopData["business_summaries"] || {}) };
        if (summaries[businessId]) {
          summaries[businessId] = {
            ...summaries[businessId],
            total_amount: Math.max(0, money(Number(summaries[businessId]["total_amount"] || 0) + amountDelta)),
            balance_due: Math.max(0, money(Number(summaries[businessId]["balance_due"] || 0) + balanceDelta)),
          };
        }
        tx.update(stopRef, {
          total_amount: Math.max(0, money(Number(stopData["total_amount"] || 0) + amountDelta)),
          balance_due: Math.max(0, money(Number(stopData["balance_due"] || 0) + balanceDelta)),
          business_summaries: summaries,
        });
        if (runRef && runSnap?.exists()) {
          const counts = (runSnap.data() as Record<string, any>)["counts"] || {};
          tx.update(runRef, {
            "counts.balance_total": Math.max(0, money(Number(counts["balance_total"] || 0) + balanceDelta)),
            updatedAt: serverTimestamp(),
          });
        }
      }

      if (paymentResolution === "credit" && resolutionAmount > 0) {
        const creditId = `credit_${returnId}`;
        tx.set(doc(FIRESTORE, "customer_credit_movements", creditId), {
          movement_id: creditId,
          business_id: businessId,
          customer_id: liveOrder.customer_id,
          type: "return_credit",
          amount: resolutionAmount,
          order_id: liveOrder.order_id,
          return_id: returnId,
          notes: input.reason?.trim() || null,
          created_by: input.createdBy || null,
          created_at: serverTimestamp(),
        });
        if (customerSnap.exists()) {
          tx.update(customerRef, {
            credit_balance: money(Number(customerSnap.data()["credit_balance"] || 0) + resolutionAmount),
            updated_at: serverTimestamp(),
          });
        }
      }

      if (paymentResolution === "refund" && resolutionAmount > 0 && accountRef && accountSnap?.exists()) {
        const refundId = `refund_${returnId}`;
        tx.set(doc(FIRESTORE, "finance_refunds", refundId), {
          refund_id: refundId,
          business_id: businessId,
          customer_id: liveOrder.customer_id,
          order_id: liveOrder.order_id,
          return_id: returnId,
          amount: resolutionAmount,
          account_id: input.refundAccountId,
          method: input.refundMethod?.trim() || null,
          reference: input.refundReference?.trim() || null,
          occurred_at: new Date().toISOString().slice(0, 10),
          created_by: input.createdBy || null,
          created_at: serverTimestamp(),
        });
        tx.update(accountRef, {
          balance: money(Number(accountSnap.data()["balance"] || 0) - resolutionAmount),
          updated_at: serverTimestamp(),
        });
      }
      savedRecord = record;
    });

    await this.inventory.loadFromFirestore();
    if (!savedRecord) throw new Error("No se pudo completar la devolución.");
    return savedRecord;
  }

  async restockReturn(row: ReturnRecord): Promise<void> {
    if (row.status !== "pending_review") return;
    const inventoryId = row.inventory_id || this.buildInventoryId(row.business_id, row.product_snapshot);
    const inventoryRef = doc(FIRESTORE, "inventory_items", inventoryId);
    await runTransaction(FIRESTORE, async (tx) => {
      const [returnSnap, inventorySnap] = await Promise.all([
        tx.get(doc(this.colRef, row.return_id)),
        tx.get(inventoryRef),
      ]);
      if (!returnSnap.exists() || returnSnap.data()["status"] !== "pending_review") return;
      const data = inventorySnap.exists() ? inventorySnap.data() as Record<string, any> : {};
      const reviewQty = Math.max(0, Math.trunc(Number(data["in_review_qty"] || 0)));
      const moved = Math.min(row.qty, reviewQty);
      const missingLegacyQty = Math.max(0, row.qty - moved);
      const onHand = Math.max(0, Math.trunc(Number(data["on_hand_qty"] ?? data["quantity_on_hand"] ?? 0)));
      const available = Math.max(0, Math.trunc(Number(data["available_qty"] ?? data["quantity_on_hand"] ?? 0)));
      tx.set(inventoryRef, {
        inventory_id: inventoryId,
        business_id: row.business_id,
        title: String(row.product_snapshot["title"] || "Producto devuelto"),
        sku: String(row.product_snapshot["product_id"] || row.product_snapshot["inventory_id"] || inventoryId),
        on_hand_qty: onHand + missingLegacyQty,
        available_qty: available + row.qty,
        quantity_on_hand: available + row.qty,
        in_review_qty: Math.max(0, reviewQty - moved),
        updated_at: serverTimestamp(),
        created_at: inventorySnap.exists() ? data["created_at"] || serverTimestamp() : serverTimestamp(),
      }, { merge: true });
      const movementId = `quality_approve_${row.return_id}`;
      tx.set(doc(FIRESTORE, "inventory_movements", movementId), {
        movement_id: movementId,
        business_id: row.business_id,
        inventory_id: inventoryId,
        type: "quality_approve",
        delta_on_hand: missingLegacyQty,
        delta_available: row.qty,
        delta_reserved: 0,
        delta_in_review: -moved,
        delta_damaged: 0,
        order_id: row.order_id,
        order_item_id: row.order_item_id,
        return_id: row.return_id,
        reason: row.reason,
        actor: null,
        idempotency_key: movementId,
        created_at: serverTimestamp(),
      });
      tx.update(doc(this.colRef, row.return_id), {
        status: "restocked",
        disposition: "available",
        inventory_id: inventoryId,
        restocked_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });
    });
    await this.inventory.loadFromFirestore();
  }

  async markDamaged(row: ReturnRecord): Promise<void> {
    if (row.status !== "pending_review") return;
    const inventoryId = row.inventory_id || this.buildInventoryId(row.business_id, row.product_snapshot);
    const inventoryRef = doc(FIRESTORE, "inventory_items", inventoryId);
    const orderRef = doc(FIRESTORE, "orders", row.order_id);
    await runTransaction(FIRESTORE, async (tx) => {
      const [returnSnap, inventorySnap, orderSnap] = await Promise.all([
        tx.get(doc(this.colRef, row.return_id)),
        tx.get(inventoryRef),
        tx.get(orderRef),
      ]);
      if (!returnSnap.exists() || returnSnap.data()["status"] !== "pending_review") return;
      const data = inventorySnap.exists() ? inventorySnap.data() as Record<string, any> : {};
      const reviewQty = Math.max(0, Math.trunc(Number(data["in_review_qty"] || 0)));
      const moved = Math.min(row.qty, reviewQty);
      const damagedQty = Math.max(0, Math.trunc(Number(data["damaged_qty"] || 0)));
      tx.set(inventoryRef, {
        inventory_id: inventoryId,
        business_id: row.business_id,
        in_review_qty: Math.max(0, reviewQty - moved),
        damaged_qty: damagedQty + row.qty,
        updated_at: serverTimestamp(),
      }, { merge: true });
      const movementId = `quality_damage_${row.return_id}`;
      tx.set(doc(FIRESTORE, "inventory_movements", movementId), {
        movement_id: movementId,
        business_id: row.business_id,
        inventory_id: inventoryId,
        type: "damage",
        delta_on_hand: 0,
        delta_available: 0,
        delta_reserved: 0,
        delta_in_review: -moved,
        delta_damaged: row.qty,
        order_id: row.order_id,
        order_item_id: row.order_item_id,
        return_id: row.return_id,
        reason: row.reason,
        actor: null,
        idempotency_key: movementId,
        created_at: serverTimestamp(),
      });
      if (orderSnap.exists()) {
        const liveOrder = { ...orderSnap.data(), order_id: orderSnap.id } as Order;
        const items = (liveOrder.items || []).map((item) => item.item_id === row.order_item_id
          ? {
              ...item,
              returned_restockable_qty: Math.max(0, Number(item.returned_restockable_qty || 0) - row.qty),
              returned_damaged_qty: Math.min(Number(item.returned_qty || 0), Number(item.returned_damaged_qty || 0) + row.qty),
            }
          : item);
        tx.update(orderRef, { items, totals: toPersistedOrderTotals({ ...liveOrder, items }), updated_at: serverTimestamp() });
      }
      tx.update(doc(this.colRef, row.return_id), {
        status: "damaged",
        disposition: "damaged",
        inventory_id: inventoryId,
        returned_cost_amount: 0,
        updated_at: serverTimestamp(),
      });
    });
    await this.inventory.loadFromFirestore();
  }

  private normalize(id: string, data: Record<string, unknown>): ReturnRecord {
    return {
      return_id: String(data["return_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      order_id: String(data["order_id"] || ""),
      order_item_id: String(data["order_item_id"] || ""),
      qty: Math.max(0, Math.trunc(Number(data["qty"] || 0))),
      disposition: this.normalizeDisposition(data["disposition"]),
      status: this.normalizeStatus(data["status"]),
      inventory_id: this.nullableText(data["inventory_id"]),
      reason: this.nullableText(data["reason"]),
      product_snapshot: (data["product_snapshot"] || {}) as Record<string, unknown>,
      created_by: this.nullableText(data["created_by"]),
      customer_id: this.nullableText(data["customer_id"]),
      stage_at_return: this.nullableText(data["stage_at_return"]),
      package_id: this.nullableText(data["package_id"]),
      unit_price_public: this.safePrice(data["unit_price_public"]) || 0,
      unit_price_customer: this.safePrice(data["unit_price_customer"]) || 0,
      unit_cost: this.safePrice(data["unit_cost"]) || 0,
      gross_return_amount: this.safePrice(data["gross_return_amount"]) || 0,
      discount_share: this.safePrice(data["discount_share"]) || 0,
      net_return_amount: this.safePrice(data["net_return_amount"]) || 0,
      returned_cost_amount: this.safePrice(data["returned_cost_amount"]) || 0,
      profit_impact: this.safePrice(data["profit_impact"]) || 0,
      payment_resolution: this.normalizePaymentResolution(data["payment_resolution"]),
      resolution_amount: this.safePrice(data["resolution_amount"]) || 0,
      refund_account_id: this.nullableText(data["refund_account_id"]),
      refund_method: this.nullableText(data["refund_method"]),
      refund_reference: this.nullableText(data["refund_reference"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
      restocked_at: data["restocked_at"] ?? null,
    };
  }

  private statusForDisposition(value: ReturnDisposition): ReturnStatus {
    if (value === "available") return "restocked";
    if (value === "damaged") return "damaged";
    return "pending_review";
  }

  private normalizeDisposition(value: unknown): ReturnDisposition {
    if (value === "available" || value === "damaged") return value;
    return "review";
  }

  private normalizeStatus(value: unknown): ReturnStatus {
    if (value === "restocked" || value === "damaged") return value;
    return "pending_review";
  }

  private normalizePaymentResolution(value: unknown): ReturnPaymentResolution {
    if (value === "credit" || value === "refund") return value;
    return "not_required";
  }

  private removeReturnedQtyFromPackages(packages: Order["packages"], item: OrderItem, qty: number): Order["packages"] {
    let remaining = qty;
    return (packages || []).map((pkg) => {
      if (remaining <= 0 || pkg.state === "entregado") return pkg;
      const entries = Array.isArray(pkg.items) ? pkg.items : [];
      let removedFromPackage = 0;
      const nextEntries = entries
        .map((entry) => {
          if (entry.orderItemId !== item.item_id || remaining <= 0) return entry;
          const removed = Math.min(Math.max(0, Number(entry.qty || 0)), remaining);
          remaining -= removed;
          removedFromPackage += removed;
          return { ...entry, qty: Math.max(0, Number(entry.qty || 0) - removed) };
        })
        .filter((entry) => entry.qty > 0);
      if (entries.length === 0 && (pkg.item_ids || []).includes(item.item_id) && remaining > 0) {
        removedFromPackage = remaining;
        remaining = 0;
      }
      const stillIncluded = nextEntries.some((entry) => entry.orderItemId === item.item_id);
      const unit = money(item.price_clienta ?? item.price_public);
      return {
        ...pkg,
        items: nextEntries,
        item_ids: stillIncluded ? pkg.item_ids : (pkg.item_ids || []).filter((id) => id !== item.item_id),
        amount_due: pkg.amount_due === null ? null : Math.max(0, money(Number(pkg.amount_due || 0) - unit * removedFromPackage)),
      };
    });
  }

  private productSnapshot(item: OrderItem | Record<string, unknown>): Record<string, unknown> {
    const source = item as Record<string, unknown>;
    return {
      item_id: String(source["item_id"] || ""),
      title: String(source["title"] || ""),
      variant: source["variant"] ?? null,
      color: source["color"] ?? null,
      source: source["source"] ?? null,
      business_id: source["business_id"] ?? null,
      product_ref_type: source["product_ref_type"] ?? null,
      supplier_id: source["supplier_id"] ?? null,
      product_id: source["product_id"] ?? null,
      inventory_id: source["inventory_id"] ?? null,
      price_clienta: source["price_clienta"] ?? null,
      price_public: source["price_public"] ?? null,
      price_cost: source["price_cost"] ?? null,
      image_url: source["image_url"] ?? null,
    };
  }

  private buildInventoryId(businessId: BusinessId, item: OrderItem | Record<string, unknown>): string {
    const source = item as Record<string, unknown>;
    const stable = [
      businessId,
      source["product_id"] || source["inventory_id"] || source["title"],
      source["variant"],
      source["color"],
    ]
      .map((part) => this.slugify(String(part || "")))
      .filter(Boolean)
      .join("-");
    return `ret-${stable || Date.now()}`;
  }

  private slugify(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  private nullableText(value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text || null;
  }

  private safePrice(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Number(number.toFixed(2))) : null;
  }

  private toMillis(value: unknown): number {
    if (!value) return 0;
    if (typeof value === "object" && value !== null && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      return (value as { toMillis: () => number }).toMillis();
    }
    if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
      return (value as { toDate: () => Date }).toDate().getTime();
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  }
}
