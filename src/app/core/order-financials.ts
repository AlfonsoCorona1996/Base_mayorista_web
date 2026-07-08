export interface FinancialOrderItem {
  quantity?: number | null;
  confirmed_qty?: number | null;
  returned_qty?: number | null;
  returned_restockable_qty?: number | null;
  returned_damaged_qty?: number | null;
  confirmation_state?: string | null;
  state?: string | null;
  price_public?: number | null;
  price_clienta?: number | null;
  price_cost?: number | null;
}

export interface FinancialOrderLike {
  items?: FinancialOrderItem[] | null;
  totals?: {
    discount_amount?: number | null;
    paid_amount?: number | null;
  } | null;
}

export interface ItemFinancials {
  orderedQty: number;
  recognizedQty: number;
  returnedQty: number;
  netQty: number;
  restockableReturnedQty: number;
  damagedReturnedQty: number;
  unitPublic: number;
  unitClient: number;
  unitCost: number;
  grossPublic: number;
  returnedPublic: number;
  netPublic: number;
  grossClient: number;
  returnedClient: number;
  netClient: number;
  grossCost: number;
  returnedCost: number;
  netCost: number;
}

export interface OrderFinancials {
  items: ItemFinancials[];
  grossPublic: number;
  returnsPublic: number;
  netPublic: number;
  grossClient: number;
  returnsClientGross: number;
  returnsDiscount: number;
  returnsAmount: number;
  netClientBeforeDiscount: number;
  discountAmount: number;
  remainingDiscount: number;
  netAmount: number;
  grossCost: number;
  returnedCost: number;
  netCost: number;
  grossProfit: number;
  paidAmount: number;
  balanceDue: number;
  overpaymentAmount: number;
  orderedUnits: number;
  recognizedUnits: number;
  returnedUnits: number;
  netUnits: number;
}

export function money(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

export function quantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function recognizedItemQty(item: FinancialOrderItem): number {
  const ordered = quantity(item.quantity);
  const state = String(item.state || "").toLowerCase();
  const confirmation = String(item.confirmation_state || "").toLowerCase();
  if (state === "cancelado" || confirmation === "out_of_stock") return 0;
  if (item.confirmed_qty !== null && item.confirmed_qty !== undefined) {
    return Math.min(ordered, quantity(item.confirmed_qty));
  }
  if (confirmation === "pending") return 0;
  return ordered;
}

export function returnedItemQty(item: FinancialOrderItem): number {
  return Math.min(recognizedItemQty(item), quantity(item.returned_qty));
}

export function netItemQty(item: FinancialOrderItem): number {
  return Math.max(0, recognizedItemQty(item) - returnedItemQty(item));
}

export function availableReturnQty(item: FinancialOrderItem): number {
  return netItemQty(item);
}

export function calculateItemFinancials(item: FinancialOrderItem): ItemFinancials {
  const orderedQty = quantity(item.quantity);
  const recognizedQty = recognizedItemQty(item);
  const returnedQty = returnedItemQty(item);
  const netQty = Math.max(0, recognizedQty - returnedQty);
  const damagedReturnedQty = Math.min(returnedQty, quantity(item.returned_damaged_qty));
  const explicitRestockable = item.returned_restockable_qty;
  const restockableReturnedQty = explicitRestockable === null || explicitRestockable === undefined
    ? Math.max(0, returnedQty - damagedReturnedQty)
    : Math.min(returnedQty, quantity(explicitRestockable));

  const unitPublic = Math.max(0, money(item.price_public ?? item.price_clienta));
  const unitClient = Math.max(0, money(item.price_clienta ?? item.price_public));
  const unitCost = Math.max(0, money(item.price_cost));
  const grossPublic = money(unitPublic * recognizedQty);
  const returnedPublic = money(unitPublic * returnedQty);
  const grossClient = money(unitClient * recognizedQty);
  const returnedClient = money(unitClient * returnedQty);
  const grossCost = money(unitCost * recognizedQty);
  const returnedCost = money(unitCost * restockableReturnedQty);

  return {
    orderedQty,
    recognizedQty,
    returnedQty,
    netQty,
    restockableReturnedQty,
    damagedReturnedQty,
    unitPublic,
    unitClient,
    unitCost,
    grossPublic,
    returnedPublic,
    netPublic: money(grossPublic - returnedPublic),
    grossClient,
    returnedClient,
    netClient: money(grossClient - returnedClient),
    grossCost,
    returnedCost,
    netCost: money(grossCost - returnedCost),
  };
}

export function calculateOrderFinancials(order: FinancialOrderLike): OrderFinancials {
  const items = (order.items || []).map(calculateItemFinancials);
  const sum = (selector: (row: ItemFinancials) => number) => money(items.reduce((total, row) => total + selector(row), 0));

  const grossPublic = sum((row) => row.grossPublic);
  const returnsPublic = sum((row) => row.returnedPublic);
  const grossClient = sum((row) => row.grossClient);
  const returnsClientGross = sum((row) => row.returnedClient);
  const requestedDiscount = Math.max(0, money(order.totals?.discount_amount));
  const discountAmount = Math.min(grossClient, requestedDiscount);
  const returnsDiscount = grossClient > 0
    ? Math.min(discountAmount, money(discountAmount * (returnsClientGross / grossClient)))
    : 0;
  const remainingDiscount = money(discountAmount - returnsDiscount);
  const returnsAmount = money(returnsClientGross - returnsDiscount);
  const netClientBeforeDiscount = money(grossClient - returnsClientGross);
  const netAmount = Math.max(0, money(netClientBeforeDiscount - remainingDiscount));
  const grossCost = sum((row) => row.grossCost);
  const returnedCost = sum((row) => row.returnedCost);
  const netCost = money(grossCost - returnedCost);
  const paidAmount = Math.max(0, money(order.totals?.paid_amount));

  return {
    items,
    grossPublic,
    returnsPublic,
    netPublic: money(grossPublic - returnsPublic),
    grossClient,
    returnsClientGross,
    returnsDiscount,
    returnsAmount,
    netClientBeforeDiscount,
    discountAmount,
    remainingDiscount,
    netAmount,
    grossCost,
    returnedCost,
    netCost,
    grossProfit: money(netAmount - netCost),
    paidAmount,
    balanceDue: Math.max(0, money(netAmount - paidAmount)),
    overpaymentAmount: Math.max(0, money(paidAmount - netAmount)),
    orderedUnits: items.reduce((total, row) => total + row.orderedQty, 0),
    recognizedUnits: items.reduce((total, row) => total + row.recognizedQty, 0),
    returnedUnits: items.reduce((total, row) => total + row.returnedQty, 0),
    netUnits: items.reduce((total, row) => total + row.netQty, 0),
  };
}

export function toPersistedOrderTotals(order: FinancialOrderLike): Record<string, number> {
  const result = calculateOrderFinancials(order);
  return {
    gross_amount: result.grossClient,
    returns_amount: result.returnsAmount,
    net_amount: result.netAmount,
    total_amount: result.netAmount,
    cost_amount: result.netCost,
    gross_profit: result.grossProfit,
    paid_amount: result.paidAmount,
    balance_due: result.balanceDue,
    overpayment_amount: result.overpaymentAmount,
    discount_amount: result.discountAmount,
  };
}
