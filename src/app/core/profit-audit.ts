import { calculateOrderFinancials, FinancialOrderLike, FinancialOrderItem, money } from './order-financials';

export type AuditPartner = 'socio_blanca' | 'socio_andrea_pepe';
export interface AuditOrder extends FinancialOrderLike {
  order_id: string;
  customer_id?: string;
  status?: string;
  created_at?: unknown;
  audit_created_at?: string | null;
  paid_at?: unknown;
  paid_at_quality?: string | null;
  totals?: FinancialOrderLike['totals'] & { total_amount?: number; net_amount?: number };
  items?: (FinancialOrderItem & { title?: string; order_item_id?: string })[] | null;
}
export interface AuditExpense {
  expense_id: string; category: string; amount: number; occurred_at: unknown;
  audit_occurred_at?: string | null;
  notes?: string | null; account_id?: string | null;
}
export interface AuditWithdrawal {
  withdrawal_id: string; purpose: string; amount: number; occurred_at: unknown;
  audit_occurred_at?: string | null;
  notes?: string | null; recipient?: string | null; account_id?: string | null;
}
export interface AuditItemRow {
  title: string; quantity: number; returned: number; client: number | null;
  cost: number | null; costSource: 'registered' | 'estimated' | 'missing';
  sale: number; totalCost: number;
}
export interface AuditOrderRow {
  id: string; customerId: string; date: string | null; month: string; status: string;
  sale: number; cost: number; profit: number; collected: number; pending: number;
  collectedProfit: number; pendingProfit: number; issues: string[];
  estimatedItems: number; incomplete: boolean; excluded: boolean; items: AuditItemRow[];
  discount: number; shipping: number;
  returnedSale: number; overpayment: number;
  recordedSale: number | null;
  paymentDate: string | null; paymentDateEstimated: boolean;
}
export type AuditMovementKind = 'expense' | 'capital' | 'withdrawal' | 'unclassified';
export interface AuditMovement {
  id: string; source: 'expense' | 'withdrawal'; date: string | null; month: string;
  kind: AuditMovementKind; category: string; amount: number; partner: AuditPartner | null;
  notes: string; accountId: string | null; issues: string[];
}
export interface AuditTotals {
  sale: number; cost: number; profit: number; collected: number; pending: number;
  collectedProfit: number; pendingProfit: number; expenses: number; netProfit: number;
  blancaWithdrawn: number; andreaPepeWithdrawn: number; unclassified: number; capital: number;
}
export interface AuditMonth extends AuditTotals {
  id: string; label: string; orders: AuditOrderRow[]; movements: AuditMovement[];
  incompleteOrders: number;
}
export interface ProfitAudit {
  orders: AuditOrderRow[]; movements: AuditMovement[]; months: AuditMonth[]; totals: AuditTotals;
  issueCount: number; estimatedItems: number; incompleteOrders: number;
}

/** Calendar dates use Mexico City, independent of the viewer's device timezone. */
export function auditDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
  }
  let date: Date;
  if (typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    date = value.toDate();
  } else if (value instanceof Date) date = value;
  else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  else return null;
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}

function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? money(n) : null;
}

