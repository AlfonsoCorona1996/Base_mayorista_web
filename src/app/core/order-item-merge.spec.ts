import { mergeEditedOrderItem, sameOrderItemProduct } from './order-item-merge';
import type { OrderItem } from './orders.service';
import { calculateOrderFinancials } from './order-financials';

describe('sumar productos iguales al editar', () => {
  const item = (id: string, patch: Partial<OrderItem> = {}): OrderItem => ({
    item_id: id, business_id: 'bm', title: 'Pantalón MK5224', product_id: 'mk5224',
    supplier_id: 'bommy', source: 'catalogo', product_ref_type: 'normalized_listing',
    variant: 'M', color: 'gris', quantity: 1, state: 'confirmando_proveedor',
    confirmation_state: 'pending', confirmed_qty: null,
    price_public: 250, price_clienta: 187.5, price_cost: 125, discount_pct: 25,
    catalog_option_status: 'pending_review', catalog_option_base_product_id: 'mk5224',
    catalog_option_image_source: 'catalog', image_url: 'https://example.test/mk.jpg', ...patch,
  });

  it('suma todas las opciones provisionales iguales y conserva el ID editado y la revisión', () => {
    const items = [item('a'), item('edit', { quantity: 2, color: ' GRIS ' }), item('b')];
    const before = calculateOrderFinancials({ items });
    const result = mergeEditedOrderItem(items, 'edit', 'bm');
    expect(result.items.length).toBe(1);
    expect(result.items[0]).toEqual(jasmine.objectContaining({ item_id: 'edit', quantity: 4, catalog_option_status: 'pending_review' }));
    expect(result.mergedItemIds).toEqual(['a', 'b']);
    expect(result.addedQuantity).toBe(2);
    expect(calculateOrderFinancials({ items: result.items })).toEqual(jasmine.objectContaining({
      orderedUnits: before.orderedUnits, grossClient: before.grossClient, grossCost: before.grossCost,
    }));
    expect(items.map(i => i.quantity)).toEqual([1, 2, 1]);
    expect(mergeEditedOrderItem(result.items, 'edit', 'bm').mergedItemIds).toEqual([]);
  });

  it('no mezcla tallas, colores vacíos, precios, descuentos, negocios ni productos diferentes', () => {
    for (const patch of [
      { variant: 'G' }, { variant: null }, { color: 'tinto' }, { color: null },
      { price_clienta: 180 }, { price_cost: 120 }, { price_public: 260 },
      { price_cost: null }, { price_cost: 0 }, { discount_pct: 20 },
      { source_business_id: 'catalogo' as const }, { product_id: 'otro' },
      { supplier_id: 'otro' }, { price_selected_tier: 'final' as const },
      { catalog_option_status: 'official' as const },
      { catalog_option_base_product_id: 'otro' }, { image_url: 'https://example.test/otra.jpg' },
    ]) {
      const result = mergeEditedOrderItem([item('a'), item('b', patch)], 'a', 'bm');
      expect(result.items.length).withContext(JSON.stringify(patch)).toBe(2);
    }
  });

  it('respeta referencias operativas, confirmaciones, inventario, devoluciones y adiciones tardías', () => {
    const target = item('edit');
    const blocked = [
      item('packed'), item('confirmed', { confirmation_state: 'confirmed', confirmed_qty: 1 }),
      item('partial', { confirmed_qty: 0 }), item('returned', { returned_qty: 1 }),
      item('received', { state: 'recibido_qa' }), item('cancelled', { state: 'cancelado' }),
      item('inventory', { inventory_id: 'inv' }),
      item('late', { late_addition: true }), item('dated', { late_addition_added_at: '2026-10-07' }),
    ];
    const result = mergeEditedOrderItem([target, ...blocked], 'edit', 'bm', new Set(['packed']));
    expect(result.mergedItemIds).toEqual([]);
    expect(result.items).toEqual([target, ...blocked]);
    expect(mergeEditedOrderItem([target, item('b')], 'edit', 'bm', new Set(['edit'])).items.length).toBe(2);
  });

  it('suma opciones oficiales con diferencias de mayúsculas e ignora identificadores de variante obsoletos', () => {
    const a = item('a', { catalog_option_status: 'official', variant_id: 'old', color: 'Gris' });
    const b = item('b', { catalog_option_status: undefined, variant_id: 'new', color: 'gris' });
    expect(sameOrderItemProduct(a, b, 'bm')).toBeTrue();
    expect(mergeEditedOrderItem([a, b], 'b', 'bm').items[0].quantity).toBe(2);
  });
});
