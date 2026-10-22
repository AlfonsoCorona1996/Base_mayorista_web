import { calculateOrderFinancials, type FinancialOrderLike } from "./order-financials";

/**
 * Reglas de entrega, cobro y cierre que no deben inferirse unas de otras (RC-01/RC-02).
 *
 * `status` mezcla etapa, entrega y cobro. Mientras exista ese campo único, estas
 * funciones son la única interpretación permitida de "¿se entregó?" y "¿está cerrado?".
 */
export interface ClosureOrderLike extends FinancialOrderLike {
  status?: string | null;
  delivery_status?: string | null;
  delivered_at?: unknown;
}

/** Estados que solo se alcanzan después de una entrega registrada. */
const POST_DELIVERY_STATUSES = new Set([
  "entregado", "delivered", "entregado_parcial", "delivered_partial", "pago_pendiente", "pagado_parcial", "pagado", "closed",
]);

/**
 * Hay evidencia real de entrega: una fecha de entrega guardada o un estado de entrega
 * explícito. Un cobro (`pagado`) por sí solo NO demuestra entrega.
 */
export function hasDeliveryEvidence(order: ClosureOrderLike | null | undefined): boolean {
  if (!order) return false;
  const status = String(order.status || "");
  return Boolean(order.delivered_at) || status === "entregado" || status === "delivered";
}

/**
 * El pedido ya pasó por la entrega según su etapa guardada. Se usa para decidir si un
 * cobro puede expresarse en `status` (`pagado`, `pagado_parcial`, `pago_pendiente`) sin
 * borrar la etapa operativa de un pedido que todavía no se entrega.
 */
export function isAtOrAfterDelivery(order: ClosureOrderLike | null | undefined): boolean {
  if (!order) return false;
  return Boolean(order.delivered_at) || POST_DELIVERY_STATUSES.has(String(order.status || ""));
}

/**
 * Estado que debe guardarse tras un cobro. Antes de la entrega se conserva la etapa:
 * el cobro queda en `customer_payment_status` y en los montos.
 */
export function statusAfterCollection(
  order: ClosureOrderLike,
  paymentStatus: "pending" | "partial" | "collected",
): string {
  if (!isAtOrAfterDelivery(order)) return String(order.status || "borrador");
  if (String(order.status || "") === "closed") return "closed";
  return paymentStatus === "collected" ? "pagado" : paymentStatus === "partial" ? "pagado_parcial" : "pago_pendiente";
}

/** Estado tras registrar una entrega completa, según lo ya cobrado. */
export function statusAfterDelivery(paymentStatus: string | null | undefined): "entregado" | "pagado" | "pagado_parcial" {
  if (paymentStatus === "collected") return "pagado";
  if (paymentStatus === "partial") return "pagado_parcial";
  return "entregado";
}

/** Saldo cero según el cálculo vigente (no el `balance_due` guardado, que puede estar desfasado). */
export function isFullySettled(order: ClosureOrderLike): boolean {
  return calculateOrderFinancials(order).balanceDue <= 0;
}

/**
 * Cierre verdadero: estado `closed`, fecha de entrega real y saldo cero. Un `closed`
 * sin fecha de entrega es ambiguo y NO se trata como cerrado (no debe ocultarse).
 */
export function isTrulyClosed(order: ClosureOrderLike | null | undefined): boolean {
  if (!order) return false;
  return String(order.status || "") === "closed" && Boolean(order.delivered_at) && isFullySettled(order);
}

/** Elegible para cierre por conciliación: entrega real y liquidación completa (RC-02). */
export function canCloseBySettlement(order: ClosureOrderLike, paymentStatus: string | null | undefined): boolean {
  return Boolean(order.delivered_at)
    && order.delivery_status === "delivered"
    && paymentStatus === "collected"
    && isFullySettled(order);
}