export function auditOrder(order: AuditOrder): AuditOrderRow {
  const date = auditDate(order.audit_created_at !== undefined ? order.audit_created_at : order.created_at);
  const issues: string[] = [];
  if (!date) issues.push('Sin fecha de creación comprobable');
  const status = String(order.status || 'Sin estado');
  const excluded = ['cancelado', 'cancelled', 'canceled', 'devuelto', 'returned'].includes(status.toLowerCase());
  let incomplete = false;
  const sourceItems = order.items || [];
  const prepared = sourceItems.map((item, index) => {
    const client = amount(item.price_clienta);
    const publicPrice = amount(item.price_public);
    const registeredCost = amount(item.price_cost);
    // Explicit zero is a recorded cost, not a missing cost.
    const cost = registeredCost ?? (publicPrice === null ? null : money(publicPrice / 2));
    const costSource = registeredCost !== null ? 'registered' : cost !== null ? 'estimated' : 'missing';
    const itemExcluded = item.state === 'cancelado' || item.confirmation_state === 'out_of_stock';
    if (!itemExcluded && !excluded) {
      if (client === null) { incomplete = true; issues.push(`Producto ${index + 1}: falta precio clienta`); }
      if (cost === null) { incomplete = true; issues.push(`Producto ${index + 1}: faltan costo y precio público`); }
      if (amount(item.quantity) === null || !Number.isInteger(Number(item.quantity))) {
        incomplete = true; issues.push(`Producto ${index + 1}: cantidad inválida o faltante`);
      }
    }
    const pending = item.confirmation_state === 'pending';
    return { item: { ...item, price_clienta: client ?? 0, price_cost: cost ?? 0,
      // Include orders in progress. Confirmed shortages and cancellations remain excluded.
      confirmation_state: pending ? undefined : item.confirmation_state,
      confirmed_qty: pending ? undefined : item.confirmed_qty,
    }, client, cost, costSource: costSource as AuditItemRow['costSource'] };
  });
  const financials = calculateOrderFinancials({ items: prepared.map(p => p.item), totals: order.totals });
  if (!sourceItems.length && !excluded) {
    incomplete = true;
    issues.push('Sin productos: se conserva la venta registrada; utilidad sin determinar');
  }
  // Do not discard a historical order just because its detail is missing.
  const sale = excluded ? 0 : sourceItems.length ? financials.netAmount
    : amount(order.totals?.net_amount) ?? amount(order.totals?.total_amount) ?? 0;
  const recordedSale = amount(order.totals?.net_amount) ?? amount(order.totals?.total_amount);
  if (!excluded && sourceItems.length && recordedSale !== null && Math.abs(money(sale - recordedSale)) > 0.01) {
    issues.push('El total guardado difiere del cálculo por productos; se usa el detalle vigente');
  }
  const cost = excluded ? 0 : financials.netCost;
  const profit = excluded || incomplete ? 0 : money(sale - cost);
  const collected = excluded ? 0 : Math.min(sale, Math.max(0, money(order.totals?.paid_amount)));
  const pending = money(sale - collected);
  const collectedProfit = sale > 0 ? money(profit * collected / sale) : profit;
  if (money(order.totals?.paid_amount) > sale) issues.push('Cobro excedente: revisar saldo a favor o reembolso');
  if (excluded) issues.push('Cancelado o devuelto: conservado en auditoría, sin venta vigente');
  const estimatedItems = excluded ? 0 : prepared.filter((p, i) => p.costSource === 'estimated' && financials.items[i].recognizedQty > 0).length;
  if (estimatedItems) issues.push(`${estimatedItems} producto(s) con costo estimado = precio público / 2`);
  if (incomplete && sourceItems.length) issues.push('Importes parciales: faltantes sin valor no equivalen a cero confirmado');
  return {
    id: order.order_id, customerId: order.customer_id || '', date, month: date?.slice(0, 7) || 'undated', status,
    sale, cost, profit, collected, pending, collectedProfit, pendingProfit: money(profit - collectedProfit),
    issues, estimatedItems, incomplete, excluded, discount: financials.remainingDiscount, shipping: financials.shippingFee,
    returnedSale: financials.returnsAmount, overpayment: money(Math.max(0, money(order.totals?.paid_amount) - sale)), recordedSale,
    paymentDate: auditDate(order.paid_at), paymentDateEstimated: order.paid_at_quality === 'estimated',
    items: prepared.map((p, i) => ({ title: sourceItems[i].title || `Producto ${i + 1}`,
      quantity: financials.items[i].recognizedQty, returned: financials.items[i].returnedQty,
      client: p.client, cost: p.cost, costSource: p.costSource,
      sale: excluded ? 0 : financials.items[i].netClient, totalCost: excluded ? 0 : financials.items[i].netCost,
    })),
  };
}

