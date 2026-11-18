/**
 * Asignaciones de inventario (FIX 03B-1).
 *
 * Una asignación vincula UNA línea de pedido (`order_id` + `order_item_id`) con UN
 * documento de inventario (`inventory_id`) y lleva las cantidades que esa línea tiene en
 * ese documento: apartadas, entregadas (consumidas), devueltas y liberadas.
 *
 * Se guarda en `inventory_allocations/{allocationDocId}` y se escribe SIEMPRE en la misma
 * transacción que modifica el documento de inventario. Así:
 *
 * - una entrega solo consume lo que su propia línea tiene apartado (nunca la reserva de
 *   otro pedido del mismo SKU);
 * - una devolución sabe en qué documento estaba la pieza y si salió o no físicamente;
 * - un reintento no aplica dos veces el mismo movimiento (las llaves de idempotencia
 *   siguen viviendo en el documento de inventario).
 *
 * Los pedidos anteriores a este cambio no tienen asignaciones. Nunca se inventan: se leen
 * con la regla de compatibilidad de `planReturnInventory` (reserva viva del pedido o
 * evidencia de venta en `inventory_movements`) y, si no hay evidencia, la devolución se
 * registra sin crear existencias.
 */

export const INVENTORY_ALLOCATIONS_COLLECTION = "inventory_allocations";

export type InventoryAllocationSource =
  | "own_stock"
  | "supplier_receipt"
  | "manual_item"
  | "late_arrival"
  | "unknown";

