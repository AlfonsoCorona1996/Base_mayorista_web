import { Injectable, computed, inject, signal } from "@angular/core";
import {
  Unsubscribe,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService, readInventoryQuantities } from "./inventory.service";
import { Order, OrderItem, normalizeOrderStatus } from "./orders.service";
import { availableReturnQty, calculateOrderFinancials, money, toPersistedOrderTotals } from "./order-financials";
import { FeatureFlagsService } from "./feature-flags.service";
import { businessDateKey, financePeriodDocumentId, ledgerEntryPayload, monthIdFromDateInput } from "./finance-ledger";
import { hasDeliveryEvidence } from "./order-closure";
import {
  INVENTORY_ALLOCATIONS_COLLECTION,
  InventoryAllocation,
  ReturnInventoryCandidate,
  ReturnLegKind,
  allocationDocId,
  applyAllocationRelease,
  applyAllocationReturnRestock,
  legacyEvidenceFromMovements,
  normalizeAllocation,
  planReturnInventory,
} from "./inventory-allocations";

export type ReturnDisposition = "available" | "review" | "damaged";
/**
 * `inventory_unverified` (FIX 03B-1): la devolución se registró, pero no había evidencia de
 * en qué inventario estaba la pieza ni de que hubiera salido; no se creó existencia. Se
 * resuelve con `resolveUnverifiedReturn` tras un conteo físico.
 */
export type ReturnStatus = "restocked" | "pending_review" | "damaged" | "inventory_unverified";
export type ReturnInventoryResolution = "allocation" | "legacy_evidence" | "unverified" | "physical_count" | "not_found" | "legacy_unknown";

