import { FinancialOrderLike, calculateOrderFinancials, money } from "./order-financials";

export type OrderProfitProjectionStage =
  | "in_process"
  | "pending_collection"
  | "settled"
  | "excluded";

export interface ProfitProjectionOrder extends FinancialOrderLike {
  status?: string | null;
  delivered_at?: unknown;
}

export interface OrderProfitProjection {
  stage: OrderProfitProjectionStage;
  projectedProfit: number;
  pendingBalance: number;
}

const DELIVERED_STATUSES = new Set([
  "entregado",
  "entregado_parcial",
  "pago_pendiente",
  "pagado_parcial",
  "pagado",
  "closed",
]);

const EXCLUDED_STATUSES = new Set(["cancelado", "devuelto"]);

/**
 * Separa la utilidad que aun depende de completar el pedido de la utilidad que
 * ya se genero al entregar, pero sigue dentro de una cuenta por cobrar.
 *
 * La proyeccion de un pedido entregado solo incluye la proporcion de margen
 * asociada a su saldo. La de un pedido activo no entregado incluye todo su
 * margen estimado, porque todavia puede cambiar antes del cierre.
 */
export function calculateOrderProfitProjection(order: ProfitProjectionOrder): OrderProfitProjection {
  const status = String(order.status || "").trim().toLowerCase();
  if (EXCLUDED_STATUSES.has(status)) {
    return { stage: "excluded", projectedProfit: 0, pendingBalance: 0 };
  }

  const financials = calculateOrderFinancials(order);
  const delivered = DELIVERED_STATUSES.has(status) || Boolean(order.delivered_at);

  if (!delivered) {
    return {
      stage: "in_process",
      projectedProfit: money(financials.grossProfit),
      pendingBalance: 0,
    };
  }

  const paid = Math.min(financials.netAmount, Math.max(0, financials.paidAmount));
  const pendingBalance = Math.max(0, money(financials.netAmount - paid));
  if (financials.netAmount <= 0 || pendingBalance <= 0) {
    return { stage: "settled", projectedProfit: 0, pendingBalance: 0 };
  }

  const pendingRatio = Math.min(1, pendingBalance / financials.netAmount);
  return {
    stage: "pending_collection",
    projectedProfit: money(financials.grossProfit * pendingRatio),
    pendingBalance,
  };
}