function movementsFor(expenses: AuditExpense[], withdrawals: AuditWithdrawal[]): AuditMovement[] {
  const rows: AuditMovement[] = expenses.map(row => {
    const date = auditDate(row.audit_occurred_at !== undefined ? row.audit_occurred_at : row.occurred_at);
    const suspicious = /retiro|utilidad|ganancia|socio|blanca|andrea|pepe/i.test(row.notes || '');
    const estimated = row.category === 'ajuste' || /aprox|estimad|%.*devoluci/i.test(row.notes || '');
    return { id: row.expense_id, source: 'expense', date, month: date?.slice(0, 7) || 'undated',
      kind: row.category === 'compra_inversion' ? 'capital' : 'expense', category: row.category,
      amount: money(row.amount), partner: null, notes: row.notes || '', accountId: row.account_id || null,
      issues: [...(!date ? ['Sin fecha comprobable'] : []), ...(suspicious ? ['Revisar si es gasto o retiro de socio; se conserva la categoría registrada'] : []), ...(estimated ? ['Gasto estimado: conciliar contra devoluciones registradas para evitar descontarlas dos veces'] : [])],
    };
  });
  for (const row of withdrawals) {
    const date = auditDate(row.audit_occurred_at !== undefined ? row.audit_occurred_at : row.occurred_at);
    const partner = row.purpose === 'socio_blanca' || row.purpose === 'socio_andrea_pepe' ? row.purpose : null;
    rows.push({ id: row.withdrawal_id, source: 'withdrawal', date, month: date?.slice(0, 7) || 'undated',
      kind: partner ? 'withdrawal' : 'unclassified', category: row.purpose, amount: money(row.amount), partner,
      notes: [row.recipient, row.notes].filter(Boolean).join(' · '), accountId: row.account_id || null,
      issues: [...(!date ? ['Sin fecha comprobable'] : []), ...(!partner ? ['Destino por clasificar: no se asigna a un socio por sus notas'] : [])],
    });
  }
  return rows;
}

export function auditTotals(orders: AuditOrderRow[], movements: AuditMovement[]): AuditTotals {
  const sumOrders = (key: 'sale' | 'cost' | 'profit' | 'collected' | 'pending' | 'collectedProfit' | 'pendingProfit') => money(orders.reduce((s, r) => s + r[key], 0));
  const sumMoves = (predicate: (r: AuditMovement) => boolean) => money(movements.filter(predicate).reduce((s, r) => s + r.amount, 0));
  const profit = sumOrders('profit');
  const expenses = sumMoves(r => r.kind === 'expense');
  return { sale: sumOrders('sale'), cost: sumOrders('cost'), profit, collected: sumOrders('collected'), pending: sumOrders('pending'),
    collectedProfit: sumOrders('collectedProfit'), pendingProfit: sumOrders('pendingProfit'), expenses, netProfit: money(profit - expenses),
    blancaWithdrawn: sumMoves(r => r.partner === 'socio_blanca'), andreaPepeWithdrawn: sumMoves(r => r.partner === 'socio_andrea_pepe'),
    unclassified: sumMoves(r => r.kind === 'unclassified'), capital: sumMoves(r => r.kind === 'capital'),
  };
}

export function buildProfitAudit(orders: AuditOrder[], expenses: AuditExpense[], withdrawals: AuditWithdrawal[]): ProfitAudit {
  const rows = orders.map(auditOrder).sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true }));
  const movements = movementsFor(expenses, withdrawals);
  const ids = [...new Set([...rows.map(r => r.month), ...movements.map(r => r.month)])].sort().reverse();
  const months = ids.map(id => {
    const monthOrders = rows.filter(r => r.month === id);
    const monthMovements = movements.filter(r => r.month === id);
    return { id, label: id === 'undated' ? 'Sin fecha' : new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${id}-01T12:00:00Z`)),
      orders: monthOrders, movements: monthMovements,
      incompleteOrders: monthOrders.filter(r => r.incomplete).length,
      ...auditTotals(monthOrders, monthMovements) };
  });
  return { orders: rows, movements, months, totals: auditTotals(rows, movements),
    issueCount: rows.filter(r => r.issues.length && !r.excluded).length + movements.filter(r => r.issues.length).length,
    estimatedItems: rows.reduce((s, r) => s + r.estimatedItems, 0), incompleteOrders: rows.filter(r => r.incomplete).length };
}

export function auditPartners(totals: AuditTotals) {
  const blancaShare = money(totals.netProfit / 2);
  const blancaPending = money(totals.pendingProfit / 2);
  return ([
    { id: 'socio_blanca', name: 'Blanca Trejo', initials: 'BT', share: blancaShare, pendingCollection: blancaPending, withdrawn: totals.blancaWithdrawn },
    { id: 'socio_andrea_pepe', name: 'Andrea y Pepe', initials: 'AP', share: money(totals.netProfit - blancaShare), pendingCollection: money(totals.pendingProfit - blancaPending), withdrawn: totals.andreaPepeWithdrawn },
  ] as const).map(p => ({ ...p, remaining: money(p.share - p.withdrawn) }));
}
