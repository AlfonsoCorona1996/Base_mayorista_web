import type { Order, OrderItem } from "../../core/orders.service";
import { money } from "../../core/order-financials";

export type PromotionScope = "standard" | "all" | "selected";
export interface PromotionRow {
  item: OrderItem;
  before: number;
  after: number;
  selected: boolean;
  reason: string | null;
}
export interface PromotionChange {
  itemId: string;
  before: OrderItem["price_clienta"];
  beforePct: OrderItem["discount_pct"];
  after: number;
  afterPct: number;
}

export function validPromotionPercent(percent: number | null): percent is number {
  return percent !== null && Number.isFinite(percent) && percent > 0 && percent < 100;
}

export function promotionRows(
  items: readonly OrderItem[], percent: number | null, scope: PromotionScope, selected: readonly string[],
): PromotionRow[] {
  return items.map(item => {
    const base = item.price_public;
    const before = money(item.price_clienta ?? base);
    const validBase = typeof base === "number" && Number.isFinite(base) && base > 0;
    const after = validBase && validPromotionPercent(percent) ? money(base * (1 - percent / 100)) : before;
    let reason: string | null = null;
    if (!validBase) reason = "Sin precio público válido";
    else if (item.state === "cancelado" || item.state === "devuelto" || (item.returned_qty ?? 0) > 0) {
      reason = "Cancelado o con devolución";
    } else if (after < (item.price_cost ?? 0)) reason = "Precio menor al costo; revisar individualmente";
    const standard = validBase && Math.abs(before - money(base * 0.75)) < 0.01;
    const included = scope === "all" || (scope === "standard" ? standard : selected.includes(item.item_id));
    return { item, before, after, selected: !reason && included, reason };
  });
}

export function promotionChanges(rows: readonly PromotionRow[], percent: number): PromotionChange[] {
  return rows.filter(row => row.selected && row.before !== row.after).map(row => ({
    itemId: row.item.item_id, before: row.item.price_clienta, beforePct: row.item.discount_pct,
    after: row.after, afterPct: percent,
  }));
}

export function applyPromotionChanges(items: readonly OrderItem[], changes: readonly PromotionChange[], undo = false): OrderItem[] {
  const byId = new Map(changes.map(change => [change.itemId, change]));
  return items.map(item => {
    const change = byId.get(item.item_id);
    if (!change) return item;
    const next = { ...item };
    if (undo) {
      if (change.before === undefined) delete next.price_clienta;
      else next.price_clienta = change.before;
      if (change.beforePct === undefined) delete next.discount_pct;
      else next.discount_pct = change.beforePct;
    } else {
      next.price_clienta = change.after;
      next.discount_pct = change.afterPct;
    }
    return next;
  });
}

// Detect changes to the reviewed order before sending its entire items array.
export function promotionRevision(order: Order): string {
  return JSON.stringify([order.order_id, order.status, order.delivery_status, order.items, order.totals]);
}
