export interface SupplierOperationStateData {
  order_id?: unknown;
  reserved_for_order_id?: unknown;
  order_item_id?: unknown;
  status?: unknown;
  quantity?: unknown;
  received_to_inventory?: unknown;
  reservation_applied?: unknown;
  received_qty?: unknown;
  reserved_qty_for_order?: unknown;
}

const STATUS_RANK: Record<string, number> = {
  por_levantar: 0,
  levantado: 1,
  en_camino: 2,
  recibido: 3,
};

function safeQuantity(value: unknown): number {
  const quantity = Number(value ?? 0);
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.round(quantity));
}

export function supplierOperationReservedForOrderId(data: SupplierOperationStateData): string {
  if (Object.prototype.hasOwnProperty.call(data, "reserved_for_order_id")) {
    return String(data.reserved_for_order_id ?? "").trim();
  }
  return String(data.order_id ?? "").trim();
}

export function isSupplierReceiptComplete(data: SupplierOperationStateData): boolean {
  if (String(data.status ?? "") !== "recibido") return false;
  if (data.received_to_inventory !== true) return false;

  const quantity = safeQuantity(data.quantity);
  if (safeQuantity(data.received_qty) < quantity) return false;

  const reservedForOrderId = supplierOperationReservedForOrderId(data);
  const orderItemId = String(data.order_item_id ?? "").trim();
  const requiresReservation = !!reservedForOrderId && !!orderItemId && quantity > 0;
  if (!requiresReservation) return true;

  return data.reservation_applied === true
    && safeQuantity(data.reserved_qty_for_order) >= quantity;
}

export function canAdvanceSupplierOperationStatus(currentStatus: string, nextStatus: string): boolean {
  const currentRank = STATUS_RANK[currentStatus];
  const nextRank = STATUS_RANK[nextStatus];
  if (currentRank === undefined || nextRank === undefined) return false;
  return nextRank >= currentRank;
}