export interface InventoryAllocation {
  allocation_id: string;
  business_id: string;
  order_id: string;
  order_item_id: string;
  inventory_id: string;
  source: InventoryAllocationSource;
  supplier_id: string | null;
  supplier_operation_id: string | null;
  /** Piezas apartadas hoy para esta línea en este documento (aún dentro de la bodega). */
  reserved_qty: number;
  /** Piezas que salieron físicamente con la entrega (consumidas de la reserva). */
  delivered_qty: number;
  /** Piezas entregadas que regresaron por devolución y se reincorporaron a este documento. */
  returned_qty: number;
  /** Piezas devueltas ANTES de salir (la devolución liberó la reserva, no sumó existencia). */
  return_released_qty: number;
  /** Piezas liberadas por cambios del pedido (quitar artículo, bajar cantidad, borrar pedido). */
  released_qty: number;
  /** Total apartado alguna vez (histórico, solo sube). */
  allocated_total_qty: number;
  last_movement_id: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface AllocationMeta {
  source?: InventoryAllocationSource;
  supplierId?: string | null;
  supplierOperationId?: string | null;
}

function safeQty(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function safeIdPart(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 90);
}

/** Id determinista: el mismo pedido + línea + inventario siempre cae en el mismo documento. */
export function allocationDocId(orderId: string, orderItemId: string, inventoryId: string): string {
  return `alloc__${safeIdPart(orderId)}__${safeIdPart(orderItemId)}__${safeIdPart(inventoryId)}`.slice(0, 300);
}

export function normalizeAllocation(id: string, raw: Record<string, unknown> | null | undefined): InventoryAllocation | null {
  if (!raw) return null;
  const source = String(raw["source"] || "unknown") as InventoryAllocationSource;
  return {
    allocation_id: String(raw["allocation_id"] || id),
    business_id: String(raw["business_id"] || "bm"),
    order_id: String(raw["order_id"] || ""),
    order_item_id: String(raw["order_item_id"] || ""),
    inventory_id: String(raw["inventory_id"] || ""),
    source: ["own_stock", "supplier_receipt", "manual_item", "late_arrival"].includes(source) ? source : "unknown",
    supplier_id: raw["supplier_id"] ? String(raw["supplier_id"]) : null,
    supplier_operation_id: raw["supplier_operation_id"] ? String(raw["supplier_operation_id"]) : null,
    reserved_qty: safeQty(raw["reserved_qty"]),
    delivered_qty: safeQty(raw["delivered_qty"]),
    returned_qty: safeQty(raw["returned_qty"]),
    return_released_qty: safeQty(raw["return_released_qty"]),
    released_qty: safeQty(raw["released_qty"]),
    allocated_total_qty: safeQty(raw["allocated_total_qty"]),
    last_movement_id: raw["last_movement_id"] ? String(raw["last_movement_id"]) : null,
    created_at: raw["created_at"] ?? null,
    updated_at: raw["updated_at"] ?? null,
  };
}

export function emptyAllocation(input: {
  businessId: string;
  orderId: string;
  orderItemId: string;
  inventoryId: string;
  meta?: AllocationMeta;
}): InventoryAllocation {
  return {
    allocation_id: allocationDocId(input.orderId, input.orderItemId, input.inventoryId),
    business_id: input.businessId,
    order_id: input.orderId,
    order_item_id: input.orderItemId,
    inventory_id: input.inventoryId,
    source: input.meta?.source || "unknown",
    supplier_id: input.meta?.supplierId ?? null,
    supplier_operation_id: input.meta?.supplierOperationId ?? null,
    reserved_qty: 0,
    delivered_qty: 0,
    returned_qty: 0,
    return_released_qty: 0,
    released_qty: 0,
    allocated_total_qty: 0,
    last_movement_id: null,
  };
}

/** Piezas entregadas que todavía pueden regresar a este documento. */
export function deliveredOpenQty(allocation: InventoryAllocation): number {
  return Math.max(0, allocation.delivered_qty - allocation.returned_qty);
}

export function applyAllocationReserve(allocation: InventoryAllocation, qty: number, movementId: string): InventoryAllocation {
  const amount = safeQty(qty);
  return {
    ...allocation,
    reserved_qty: allocation.reserved_qty + amount,
    allocated_total_qty: allocation.allocated_total_qty + amount,
    last_movement_id: movementId,
  };
}

/**
 * Cuánto puede liberar o consumir una línea en un documento. Con asignación, el tope es lo
 * que ESA línea tiene apartado. Sin asignación (pedido anterior a FIX 03B-1), el tope es la
 * reserva del pedido en el documento (`reservations[orderId]`). Nunca el `reserved_qty`
 * global del documento: ese incluye reservas de otros pedidos.
 */
export function reservationCapForLine(input: {
  allocation: InventoryAllocation | null;
  orderReservedQty: number;
  docReservedQty: number;
  docOnHandQty: number;
}): number {
  const ownCap = input.allocation ? input.allocation.reserved_qty : safeQty(input.orderReservedQty);
  return Math.max(0, Math.min(ownCap, safeQty(input.orderReservedQty), safeQty(input.docReservedQty), safeQty(input.docOnHandQty)));
}

export function applyAllocationRelease(
  allocation: InventoryAllocation,
  qty: number,
  movementId: string,
  reason: "order_change" | "return_before_delivery" = "order_change",
): InventoryAllocation {
  const amount = Math.min(safeQty(qty), allocation.reserved_qty);
  return {
    ...allocation,
    reserved_qty: allocation.reserved_qty - amount,
    released_qty: allocation.released_qty + (reason === "order_change" ? amount : 0),
    return_released_qty: allocation.return_released_qty + (reason === "return_before_delivery" ? amount : 0),
    last_movement_id: movementId,
  };
}

export function applyAllocationConsume(allocation: InventoryAllocation, qty: number, movementId: string): InventoryAllocation {
  const amount = Math.min(safeQty(qty), allocation.reserved_qty);
  return {
    ...allocation,
    reserved_qty: allocation.reserved_qty - amount,
    delivered_qty: allocation.delivered_qty + amount,
    last_movement_id: movementId,
  };
}

export function applyAllocationReturnRestock(allocation: InventoryAllocation, qty: number, movementId: string): InventoryAllocation {
  const amount = Math.min(safeQty(qty), deliveredOpenQty(allocation));
  return {
    ...allocation,
    returned_qty: allocation.returned_qty + amount,
    last_movement_id: movementId,
  };
}

// ---------------------------------------------------------------------------
// Plan de devolución
// ---------------------------------------------------------------------------

/**
 * Evidencia por documento de inventario para una línea de pedido.
 * - `allocation`: la asignación de FIX 03B-1, si existe.
 * - `orderReservedQty`: reserva viva del pedido en el documento (`reservations[orderId]`).
 * - `legacySoldQty`: piezas que `inventory_movements` muestra que salieron (venta con
 *   `delta_on_hand < 0`) para esta línea en este documento. Solo para pedidos sin asignación.
 */
export interface ReturnInventoryCandidate {
  inventoryId: string;
  allocation: InventoryAllocation | null;
  orderReservedQty: number;
  legacySoldQty: number;
}

export type ReturnLegKind =
  /** La pieza salió y regresa: suma existencia física al mismo documento. */
  | "restock_delivered"
  /** La pieza nunca salió: se libera la reserva; la existencia física no cambia. */
  | "release_reserved";

export interface ReturnInventoryLeg {
  inventoryId: string;
  kind: ReturnLegKind;
  qty: number;
  /** La pierna proviene de una asignación (true) o de la regla de compatibilidad (false). */
  fromAllocation: boolean;
}

export type ReturnInventoryPlan =
  | { status: "ok"; legs: ReturnInventoryLeg[]; primaryInventoryId: string; usedLegacyEvidence: boolean }
  | { status: "unverified"; reason: string; coverableQty: number };

/**
 * Decide de dónde sale y a dónde regresa cada pieza devuelta. Función pura.
 *
 * Reglas:
 * 1. Con asignaciones (pedidos nuevos): primero las piezas que coinciden con la evidencia
 *    de entrega del pedido (entregadas si hay entrega; apartadas si no), luego el resto.
 *    Nunca más de lo entregado-no-devuelto + lo apartado.
 * 2. Sin asignaciones (pedidos anteriores): si el pedido aún tiene reserva viva en un
 *    documento, la pieza nunca salió del inventario contable → se libera esa reserva
 *    (caso María Zara). Si no hay reserva pero `inventory_movements` prueba la venta, la
 *    pieza vuelve a ese mismo documento. `legacyReturnedQty` descuenta devoluciones previas
 *    de la línea (en cualquier documento) para no reincorporar dos veces.
 * 3. Si la evidencia no cubre la cantidad pedida → `unverified`: no se crea existencia.
 */
export function planReturnInventory(input: {
  requestedQty: number;
  hasDeliveryEvidence: boolean;
  candidates: ReturnInventoryCandidate[];
  /** Piezas de esta línea ya devueltas con el modelo anterior (movimientos `return`/`damage`). */
  legacyReturnedQty?: number;
}): ReturnInventoryPlan {
  const requested = safeQty(input.requestedQty);
  if (requested <= 0) return { status: "unverified", reason: "Cantidad inválida.", coverableQty: 0 };

  const withAllocation = input.candidates.filter((row) => row.allocation);
  if (withAllocation.length > 0) {
    const delivered = withAllocation.map((row) => ({ id: row.inventoryId, qty: deliveredOpenQty(row.allocation!) }));
    const reserved = withAllocation.map((row) => ({
      id: row.inventoryId,
      qty: Math.min(row.allocation!.reserved_qty, safeQty(row.orderReservedQty)),
    }));
    const order: Array<{ kind: ReturnLegKind; rows: Array<{ id: string; qty: number }> }> = input.hasDeliveryEvidence
      ? [{ kind: "restock_delivered", rows: delivered }, { kind: "release_reserved", rows: reserved }]
      : [{ kind: "release_reserved", rows: reserved }, { kind: "restock_delivered", rows: delivered }];
    const legs = takeLegs(requested, order, true);
    const covered = legs.reduce((sum, leg) => sum + leg.qty, 0);
    if (covered < requested) {
      return {
        status: "unverified",
        reason: `El inventario de este artículo solo registra ${covered} pieza(s) entregadas o apartadas sin devolver.`,
        coverableQty: covered,
      };
    }
    return { status: "ok", legs, primaryInventoryId: legs[0].inventoryId, usedLegacyEvidence: false };
  }

  // Compatibilidad: pedidos sin asignación.
  const reservedRows = input.candidates.map((row) => ({ id: row.inventoryId, qty: safeQty(row.orderReservedQty) }));
  let legacyReturned = safeQty(input.legacyReturnedQty);
  const soldRows = input.candidates.map((row) => {
    const sold = safeQty(row.legacySoldQty);
    const usable = Math.max(0, sold - legacyReturned);
    legacyReturned = Math.max(0, legacyReturned - sold);
    return { id: row.inventoryId, qty: usable };
  });
  const legs = takeLegs(requested, [
    { kind: "release_reserved", rows: reservedRows },
    { kind: "restock_delivered", rows: soldRows },
  ], false);
  const covered = legs.reduce((sum, leg) => sum + leg.qty, 0);
  if (covered < requested) {
    return {
      status: "unverified",
      reason: covered > 0
        ? `Solo hay evidencia de inventario para ${covered} de ${requested} pieza(s) de este artículo.`
        : "Este pedido no tiene registro de en qué inventario se apartó ni de que la pieza haya salido al entregarse.",
      coverableQty: covered,
    };
  }
  return { status: "ok", legs, primaryInventoryId: legs[0].inventoryId, usedLegacyEvidence: true };
}

function takeLegs(
  requested: number,
  groups: Array<{ kind: ReturnLegKind; rows: Array<{ id: string; qty: number }> }>,
  fromAllocation: boolean,
): ReturnInventoryLeg[] {
  let remaining = requested;
  const legs: ReturnInventoryLeg[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (remaining <= 0) return legs;
      const take = Math.min(remaining, safeQty(row.qty));
      if (take <= 0 || !row.id) continue;
      legs.push({ inventoryId: row.id, kind: group.kind, qty: take, fromAllocation });
      remaining -= take;
    }
  }
  return legs;
}

/**
 * Evidencia de venta y devoluciones previas a partir de `inventory_movements` (inmutables).
 * Solo para pedidos sin asignación.
 */
export function legacyEvidenceFromMovements(
  movements: Array<{ inventory_id?: unknown; order_item_id?: unknown; type?: unknown; delta_on_hand?: unknown }>,
  orderItemId: string,
): { soldByInventory: Map<string, number>; returnedQty: number } {
  const soldByInventory = new Map<string, number>();
  let returnedQty = 0;
  for (const row of movements) {
    if (String(row.order_item_id || "") !== orderItemId) continue;
    const inventoryId = String(row.inventory_id || "");
    const deltaOnHand = Number(row.delta_on_hand || 0);
    const type = String(row.type || "");
    if (type === "sale" && deltaOnHand < 0 && inventoryId) {
      soldByInventory.set(inventoryId, (soldByInventory.get(inventoryId) || 0) + Math.abs(Math.round(deltaOnHand)));
    }
    if ((type === "return" || type === "damage") && deltaOnHand > 0) {
      returnedQty += Math.round(deltaOnHand);
    }
  }
  return { soldByInventory, returnedQty };
}
