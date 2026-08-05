export interface PriceOverrideMarker {
  price_override_below_cost?: boolean | null;
}

export function buildOrderItemsUpdateRequest<T extends PriceOverrideMarker>(items: T[]) {
  return {
    items,
    below_cost_confirmation: items.some((item) => item.price_override_below_cost === true),
  };
}

export function mergeAuthoritativeOrderItems<
  TOrder extends { order_id: string },
  TItem,
  TTotals,
>(
  orders: TOrder[],
  orderId: string,
  authoritative: { items: TItem[]; totals: TTotals; updated_at: string },
): TOrder[] {
  return orders.map((order) => order.order_id === orderId
    ? {
        ...order,
        items: authoritative.items,
        totals: authoritative.totals,
        updated_at: authoritative.updated_at,
      }
    : order) as TOrder[];
}
