import { auditDate, auditOrder, AuditOrder } from './profit-audit';
import { money } from './order-financials';

/**
 * FIX 03A-2 — Modelo por periodo para devoluciones (RC-03, RC-04, RC-05, RC-06).
 *
 * SOLO ESPECIFICADO EN CÓDIGO: este módulo es puro y todavía no alimenta ningún reporte
 * real. Define la regla que deben seguir `profit-audit`, `product-sales` y Administración
 * cuando se apruebe D9:
 *
 * - La venta se reconoce completa en el mes del pedido, como si la devolución no hubiera
 *   ocurrido (un corte cerrado no cambia por hechos posteriores).
 * - Cada devolución es un ajuste con fecha propia (`returns.occurred_at`) en su mes:
 *   venta −`net_return_amount`, costo −`returned_cost_amount` (solo lo reintegrable),
 *   utilidad −`profit_impact`.
 * - El crédito comercial no es efectivo: aplicar crédito no genera venta ni ajuste nuevo;
 *   solo cambia cómo se pagó el pedido nuevo.
 */

export interface PeriodReturnRecord {
  return_id: string;
  order_id: string;
  occurred_at: string;
  qty?: number;
  disposition?: string | null;
  stage_at_return?: string | null;
  net_return_amount: number;
  returned_cost_amount: number;
  profit_impact: number;
  payment_resolution?: string | null;
  resolution_amount?: number | null;
}

export interface PeriodTotals {
  /** Ventas reconocidas en el mes (pedidos creados en el mes, sin restar devoluciones posteriores). */
  sales: number;
  /** Costo de lo vendido en el mes. */
  cost: number;
  /** Utilidad bruta de las ventas del mes. */
  grossProfit: number;
  /** Devoluciones registradas en el mes (pueden ser de ventas de meses anteriores). */
  returnsSale: number;
  /** Costo recuperado a inventario por devoluciones del mes (no incluye dañados). */
  recoveredCost: number;
  /** Ajuste de utilidad por devoluciones del mes (negativo o cero). */
  returnsProfitAdjustment: number;
  /** Ventas netas del mes = ventas − devoluciones del mes. */
  netSales: number;
  /** Utilidad bruta neta del mes = utilidad de ventas + ajuste por devoluciones. */
  netGrossProfit: number;
}

export interface PeriodView {
  months: Record<string, PeriodTotals>;
  issues: string[];
}

const RETURN_EXCLUDED_STATUSES = new Set(['devuelto', 'returned']);

const emptyTotals = (): PeriodTotals => ({
  sales: 0, cost: 0, grossProfit: 0, returnsSale: 0, recoveredCost: 0,
  returnsProfitAdjustment: 0, netSales: 0, netGrossProfit: 0,
});

/**
 * Reconstruye el pedido tal como se vendió: sin cantidades devueltas y, si la etapa
 * `devuelto` se debe a devoluciones registradas, con la etapa anterior.
 */
export function originalSaleOrder(order: AuditOrder, returns: readonly PeriodReturnRecord[]): AuditOrder {
  const own = returns.filter((row) => row.order_id === order.order_id);
  const status = String(order.status || '').toLowerCase();
  const statusFromReturns = RETURN_EXCLUDED_STATUSES.has(status) && own.length > 0;
  return {
    ...order,
    status: statusFromReturns ? (own.find((row) => row.stage_at_return)?.stage_at_return || 'postventa') : order.status,
    items: (order.items || []).map((item) => ({
      ...item,
      returned_qty: 0,
      returned_restockable_qty: 0,
      returned_damaged_qty: 0,
    })),
  };
}

function uniqueReturns(returns: readonly PeriodReturnRecord[], issues: string[]): PeriodReturnRecord[] {
  const seen = new Map<string, PeriodReturnRecord>();
  for (const row of returns) {
    if (seen.has(row.return_id)) {
      issues.push(`Devolución ${row.return_id} repetida: se cuenta una sola vez`);
      continue;
    }
    seen.set(row.return_id, row);
  }
  return [...seen.values()];
}

export function buildPeriodView(orders: readonly AuditOrder[], returnsInput: readonly PeriodReturnRecord[]): PeriodView {
  const issues: string[] = [];
  const returns = uniqueReturns(returnsInput, issues);
  const months: Record<string, PeriodTotals> = {};
  const bucket = (month: string) => (months[month] ||= emptyTotals());
  const orderIds = new Set(orders.map((order) => order.order_id));

  for (const order of orders) {
    const row = auditOrder(originalSaleOrder(order, returns));
    const target = bucket(row.month);
    target.sales = money(target.sales + row.sale);
    target.cost = money(target.cost + row.cost);
    target.grossProfit = money(target.grossProfit + row.profit);
    if (row.incomplete && returns.some((r) => r.order_id === order.order_id)) {
      issues.push(`Pedido ${order.order_id}: venta original con importes incompletos; el ajuste de su devolución se registra igual`);
    }
  }

  for (const row of returns) {
    const date = auditDate(row.occurred_at);
    const month = date?.slice(0, 7) || 'undated';
    if (!date) issues.push(`Devolución ${row.return_id} sin fecha comprobable`);
    if (!orderIds.has(row.order_id)) issues.push(`Devolución ${row.return_id}: pedido original ${row.order_id} no encontrado`);
    const target = bucket(month);
    target.returnsSale = money(target.returnsSale + money(row.net_return_amount));
    target.recoveredCost = money(target.recoveredCost + money(row.returned_cost_amount));
    target.returnsProfitAdjustment = money(target.returnsProfitAdjustment - money(row.profit_impact));
  }

  for (const totals of Object.values(months)) {
    totals.netSales = money(totals.sales - totals.returnsSale);
    totals.netGrossProfit = money(totals.grossProfit + totals.returnsProfitAdjustment);
  }
  return { months, issues };
}

export interface CollectionSplitInput {
  /** `totals.paid_amount` del pedido (incluye crédito aplicado). */
  paidAmount: number;
  /** Suma de `customer_credit_movements` tipo `application` del pedido (positivo). */
  creditApplied: number;
}

/**
 * El crédito aplicado no es efectivo (RC-05): separa lo cobrado en caja de lo pagado con
 * saldo a favor. Nunca devuelve efectivo negativo.
 */
export function splitCollection(input: CollectionSplitInput): { cash: number; credit: number } {
  const paid = Math.max(0, money(input.paidAmount));
  const credit = Math.min(paid, Math.max(0, money(input.creditApplied)));
  return { cash: money(paid - credit), credit };
}