/** No hay evidencia suficiente para reincorporar la pieza sin riesgo de duplicarla. */
export class ReturnInventoryUnverifiedError extends Error {
  constructor(message: string, readonly coverableQty: number) {
    super(message);
    this.name = "ReturnInventoryUnverifiedError";
  }
}
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
  /** Dónde entró cada pieza (FIX 03B-1). Vacío en devoluciones anteriores o sin ingreso. */
  inventory_legs?: Array<{ inventory_id: string; kind: ReturnLegKind; qty: number }>;
  inventory_resolution?: ReturnInventoryResolution;
  inventory_note?: string | null;
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
  /**
   * FIX 03B-1.1: costo de piezas devueltas SIN inventario comprobado (`inventory_unverified`).
   * No es capital recuperado: se convierte en `returned_cost_amount` solo si el conteo físico
   * encuentra la pieza ("Ingresar tras conteo"); si no aparece, pasa a merma.
   */
  pending_recovery_cost_amount?: number;
  profit_impact: number;
  payment_resolution: ReturnPaymentResolution;
  resolution_amount: number;
  refund_account_id: string | null;
  refund_method: string | null;
  refund_reference: string | null;
  occurred_at: string;
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
  /**
   * Identificador del intento (uno por apertura del formulario). Reintentar o pulsar dos
   * veces con el mismo intento no registra una segunda devolución.
   */
  attemptId?: string | null;
  /**
   * `hold_unverified`: la persona confirmó registrar la devolución SIN ingreso a inventario
   * porque no hay evidencia de dónde estaba la pieza (ver `ReturnInventoryUnverifiedError`).
   */
  inventoryMode?: "verified" | "hold_unverified";
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
  /** Devoluciones registradas sin ingreso a inventario, pendientes de conteo físico. */
  unverifiedInventory = computed(() => this.returns().filter((row) => row.status === "inventory_unverified"));

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
    const attempt = String(input.attemptId || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
    const returnId = `ret_${input.order.order_id}_${input.item.item_id}_${attempt || Date.now()}`;
    const ref = doc(this.colRef, returnId);
    const orderRef = doc(FIRESTORE, "orders", input.order.order_id);
    const occurredAt = businessDateKey();
    const holdUnverified = input.inventoryMode === "hold_unverified";
    let savedRecord: ReturnRecord | null = null;

    // Fuera de la transacción: dónde puede estar la pieza. Las asignaciones y los movimientos
    // son de solo agregar; la transacción vuelve a leer cada documento candidato.
    const evidence = await this.collectReturnEvidence(input.order.order_id, input.item, businessId);

    await runTransaction(FIRESTORE, async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) throw new Error("El pedido ya no existe.");
      const rawOrder = orderSnap.data() as Record<string, any>;
      const liveOrder = { ...rawOrder, order_id: orderSnap.id } as Order;
      // Idempotencia persistente: el mismo intento ya quedó registrado.
      const existingReturn = await tx.get(ref);
      if (existingReturn.exists()) {
        savedRecord = this.normalize(existingReturn.id, existingReturn.data() as Record<string, unknown>);
        return;
      }
      // "Marcar entregado" guardaba `delivered`; se valida con el nombre canónico.
      const liveStatus = normalizeOrderStatus(liveOrder.status);
      const allowedStages = new Set([
        "empaque", "ready_for_route", "assigned_to_run", "en_ruta",
        "entregado", "entregado_parcial", "pago_pendiente", "pagado_parcial", "pagado", "closed",
      ]);
      if (!allowedStages.has(liveStatus)) {
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

      // FIX 03B-1: "salió físicamente" se decide con evidencia de entrega, no con `pagado`
      // (un cobro antes de entregar no es entrega; ver order-closure.ts).
      const deliveredEvidence = hasDeliveryEvidence(rawOrder) || rawOrder["delivery_status"] === "delivered";
      const candidateIds = [...new Set([String(liveItem.inventory_id || "").trim(), ...evidence.candidateIds].filter(Boolean))].slice(0, 8);
      const inventoryRefs = candidateIds.map((id) => doc(FIRESTORE, "inventory_items", id));
      const allocationRefs = candidateIds.map((id) => doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocationDocId(liveOrder.order_id, liveItem.item_id, id)));
      const stopRef = liveOrder.route_run_id
        ? doc(FIRESTORE, "route_runs", liveOrder.route_run_id, "stops", liveOrder.route_stop_id || liveOrder.order_id)
        : null;
      const runRef = liveOrder.route_run_id ? doc(FIRESTORE, "route_runs", liveOrder.route_run_id) : null;
      const customerRef = doc(FIRESTORE, "customers", liveOrder.customer_id);
      const accountRef = input.paymentResolution === "refund" && input.refundAccountId
        ? doc(FIRESTORE, "finance_accounts", input.refundAccountId)
        : null;
      const periodRef = doc(FIRESTORE, "finance_periods", financePeriodDocumentId(businessId, monthIdFromDateInput(occurredAt)));

      const [inventorySnaps, allocationSnaps, stopSnap, runSnap, customerSnap, accountSnap, periodSnap] = await Promise.all([
        Promise.all(inventoryRefs.map((entry) => tx.get(entry))),
        Promise.all(allocationRefs.map((entry) => tx.get(entry))),
        stopRef ? tx.get(stopRef) : Promise.resolve(null),
        runRef ? tx.get(runRef) : Promise.resolve(null),
        tx.get(customerRef),
        accountRef ? tx.get(accountRef) : Promise.resolve(null),
        tx.get(periodRef),
      ]);
      if (periodSnap.exists() && periodSnap.data()["status"] === "closed") {
        throw new Error(`El periodo ${monthIdFromDateInput(occurredAt)} está cerrado. Reábrelo antes de registrar la devolución.`);
      }

      const inventoryById = new Map<string, Record<string, any>>();
      const candidates: ReturnInventoryCandidate[] = [];
      candidateIds.forEach((inventoryId, index) => {
        const snap = inventorySnaps[index];
        if (!snap.exists()) return;
        const data = snap.data() as Record<string, any>;
        if (normalizeBusinessId(data["business_id"]) !== businessId) return;
        inventoryById.set(inventoryId, data);
        const allocationSnap = allocationSnaps[index];
        candidates.push({
          inventoryId,
          allocation: allocationSnap.exists() ? normalizeAllocation(allocationSnap.id, allocationSnap.data() as Record<string, unknown>) : null,
          orderReservedQty: this.orderReservedQty(data["reservations"], liveOrder.order_id, liveItem.item_id),
          legacySoldQty: evidence.soldByInventory.get(inventoryId) || 0,
        });
      });
      const plan = planReturnInventory({
        requestedQty,
        hasDeliveryEvidence: deliveredEvidence,
        candidates,
        legacyReturnedQty: evidence.legacyReturnedQty,
      });
      if (plan.status === "unverified" && !holdUnverified) {
        throw new ReturnInventoryUnverifiedError(plan.reason, plan.coverableQty);
      }
      const legs = plan.status === "ok" ? plan.legs : [];
      const primaryInventoryId = plan.status === "ok" ? plan.primaryInventoryId : null;

      const currentReturned = Math.max(0, Math.trunc(Number(liveItem.returned_qty || 0)));
      const currentRestockable = Math.max(0, Math.trunc(Number(liveItem.returned_restockable_qty || 0)));
      const currentDamaged = Math.max(0, Math.trunc(Number(liveItem.returned_damaged_qty || 0)));
      const currentUnverified = Math.max(0, Math.trunc(Number(liveItem.returned_unverified_qty || 0)));
      const nextReturned = currentReturned + requestedQty;
      const isDamaged = input.disposition === "damaged";
      // FIX 03B-1.1: sin inventario comprobado la pieza NO cuenta como reintegrable (su costo no
      // vuelve a capital) hasta el conteo físico; queda aparte en `returned_unverified_qty`.
      const unverified = plan.status !== "ok";
      const nextItem: OrderItem = {
        ...liveItem,
        returned_qty: nextReturned,
        returned_restockable_qty: currentRestockable + (isDamaged || unverified ? 0 : requestedQty),
        returned_damaged_qty: currentDamaged + (isDamaged ? requestedQty : 0),
        ...(unverified && !isDamaged ? { returned_unverified_qty: currentUnverified + requestedQty } : {}),
        state: nextReturned >= Math.max(0, Number(liveItem.confirmed_qty ?? liveItem.quantity ?? 0)) ? "devuelto" : liveItem.state,
        inventory_id: primaryInventoryId || liveItem.inventory_id || null,
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

      const status: ReturnStatus = plan.status === "ok" ? this.statusForDisposition(input.disposition) : "inventory_unverified";
      const snapshot = this.productSnapshot(liveItem);
      const grossReturnAmount = money((liveItem.price_clienta ?? liveItem.price_public ?? 0) * requestedQty);
      const discountShare = money(beforeFinancials.netAmount - nextFinancials.netAmount < grossReturnAmount
        ? grossReturnAmount - (beforeFinancials.netAmount - nextFinancials.netAmount)
        : 0);
      const recoverableCost = isDamaged ? 0 : money((liveItem.price_cost || 0) * requestedQty);
      // Sin inventario comprobado no hay costo recuperado: queda como recuperación pendiente.
      const returnedCostAmount = plan.status === "ok" ? recoverableCost : 0;
      const pendingRecoveryCost = plan.status === "ok" ? 0 : recoverableCost;
      const record: ReturnRecord = {
        return_id: returnId,
        business_id: businessId,
        order_id: liveOrder.order_id,
        order_item_id: liveItem.item_id,
        qty: requestedQty,
        disposition: input.disposition,
        status,
        inventory_id: primaryInventoryId,
        inventory_legs: legs.map((leg) => ({ inventory_id: leg.inventoryId, kind: leg.kind, qty: leg.qty })),
        inventory_resolution: plan.status === "ok" ? (plan.usedLegacyEvidence ? "legacy_evidence" : "allocation") : "unverified",
        inventory_note: plan.status === "unverified" ? plan.reason : null,
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
        pending_recovery_cost_amount: pendingRecoveryCost,
        profit_impact: money(beforeFinancials.grossProfit - nextFinancials.grossProfit),
        payment_resolution: paymentResolution,
        resolution_amount: resolutionAmount,
        refund_account_id: input.refundAccountId || null,
        refund_method: input.refundMethod?.trim() || null,
        refund_reference: input.refundReference?.trim() || null,
        occurred_at: occurredAt,
      };

      // Una sola entrada por pieza física: cada pierna toca el documento donde la pieza
      // estaba. "restock_delivered" suma existencia (la pieza salió y regresó);
      // "release_reserved" solo libera la reserva (la pieza nunca salió).
      const legsByInventory = new Map<string, { restock: number; release: number; allocationLegs: typeof legs }>();
      for (const leg of legs) {
        const current = legsByInventory.get(leg.inventoryId) || { restock: 0, release: 0, allocationLegs: [] };
        if (leg.kind === "restock_delivered") current.restock += leg.qty;
        else current.release += leg.qty;
        current.allocationLegs.push(leg);
        legsByInventory.set(leg.inventoryId, current);
      }
      let movementIndex = 0;
      for (const [inventoryId, totals] of legsByInventory) {
        const inventoryData = inventoryById.get(inventoryId) || {};
        const { onHand, reserved, available, inReview, damaged } = readInventoryQuantities(inventoryData);
        const legQty = totals.restock + totals.release;
        const released = Math.min(totals.release, reserved);
        const reservations = this.releaseOrderReservations(inventoryData["reservations"], liveOrder.order_id, liveItem.item_id, released);
        const addAvailable = input.disposition === "available" ? legQty : 0;
        const addReview = input.disposition === "review" ? legQty : 0;
        const addDamaged = input.disposition === "damaged" ? legQty : 0;
        const inventoryRef = doc(FIRESTORE, "inventory_items", inventoryId);
        tx.update(inventoryRef, {
          on_hand_qty: onHand + totals.restock,
          reserved_qty: Math.max(0, reserved - released),
          available_qty: available + addAvailable,
          in_review_qty: inReview + addReview,
          damaged_qty: damaged + addDamaged,
          reservations,
          updated_at: serverTimestamp(),
        });
        const movementId = movementIndex === 0 ? `return_${returnId}` : `return_${returnId}_${movementIndex}`;
        movementIndex += 1;
        tx.set(doc(FIRESTORE, "inventory_movements", movementId), {
          movement_id: movementId,
          business_id: businessId,
          inventory_id: inventoryId,
          type: isDamaged ? "damage" : "return",
          delta_on_hand: totals.restock,
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
          write_off_amount: isDamaged ? money((liveItem.price_cost || 0) * legQty) : 0,
          created_at: serverTimestamp(),
        });
        const candidate = candidates.find((row) => row.inventoryId === inventoryId);
        if (candidate?.allocation) {
          let allocation: InventoryAllocation = candidate.allocation;
          for (const leg of totals.allocationLegs) {
            allocation = leg.kind === "restock_delivered"
              ? applyAllocationReturnRestock(allocation, leg.qty, movementId)
              : applyAllocationRelease(allocation, leg.qty, movementId, "return_before_delivery");
          }
          const { created_at: _createdAt, updated_at: _updatedAt, ...allocationFields } = allocation;
          tx.set(doc(FIRESTORE, INVENTORY_ALLOCATIONS_COLLECTION, allocation.allocation_id), {
            ...allocationFields,
            updated_at: serverTimestamp(),
          }, { merge: true });
        }
      }

      const nextPackages = deliveredEvidence ? liveOrder.packages : this.removeReturnedQtyFromPackages(liveOrder.packages || [], liveItem, requestedQty);
      const allReturned = nextItems.length > 0 && nextItems.every((row) => availableReturnQty(row) === 0);
      const eventLabel = `Devolución registrada: ${liveItem.title} (${requestedQty})`;
      // Firestore rechaza `undefined`: el actor solo se agrega si existe.
      const timeline = [...(liveOrder.timeline || []), {
        id: `t-${returnId}`,
        label: eventLabel,
        created_at: new Date().toISOString(),
        ...(input.createdBy ? { actor: input.createdBy } : {}),
      }];
      tx.update(orderRef, {
        items: nextItems,
        packages: nextPackages,
        totals: persistedTotals,
        has_returns: true,
        // Un pedido cerrado conserva su cierre histórico; la devolución queda como postventa (RC-02).
        status: allReturned && liveStatus !== "closed" ? "devuelto" : liveOrder.status,
        timeline,
        updated_at: serverTimestamp(),
      });
      tx.set(ref, { ...record, created_at: serverTimestamp(), updated_at: serverTimestamp(), restocked_at: status === "restocked" ? serverTimestamp() : null });
      tx.set(doc(FIRESTORE, "orders", liveOrder.order_id, "events", returnId), {
        id: returnId,
        orderId: liveOrder.order_id,
        type: plan.status === "ok" ? "RETURN_REGISTERED" : "RETURN_INVENTORY_UNVERIFIED",
        message: plan.status === "ok" ? eventLabel : `${eventLabel}. Sin ingreso a inventario: ${plan.reason}`,
        meta: {
          returnId,
          itemId: liveItem.item_id,
          qty: requestedQty,
          disposition: input.disposition,
          inventoryId: primaryInventoryId,
          legs: record.inventory_legs,
          resolution: record.inventory_resolution,
        },
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
          occurred_at: occurredAt,
          created_by: input.createdBy || null,
          created_at: serverTimestamp(),
        });
        tx.update(accountRef, {
          balance: money(Number(accountSnap.data()["balance"] || 0) - resolutionAmount),
          updated_at: serverTimestamp(),
        });
        const ledgerId = `ledger_refund_${refundId}`;
        const ledger = ledgerEntryPayload({
          entry_id: ledgerId,
          business_id: businessId,
          account_id: input.refundAccountId || null,
          kind: "refund",
          cash_effect: -resolutionAmount,
          occurred_at: occurredAt,
          source: "finance_refund",
          source_id: refundId,
          order_id: liveOrder.order_id,
          return_id: returnId,
          reverses_entry_id: null,
          data_quality: "native",
          notes: input.reason?.trim() || null,
          created_by: input.createdBy || null,
        });
        tx.set(doc(FIRESTORE, "finance_ledger_entries", ledgerId), { ...ledger, created_at: serverTimestamp() });
      }
      savedRecord = record;
    });

    // Antes: inventario completo + TODOS los movimientos del negocio tras cada devolución.
    await this.inventory.refreshAfterExternalMutation();
    if (!savedRecord) throw new Error("No se pudo completar la devolución.");
    return savedRecord;
  }

  /**
   * Resolución supervisada de una devolución registrada sin ingreso a inventario
   * (`inventory_unverified`): tras un conteo físico, la persona decide si la pieza se
   * reincorpora o no apareció. Idempotente: solo actúa si el registro sigue sin resolver.
   */
  async resolveUnverifiedReturn(row: ReturnRecord, outcome: "restock_after_count" | "not_found", actor?: string | null): Promise<void> {
    if (row.status !== "inventory_unverified") return;
    const inventoryId = String(row.product_snapshot["inventory_id"] || "").trim() || this.buildInventoryId(row.business_id, row.product_snapshot);
    const inventoryRef = doc(FIRESTORE, "inventory_items", inventoryId);
    const orderRef = doc(FIRESTORE, "orders", row.order_id);
    const returnRef = doc(this.colRef, row.return_id);
    await runTransaction(FIRESTORE, async (tx) => {
      const [returnSnap, inventorySnap, orderSnap] = await Promise.all([tx.get(returnRef), tx.get(inventoryRef), tx.get(orderRef)]);
      if (!returnSnap.exists() || returnSnap.data()["status"] !== "inventory_unverified") return;
      const isDamaged = row.disposition === "damaged";
      const liveReturn = this.normalize(returnSnap.id, returnSnap.data() as Record<string, unknown>);
      const unitCost = money(liveReturn.unit_cost || 0);
      // Costo que esperaba confirmarse (registros de FIX 03B-1 sin el campo: costo × piezas).
      const pendingCost = isDamaged ? 0 : money(liveReturn.pending_recovery_cost_amount ?? unitCost * row.qty);
      const liveOrder = orderSnap.exists() ? { ...orderSnap.data(), order_id: orderSnap.id } as Order : null;
      if (outcome === "restock_after_count") {
        const data = inventorySnap.exists() ? inventorySnap.data() as Record<string, any> : {};
        const { onHand, reserved, available, inReview, damaged } = readInventoryQuantities(data);
        const addAvailable = row.disposition === "available" ? row.qty : 0;
        const addReview = row.disposition === "review" ? row.qty : 0;
        const addDamaged = isDamaged ? row.qty : 0;
        tx.set(inventoryRef, {
          inventory_id: inventoryId,
          business_id: row.business_id,
          title: String(row.product_snapshot["title"] || "Producto devuelto"),
          sku: String(row.product_snapshot["product_id"] || inventoryId),
          product_id: row.product_snapshot["product_id"] ?? null,
          supplier_id: row.product_snapshot["supplier_id"] ?? null,
          variant_name: row.product_snapshot["variant"] ?? null,
          color_name: row.product_snapshot["color"] ?? null,
          on_hand_qty: onHand + row.qty,
          reserved_qty: reserved,
          available_qty: available + addAvailable,
          in_review_qty: inReview + addReview,
          damaged_qty: damaged + addDamaged,
          unit_price: data["unit_price"] ?? row.unit_cost ?? null,
          image_urls: data["image_urls"] || (row.product_snapshot["image_url"] ? [row.product_snapshot["image_url"]] : []),
          source_reason: data["source_reason"] || "devolucion",
          reservations: data["reservations"] || {},
          created_at: inventorySnap.exists() ? data["created_at"] || serverTimestamp() : serverTimestamp(),
          updated_at: serverTimestamp(),
        }, { merge: true });
        const movementId = `return_count_${row.return_id}`;
        tx.set(doc(FIRESTORE, "inventory_movements", movementId), {
          movement_id: movementId,
          business_id: row.business_id,
          inventory_id: inventoryId,
          type: "adjustment",
          delta_on_hand: row.qty,
          delta_available: addAvailable,
          delta_reserved: 0,
          delta_in_review: addReview,
          delta_damaged: addDamaged,
          order_id: row.order_id,
          order_item_id: row.order_item_id,
          return_id: row.return_id,
          reason: "Devolución reincorporada tras conteo físico",
          actor: actor || null,
          idempotency_key: movementId,
          write_off_amount: 0,
          created_at: serverTimestamp(),
        });
        // FIX 03B-1.1: hasta ahora el costo se reconoce como recuperado (una sola vez: la
        // transacción solo actúa si el registro sigue `inventory_unverified`).
        if (liveOrder && !isDamaged) {
          const items = (liveOrder.items || []).map((item) => item.item_id === row.order_item_id
            ? {
                ...item,
                returned_restockable_qty: Math.min(Number(item.returned_qty || 0), Number(item.returned_restockable_qty || 0) + row.qty),
                returned_unverified_qty: Math.max(0, Number(item.returned_unverified_qty || 0) - row.qty),
              }
            : item);
          tx.update(orderRef, { items, totals: toPersistedOrderTotals({ ...liveOrder, items }), updated_at: serverTimestamp() });
        }
        tx.update(returnRef, {
          status: this.statusForDisposition(row.disposition),
          inventory_id: inventoryId,
          inventory_resolution: "physical_count",
          returned_cost_amount: pendingCost,
          pending_recovery_cost_amount: 0,
          // La pieza apareció: el costo deja de ser pérdida de la devolución.
          profit_impact: money(Math.max(0, Number(liveReturn.profit_impact || 0) - pendingCost)),
          restocked_at: row.disposition === "available" ? serverTimestamp() : null,
          updated_at: serverTimestamp(),
        });
        return;
      }
      // La pieza no apareció: no entra a inventario, no hay costo recuperado y pasa a merma.
      if (liveOrder && !isDamaged) {
        const items = (liveOrder.items || []).map((item) => {
          if (item.item_id !== row.order_item_id) return item;
          const unverifiedQty = Number(item.returned_unverified_qty || 0);
          // FIX 03B-1.1: la pieza estaba en `returned_unverified_qty`. Registros de FIX 03B-1
          // (sin ese campo) la habían sumado a reintegrables: se le resta de ahí.
          const fromUnverified = Math.min(unverifiedQty, row.qty);
          return {
            ...item,
            returned_unverified_qty: Math.max(0, unverifiedQty - fromUnverified),
            returned_restockable_qty: Math.max(0, Number(item.returned_restockable_qty || 0) - (row.qty - fromUnverified)),
            returned_damaged_qty: Math.min(Number(item.returned_qty || 0), Number(item.returned_damaged_qty || 0) + row.qty),
          };
        });
        tx.update(orderRef, { items, totals: toPersistedOrderTotals({ ...liveOrder, items }), updated_at: serverTimestamp() });
      }
      tx.update(returnRef, {
        status: "damaged",
        disposition: "damaged",
        returned_cost_amount: 0,
        pending_recovery_cost_amount: 0,
        inventory_resolution: "not_found",
        updated_at: serverTimestamp(),
      });
    });
    await this.inventory.refreshAfterExternalMutation();
  }

  /**
   * Documentos de inventario donde puede estar la pieza de una línea, en orden de
   * confianza: asignaciones (FIX 03B-1), operación de proveedor, movimientos del pedido.
   * Cada lectura es opcional: un permiso faltante solo reduce la evidencia; nunca la inventa.
   */
  private async collectReturnEvidence(orderId: string, item: OrderItem, businessId: BusinessId): Promise<{
    candidateIds: string[];
    soldByInventory: Map<string, number>;
    legacyReturnedQty: number;
  }> {
    const candidateIds: string[] = [];
    const allocations = await this.inventory.loadAllocationsForOrder(orderId, businessId).catch(() => []);
    for (const allocation of allocations) {
      if (allocation.order_item_id === item.item_id) candidateIds.push(allocation.inventory_id);
    }
    if (candidateIds.length > 0) {
      return { candidateIds, soldByInventory: new Map(), legacyReturnedQty: 0 };
    }
    const opSnap = await getDoc(doc(FIRESTORE, "supplier_operations", `op-${orderId}-${item.item_id}`)).catch(() => null);
    const opInventoryId = opSnap?.exists() ? String(opSnap.data()["inventory_item_id"] || "").trim() : "";
    if (opInventoryId) candidateIds.push(opInventoryId);
    const movementsSnap = await getDocs(query(
      collection(FIRESTORE, "inventory_movements"),
      where("business_id", "==", businessId),
      where("order_id", "==", orderId),
    )).catch(() => null);
    const movements = (movementsSnap?.docs || []).map((entry) => entry.data() as Record<string, unknown>);
    for (const row of movements) {
      const type = String(row["type"] || "");
      if (String(row["order_item_id"] || "") !== item.item_id) continue;
      if (type === "reserve" || type === "sale") candidateIds.push(String(row["inventory_id"] || ""));
    }
    const legacy = legacyEvidenceFromMovements(movements, item.item_id);
    return { candidateIds: candidateIds.filter(Boolean), soldByInventory: legacy.soldByInventory, legacyReturnedQty: legacy.returnedQty };
  }

  private orderReservedQty(raw: unknown, orderId: string, orderItemId: string): number {
    const reservations = (raw && typeof raw === "object" ? raw : {}) as Record<string, { qty?: unknown; status?: unknown }>;
    return [orderId, `${orderId}:${orderItemId}`].reduce((sum, key) => {
      const row = reservations[key];
      if (!row || (row.status && row.status !== "reserved")) return sum;
      return sum + Math.max(0, Math.trunc(Number(row.qty || 0)));
    }, 0);
  }

  private releaseOrderReservations(raw: unknown, orderId: string, orderItemId: string, qty: number): Record<string, unknown> {
    const reservations = { ...((raw && typeof raw === "object" ? raw : {}) as Record<string, any>) };
    let remaining = Math.max(0, Math.trunc(qty));
    for (const key of [orderId, `${orderId}:${orderItemId}`]) {
      if (remaining <= 0) break;
      const current = Math.max(0, Math.trunc(Number(reservations[key]?.qty || 0)));
      const take = Math.min(current, remaining);
      if (take <= 0) continue;
      remaining -= take;
      if (current - take <= 0) delete reservations[key];
      else reservations[key] = { ...reservations[key], qty: current - take, status: "reserved", updated_at: new Date().toISOString() };
    }
    return reservations;
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
      const { onHand, available, inReview: reviewQty } = readInventoryQuantities(data);
      const moved = Math.min(row.qty, reviewQty);
      const missingLegacyQty = Math.max(0, row.qty - moved);
      tx.set(inventoryRef, {
        inventory_id: inventoryId,
        business_id: row.business_id,
        title: String(row.product_snapshot["title"] || "Producto devuelto"),
        sku: String(row.product_snapshot["product_id"] || row.product_snapshot["inventory_id"] || inventoryId),
        on_hand_qty: onHand + missingLegacyQty,
        available_qty: available + row.qty,
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
        write_off_amount: money(row.unit_cost * row.qty),
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
    await this.inventory.refreshAfterExternalMutation();
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
    await this.inventory.refreshAfterExternalMutation();
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
      inventory_legs: Array.isArray(data["inventory_legs"])
        ? (data["inventory_legs"] as Array<Record<string, unknown>>).map((leg) => ({
            inventory_id: String(leg["inventory_id"] || ""),
            kind: leg["kind"] === "release_reserved" ? "release_reserved" as const : "restock_delivered" as const,
            qty: Math.max(0, Math.trunc(Number(leg["qty"] || 0))),
          }))
        : [],
      inventory_resolution: this.normalizeResolution(data["inventory_resolution"]),
      inventory_note: this.nullableText(data["inventory_note"]),
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
      ...(data["pending_recovery_cost_amount"] !== undefined && data["pending_recovery_cost_amount"] !== null
        ? { pending_recovery_cost_amount: this.safePrice(data["pending_recovery_cost_amount"]) || 0 }
        : {}),
      profit_impact: this.safePrice(data["profit_impact"]) || 0,
      payment_resolution: this.normalizePaymentResolution(data["payment_resolution"]),
      resolution_amount: this.safePrice(data["resolution_amount"]) || 0,
      refund_account_id: this.nullableText(data["refund_account_id"]),
      refund_method: this.nullableText(data["refund_method"]),
      refund_reference: this.nullableText(data["refund_reference"]),
      occurred_at: this.normalizeOccurredAt(data["occurred_at"] || data["created_at"]),
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
    if (value === "restocked" || value === "damaged" || value === "inventory_unverified") return value;
    return "pending_review";
  }

  private normalizeResolution(value: unknown): ReturnInventoryResolution {
    const allowed: ReturnInventoryResolution[] = ["allocation", "legacy_evidence", "unverified", "physical_count", "not_found"];
    return allowed.includes(value as ReturnInventoryResolution) ? value as ReturnInventoryResolution : "legacy_unknown";
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

  private normalizeOccurredAt(value: unknown): string {
    if (typeof value === "string" && value.trim()) return value.slice(0, 10);
    if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
      return businessDateKey((value as { toDate: () => Date }).toDate());
    }
    return businessDateKey();
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
