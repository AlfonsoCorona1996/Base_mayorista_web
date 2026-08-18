import { FinancialOrderLike, calculateOrderFinancials, money } from "./order-financials";

export interface WithdrawalProfitOrder extends FinancialOrderLike {
  status?: string | null;
  delivered_at?: string | null;
}

export interface WithdrawalProfitBreakdown {
  collectedRevenue: number;
  deliveredGrossCost: number;
  expensesTotal: number;
  collectedProfitBase: number;
  pendingCollection: number;
  pendingProfit: number;
  accruedNetProfit: number;
}

export interface PartnerWithdrawalSummary {
  distributableBase: number;
  perPartnerTarget: number;
  pendingBlanca: number;
  pendingAndreaPepe: number;
  excessBlanca: number;
  excessAndreaPepe: number;
}

const DELIVERED_STATUSES = new Set([
  "entregado",
  "delivered",
  "delivered_partial",
  "pago_pendiente",
  "pagado_parcial",
  "pagado",
  "closed",
]);

export function isDeliveredForProfit(order: WithdrawalProfitOrder): boolean {
  return DELIVERED_STATUSES.has(String(order.status || "").trim().toLowerCase()) || Boolean(order.delivered_at);
}

export function calculateWithdrawalProfit(
  orders: WithdrawalProfitOrder[],
  expensesTotal: number,
): WithdrawalProfitBreakdown {
  let collectedRevenue = 0;
  let deliveredGrossCost = 0;
  let pendingCollection = 0;
  let pendingProfit = 0;
  let accruedGrossProfit = 0;

  for (const order of orders) {
    if (!isDeliveredForProfit(order)) continue;

    const financials = calculateOrderFinancials(order);
    const paid = Math.min(financials.netAmount, Math.max(0, financials.paidAmount));
    const balance = Math.max(0, money(financials.netAmount - paid));
    const pendingRatio = financials.netAmount > 0 ? Math.min(1, balance / financials.netAmount) : 0;

    collectedRevenue += paid;
    deliveredGrossCost += financials.grossCost;
    pendingCollection += balance;
    pendingProfit += Math.max(0, financials.grossProfit) * pendingRatio;
    accruedGrossProfit += financials.grossProfit;
  }

  const safeExpenses = Math.max(0, money(expensesTotal));

  return {
    collectedRevenue: money(collectedRevenue),
    deliveredGrossCost: money(deliveredGrossCost),
    expensesTotal: safeExpenses,
    collectedProfitBase: money(collectedRevenue - deliveredGrossCost - safeExpenses),
    pendingCollection: money(pendingCollection),
    pendingProfit: money(pendingProfit),
    accruedNetProfit: money(accruedGrossProfit - safeExpenses),
  };
}

export function calculatePartnerWithdrawalSummary(
  collectedProfitBase: number,
  withdrawnBlanca: number,
  withdrawnAndreaPepe: number,
  withdrawnNonPartner: number,
): PartnerWithdrawalSummary {
  const distributableBase = Math.max(0, collectedProfitBase - withdrawnNonPartner);
  const perPartnerTarget = distributableBase / 2;
  const rawPendingBlanca = perPartnerTarget - withdrawnBlanca;
  const rawPendingAndreaPepe = perPartnerTarget - withdrawnAndreaPepe;
  const excessBlanca = Math.max(0, -rawPendingBlanca);
  const excessAndreaPepe = Math.max(0, -rawPendingAndreaPepe);

  return {
    distributableBase,
    perPartnerTarget,
    pendingBlanca: Math.max(0, rawPendingBlanca - excessAndreaPepe),
    pendingAndreaPepe: Math.max(0, rawPendingAndreaPepe - excessBlanca),
    excessBlanca,
    excessAndreaPepe,
  };
}
