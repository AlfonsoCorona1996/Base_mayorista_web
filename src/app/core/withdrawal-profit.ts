import { FinancialOrderLike, calculateOrderFinancials, money } from "./order-financials";

export interface WithdrawalProfitOrder extends FinancialOrderLike {
  status?: string | null;
  delivered_at?: string | null;
}

export interface WithdrawalProfitBreakdown {
  /** Venta neta reconocida de lo ya entregado. */
  netSales: number;
  /** Dinero que realmente entro por esas ventas. */
  collectedRevenue: number;
  /** Costo neto de la mercancia entregada (ya descontado lo que regreso al inventario). */
  deliveredNetCost: number;
  /** Gastos operativos del negocio (no incluye compra de mercancia). */
  expensesTotal: number;
  /** Utilidad generada por el trabajo, se haya cobrado o no. */
  accruedNetProfit: number;
  /** Saldo entregado que todavia no se liquida. */
  pendingCollection: number;
  /** Parte de ese saldo que es ganancia. */
  pendingProfit: number;
  /** Parte de ese saldo que es capital invertido por recuperar. */
  pendingPrincipal: number;
  /** Utilidad ya respaldada por dinero cobrado. Esta es la base repartible hoy. */
  collectedNetProfit: number;
}

export interface PartnerAccount {
  /** Lo que le corresponde del total generado. */
  share: number;
  /** Su mitad de la utilidad ya cobrada. */
  collectedShare: number;
  /** Su mitad de la utilidad que sigue por cobrar. */
  pendingShare: number;
  withdrawn: number;
  /** Puede retirar hoy. Negativo significa que ya retiro de mas. */
  availableNow: number;
  /** Total que le queda por recibir, cobrado o no. Lleva signo. */
  pendingTotal: number;
  /** Cuanto retiro por encima de lo disponible hoy. Siempre positivo o cero. */
  overdrawn: number;
}

export interface PartnerWithdrawalSummary {
  accruedBase: number;
  collectedBase: number;
  pendingBase: number;
  unclassifiedWithdrawals: number;
  blanca: PartnerAccount;
  andreaPepe: PartnerAccount;
  totalWithdrawn: number;
  totalPending: number;
  totalAvailableNow: number;
}

const DELIVERED_STATUSES = new Set([
  "entregado",
  "entregado_parcial",
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
  let netSales = 0;
  let collectedRevenue = 0;
  let deliveredNetCost = 0;
  let pendingCollection = 0;
  let pendingProfit = 0;
  let accruedGrossProfit = 0;

  for (const order of orders) {
    if (!isDeliveredForProfit(order)) continue;

    const financials = calculateOrderFinancials(order);
    const paid = Math.min(financials.netAmount, Math.max(0, financials.paidAmount));
    const balance = Math.max(0, money(financials.netAmount - paid));
    const pendingRatio = financials.netAmount > 0 ? Math.min(1, balance / financials.netAmount) : 0;

    netSales += financials.netAmount;
    collectedRevenue += paid;
    // Costo neto: lo que regreso al inventario sigue siendo capital, no costo consumido.
    deliveredNetCost += financials.netCost;
    pendingCollection += balance;
    pendingProfit += financials.grossProfit * pendingRatio;
    accruedGrossProfit += financials.grossProfit;
  }

  const safeExpenses = Math.max(0, money(expensesTotal));
  const accruedNetProfit = money(accruedGrossProfit - safeExpenses);
  const safePendingProfit = money(pendingProfit);

  return {
    netSales: money(netSales),
    collectedRevenue: money(collectedRevenue),
    deliveredNetCost: money(deliveredNetCost),
    expensesTotal: safeExpenses,
    accruedNetProfit,
    pendingCollection: money(pendingCollection),
    pendingProfit: safePendingProfit,
    pendingPrincipal: money(pendingCollection - safePendingProfit),
    // La utilidad pendiente de cobro es lo unico que se descuenta. El capital
    // invertido que sigue en la calle NO se resta aqui: es inversion, no
    // utilidad, y mezclarlo hacia desaparecer dinero del reparto.
    collectedNetProfit: money(accruedNetProfit - safePendingProfit),
  };
}

function buildPartnerAccount(
  share: number,
  collectedShare: number,
  pendingShare: number,
  withdrawn: number,
): PartnerAccount {
  const availableNow = money(collectedShare - withdrawn);
  return {
    share: money(share),
    collectedShare: money(collectedShare),
    pendingShare: money(pendingShare),
    withdrawn: money(withdrawn),
    availableNow,
    pendingTotal: money(share - withdrawn),
    overdrawn: availableNow < 0 ? money(-availableNow) : 0,
  };
}

/**
 * Reparto 50/50 como cuenta corriente por socio.
 *
 * Cada socio conserva su saldo aunque el otro haya retirado de mas: un exceso
 * ajeno ya no borra lo que a ti te toca. Los saldos llevan signo para que un
 * sobre-retiro se vea en lugar de aplastarse a cero.
 */
export function calculatePartnerWithdrawalSummary(
  accruedNetProfit: number,
  collectedNetProfit: number,
  withdrawnBlanca: number,
  withdrawnAndreaPepe: number,
  unclassifiedWithdrawals = 0,
): PartnerWithdrawalSummary {
  const unclassified = Math.max(0, money(unclassifiedWithdrawals));
  const accruedBase = money(accruedNetProfit - unclassified);
  const collectedBase = money(collectedNetProfit - unclassified);
  const pendingBase = money(accruedBase - collectedBase);

  const blanca = buildPartnerAccount(accruedBase / 2, collectedBase / 2, pendingBase / 2, withdrawnBlanca);
  const andreaPepe = buildPartnerAccount(accruedBase / 2, collectedBase / 2, pendingBase / 2, withdrawnAndreaPepe);

  return {
    accruedBase,
    collectedBase,
    pendingBase,
    unclassifiedWithdrawals: unclassified,
    blanca,
    andreaPepe,
    totalWithdrawn: money(blanca.withdrawn + andreaPepe.withdrawn),
    totalPending: money(blanca.pendingTotal + andreaPepe.pendingTotal),
    totalAvailableNow: money(blanca.availableNow + andreaPepe.availableNow),
  };
}
