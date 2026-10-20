import { buildProductSales, rankProductSales, salesForProduct } from './product-sales';
import type { Order, OrderItem } from './orders.service';
import type { NormalizedListingDocV3 } from './firestore-contracts';

describe('Product sales', () => {
  const line = (patch: Partial<OrderItem> = {}): OrderItem => ({
    item_id: 'item',
    title: 'Pantalón',
    quantity: 2,
    source: 'catalogo',
    state: 'entregado',
    product_id: 'p',
    product_ref_type: 'normalized_listing',
    sku: 'BM-P',
    price_clienta: 100,
    price_cost: 40,
    ...patch,
  });
  // Only the fields consumed by this pure calculation are needed in these fixtures.
  const order = (patch: Partial<Order> = {}): Order =>
    ({
      order_id: 'o',
      business_id: 'bm',
      customer_id: 'c',
      status: 'pagado',
      created_at: '2026-09-01T12:00:00Z',
      items: [line()],
      totals: { total_amount: 200, paid_amount: 200, balance_due: 0 },
      ...patch,
    }) as Order;
  const product = {
    normalized_id: 'p',
    business_id: 'bm',
    listing: { items: [{ sku: 'BM-P' }] },
  } as NormalizedListingDocV3;

  it('groups variants of a product and counts each customer and order once', () => {
    const rows = buildProductSales([
      order({ items: [line(), line({ item_id: 'other', variant: 'M', sku: 'BM-P-M' })] }),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].units).toBe(4);
    expect(rows[0].orders).toBe(1);
    expect(rows[0].customers).toBe(1);
  });
  it('discounts returns and prorates order discounts, excluding shipping', () => {
    const rows = buildProductSales([
      order({
        items: [line({ returned_qty: 1 })],
        totals: {
          total_amount: 200,
          paid_amount: 200,
          balance_due: 0,
          discount_amount: 20,
          shipping_fee: 50,
        },
      }),
    ]);
    expect(rows[0].units).toBe(1);
    expect(rows[0].sales).toBe(90);
    expect(rows[0].profit).toBe(50);
    expect(rows[0].returns).toBe(1);
  });
  it('separates pending requests from recognized sales', () => {
    const rows = buildProductSales([order({ status: 'recibido_qa' })]);
    expect(rows[0].sales).toBe(0);
    expect(rows[0].pendingUnits).toBe(2);
    expect(rows[0].pendingOrders).toBe(1);
    expect(rankProductSales(rows)).toEqual([]);
  });
  it('never mixes businesses or two explicit product IDs that share a SKU', () => {
    const rows = buildProductSales([
      order(),
      order({ order_id: 'other', business_id: 'catalogo' }),
      order({ order_id: 'collision', items: [line({ product_id: 'other' })] }),
    ]);
    expect(rows.length).toBe(3);
    expect(salesForProduct(rows, product).units).toBe(2);
  });
  it('uses a legacy SKU only when it has a single owner', () => {
    const rows = buildProductSales([
      order(),
      order({ order_id: 'legacy', items: [line({ product_id: null, product_ref_type: null })] }),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].units).toBe(4);
    const ambiguous = buildProductSales([
      order(),
      order({ order_id: 'other', items: [line({ product_id: 'other' })] }),
      order({ order_id: 'legacy', items: [line({ product_id: null, product_ref_type: null })] }),
    ]);
    expect(ambiguous.length).toBe(3);
  });
  it('excludes canceled orders and retains full return counts', () => {
    expect(buildProductSales([order({ status: 'cancelado', delivered_at: '2026-09-01' })])).toEqual(
      [],
    );
    const returned = buildProductSales([
      order({ status: 'devuelto', items: [line({ returned_qty: 2 })] }),
    ]);
    expect(returned[0].returns).toBe(2);
    expect(returned[0].units).toBe(0);
    expect(rankProductSales(returned)).toEqual([]);
  });
  it('sorts the same complete history by units, sales or profit', () => {
    const rows = buildProductSales([
      order(),
      order({
        order_id: 'premium',
        items: [line({ product_id: 'premium', quantity: 1, price_clienta: 500, price_cost: 450 })],
      }),
    ]);
    expect(rankProductSales(rows)[0].productId).toBe('p');
    expect(rankProductSales(rows, 'sales')[0].productId).toBe('premium');
    expect(rankProductSales(rows, 'profit')[0].productId).toBe('p');
  });
  it('does not promote missing costs as profit and deduplicates legacy order counts', () => {
    const rows = buildProductSales([
      order({
        items: [
          line({ product_id: null, sku: 'BM-P', price_cost: null }),
          line({ product_id: null, sku: 'BM-P-M', price_cost: null }),
        ],
      }),
    ]);
    expect(rankProductSales(rows, 'profit')).toEqual([]);
    const stats = salesForProduct(rows, {
      ...product,
      listing: { ...product.listing, items: [{ sku: 'BM-P' }, { sku: 'BM-P-M' }] },
    } as NormalizedListingDocV3);
    expect(stats.orders).toBe(1);
    expect(stats.customers).toBe(1);
    expect(stats.units).toBe(4);
  });
});
