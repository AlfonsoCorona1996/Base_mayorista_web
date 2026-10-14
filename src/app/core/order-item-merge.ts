import type { BusinessId } from './rbac.constants';
import type { OrderItem } from './orders.service';

function text(value: string | null | undefined): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function price(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value * 100);
}

/** A provisional option may merge with the same option while retaining its review status. */
export function sameOrderItemProduct(left: OrderItem, right: OrderItem, business: BusinessId): boolean {
  if (left.source !== right.source || (left.supplier_id || null) !== (right.supplier_id || null)) return false;
  if ((left.source_business_id || left.business_id || business) !== (right.source_business_id || right.business_id || business)) return false;
  if ((left.product_ref_type || null) !== (right.product_ref_type || null)) return false;
  if (text(left.variant) !== text(right.variant) || text(left.color) !== text(right.color)) return false;
  if (left.inventory_id || right.inventory_id) {
    if (left.inventory_id !== right.inventory_id) return false;
  } else if (left.product_id || right.product_id) {
    if (left.product_id !== right.product_id) return false;
  } else if (!text(left.title) || text(left.title) !== text(right.title)) return false;
  const priceFields = ['price_clienta', 'price_public', 'price_cost'] as const;
  if (priceFields.some(field => {
    return price(left[field]) !== price(right[field]);
  })) return false;
  if ((left.discount_pct ?? null) !== (right.discount_pct ?? null)) return false;
  if ((left.price_selected_tier || null) !== (right.price_selected_tier || null)) return false;
  if ((left.price_override_reason || null) !== (right.price_override_reason || null)) return false;
  if ((left.price_override_by || null) !== (right.price_override_by || null)) return false;
  const provisional = left.catalog_option_status === 'pending_review';
  if (provisional !== (right.catalog_option_status === 'pending_review')) return false;
  if (provisional && (
    (left.catalog_option_base_product_id || left.product_id) !== (right.catalog_option_base_product_id || right.product_id)
    || (left.catalog_option_image_source || null) !== (right.catalog_option_image_source || null)
    || (left.image_url || null) !== (right.image_url || null)
  )) return false;
  return true;
}

export function canMergePendingOrderItem(item: OrderItem): boolean {
  return ['borrador', 'confirmando_proveedor', 'reservado_inventario', 'sin_estado'].includes(item.state)
    && (!item.confirmation_state || item.confirmation_state === 'pending')
    && item.confirmed_qty == null
    && !item.late_addition && !item.late_addition_added_at
    && !item.returned_qty && !item.returned_restockable_qty && !item.returned_damaged_qty
    && Number.isSafeInteger(item.quantity) && item.quantity > 0;
}

/** Keep the edited item's ID; referenced and inventory lines keep their individual identity. */
export function mergeEditedOrderItem(
  items: OrderItem[], itemId: string, business: BusinessId, protectedIds: ReadonlySet<string> = new Set(),
): { items: OrderItem[]; mergedItemIds: string[]; addedQuantity: number } {
  const target = items.find(item => item.item_id === itemId);
  const eligible = (item: OrderItem) => canMergePendingOrderItem(item)
    && item.source !== 'inventario' && !item.inventory_id && !protectedIds.has(item.item_id);
  if (!target || !eligible(target)) return { items, mergedItemIds: [], addedQuantity: 0 };
  const matches = items.filter(item => item.item_id !== itemId && eligible(item)
    && item.state === target.state && sameOrderItemProduct(item, target, business));
  const mergedItemIds = matches.map(item => item.item_id);
  const removed = new Set(mergedItemIds);
  const addedQuantity = matches.reduce((sum, item) => sum + item.quantity, 0);
  if (!matches.length || !Number.isSafeInteger(target.quantity + addedQuantity)) return { items, mergedItemIds: [], addedQuantity: 0 };
  return {
    items: items.filter(item => !removed.has(item.item_id)).map(item => item.item_id === itemId
      ? { ...target, quantity: target.quantity + addedQuantity } : item),
    mergedItemIds, addedQuantity,
  };
}
