import type { Order } from "../../core/orders.service";
import { calculateOrderFinancials } from "../../core/order-financials";

const TABLE_PAYABLE_ORDER_STATUSES = new Set([
  "ready_for_route",
  "assigned_to_run",
  "in_transit",
  "en_ruta",
  "delivered",
  "delivered_partial",
  "entregado",
  "pago_pendiente",
  "pagado_parcial",
]);

export function canMarkOrderAsPaidFromTable(order: Order): boolean {
  const isPayableStage =
    TABLE_PAYABLE_ORDER_STATUSES.has(order.status) || order.delivery_status === "delivered";
  if (!isPayableStage) return false;
  if (order.customer_payment_status === "collected" || order.collection_status === "paid") {
    return false;
  }

  const financials = calculateOrderFinancials(order);
  return financials.balanceDue > 0 || (order.status === "ready_for_route" && financials.netAmount <= 0);
}
