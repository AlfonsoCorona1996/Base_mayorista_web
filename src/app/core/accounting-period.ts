import { FinancialOrderLike, OrderFinancials, calculateOrderFinancials, money } from "./order-financials";

export type AccountingPeriodStatus = "open" | "in_review" | "closed" | "reopened";
export type FinanceDataQuality = "native" | "confirmed" | "reconstructed" | "estimated" | "unknown";

export interface AccountingReturnLike {
  net_return_amount?: number | null;
  returned_cost_amount?: number | null;
  unit_cost?: number | null;
  qty?: number | null;
  disposition?: string | null;
  status?: string | null;
}

export interface AccountingPeriodOutcome {
  /** Venta reconocida al entregar, antes de devoluciones posteriores. */
  deliveredSales: number;
  /** Costo de la mercancía reconocida al entregar. */
  deliveredCost: number;
  /** Notas de crédito/devoluciones ocurridas dentro del periodo. */
  returnRevenueAdjustment: number;
  /** Costo que volvió a inventario dentro del periodo. */
  returnedInventoryCost: number;
  /** Costo irrecuperable de piezas dañadas, visible para auditoría. */
  damagedWriteOff: number;
  operatingExpenses: number;
  netSales: number;
  netCost: number;
  netProfit: number;
  margin: number;
}

/**
 * Reconstruye el pedido en el momento de la entrega. El documento vivo contiene
 * devoluciones posteriores, por lo que usarlo directamente reescribe el pasado.
 */
export function originalOrderFinancials(order: FinancialOrderLike): OrderFinancials {
  return calculateOrderFinancials({
    ...order,
    items: (order.items || []).map((item) => ({
      ...item,
      returned_qty: 0,
      returned_restockable_qty: 0,
      returned_damaged_qty: 0,
    })),
  });
}

export function returnRevenue(row: AccountingReturnLike): number {
  return Math.max(0, money(row.net_return_amount));
}

export function returnUnitCost(row: AccountingReturnLike): number {
  return Math.max(0, money(row.unit_cost));
}

export function isDamagedReturn(row: AccountingReturnLike): boolean {
  return row.disposition === "damaged" || row.status === "damaged";
}

export function returnedInventoryCost(row: AccountingReturnLike): number {
  if (isDamagedReturn(row)) return 0;
  const direct = Math.max(0, money(row.returned_cost_amount));
  if (direct > 0) return direct;
  return money(Math.max(0, Number(row.qty || 0)) * returnUnitCost(row));
}

export function damagedReturnWriteOff(row: AccountingReturnLike): number {
  if (!isDamagedReturn(row)) return 0;
  return money(Math.max(0, Number(row.qty || 0)) * returnUnitCost(row));
}

/**
 * Corte por fecha del hecho económico:
 * - la entrega reconoce venta y costo;
 * - una devolución posterior se registra en su propio periodo;
 * - recuperar mercancía reduce el costo del periodo de devolución;
 * - una pieza dañada conserva su costo como pérdida, nunca desaparece.
 */
export function calculateAccountingPeriodOutcome(input: {
  deliveredOrders: FinancialOrderLike[];
  returns: AccountingReturnLike[];
  operatingExpenses: number;
}): AccountingPeriodOutcome {
  const delivered = input.deliveredOrders.map(originalOrderFinancials);
  const deliveredSales = money(delivered.reduce((sum, row) => sum + row.netAmount, 0));
  const deliveredCost = money(delivered.reduce((sum, row) => sum + row.grossCost, 0));
  const returnRevenueAdjustment = money(input.returns.reduce((sum, row) => sum + returnRevenue(row), 0));
  const inventoryCost = money(input.returns.reduce((sum, row) => sum + returnedInventoryCost(row), 0));
  const damagedWriteOff = money(input.returns.reduce((sum, row) => sum + damagedReturnWriteOff(row), 0));
  const operatingExpenses = Math.max(0, money(input.operatingExpenses));
  const netSales = money(deliveredSales - returnRevenueAdjustment);
  const netCost = money(deliveredCost - inventoryCost);
  const netProfit = money(netSales - netCost - operatingExpenses);

  return {
    deliveredSales,
    deliveredCost,
    returnRevenueAdjustment,
    returnedInventoryCost: inventoryCost,
    damagedWriteOff,
    operatingExpenses,
    netSales,
    netCost,
    netProfit,
    margin: netSales === 0 ? 0 : netProfit / netSales,
  };
}

export function accountingPeriodId(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

