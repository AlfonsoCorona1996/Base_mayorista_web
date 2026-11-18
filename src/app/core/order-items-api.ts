export interface PriceOverrideMarker {
  price_override_below_cost?: boolean | null;
}

/**
 * PUT /items reemplaza el arreglo completo. `baseItemIds` son los artículos sobre los que
 * el cliente calculó el cambio: el backend responde 409 `ORDER_ITEMS_CONFLICT` si el PUT
 * borraría un artículo agregado por otra sesión o volvería a crear uno que otra sesión quitó.
 */
export function buildOrderItemsUpdateRequest<T extends PriceOverrideMarker & { item_id?: string | null }>(
  items: T[],
  baseItemIds?: readonly string[] | null,
) {
  return {
    items,
    below_cost_confirmation: items.some((item) => item.price_override_below_cost === true),
    ...(baseItemIds ? { base_item_ids: [...new Set(baseItemIds.filter(Boolean))] } : {}),
  };
}

export const ORDER_ITEMS_CONFLICT = "ORDER_ITEMS_CONFLICT";

export function buildOrderItemMutationRequest<T extends object>(item: T) {
  return {
    item,
    below_cost_confirmation: (item as PriceOverrideMarker).price_override_below_cost === true,
  };
}

export function buildOrderItemPatchRequest<T extends object>(patch: T) {
  return {
    patch,
    below_cost_confirmation: (patch as PriceOverrideMarker).price_override_below_cost === true,
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
