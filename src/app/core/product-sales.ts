import type { NormalizedListingDocV3 } from './firestore-contracts';
import type { Order, OrderItem } from './orders.service';
import { calculateItemFinancials, calculateOrderFinancials, money } from './order-financials';
import { isDeliveredForProfit } from './withdrawal-profit';

export interface ProductSales {
  key: string;
  businessId: Order['business_id'];
  productId: string | null;
  reference: 'normalized_listing' | 'catalog_product' | 'sku' | 'manual';
  title: string;
  image: string | null;
  skus: string[];
  orderIds?: string[];
  customerIds?: string[];
  pendingOrderIds?: string[];
  units: number;
  sales: number;
  profit: number;
  returns: number;
  orders: number;
  customers: number;
  pendingUnits: number;
  pendingOrders: number;
  missingCostUnits: number;
  lastSale: string | null;
}

const clean = (value: string | null | undefined): string => (value || '').trim().toLowerCase();
const titleKey = (value: string): string =>
  clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

export function emptyProductSales(): Omit<
  ProductSales,
  'key' | 'businessId' | 'productId' | 'reference' | 'title' | 'image' | 'skus'
> {
  return {
    units: 0,
    sales: 0,
    profit: 0,
    returns: 0,
    orders: 0,
    customers: 0,
    pendingUnits: 0,
    pendingOrders: 0,
    missingCostUnits: 0,
    lastSale: null,
  };
}

/** Uses all supplied orders, independently of catalog pagination. Never joins products by title. */
export function buildProductSales(orders: readonly Order[]): ProductSales[] {
  const groups = new Map<
    string,
    { row: ProductSales; orders: Set<string>; customers: Set<string>; pending: Set<string> }
  >();
  // Resolve legacy rows with only a SKU to an ID only if that SKU identifies a single product.
  const skuOwners = new Map<string, Set<string>>();
  const identity = (item: OrderItem): { reference: ProductSales['reference']; id: string } => {
    if (item.product_id && item.product_ref_type !== 'manual')
      return {
        reference:
          item.product_ref_type === 'catalog_product' ? 'catalog_product' : 'normalized_listing',
        id: item.product_id.trim(),
      };
    if (clean(item.sku)) return { reference: 'sku', id: clean(item.sku) };
    return { reference: 'manual', id: titleKey(item.title || 'Producto sin nombre') };
  };
  for (const order of orders)
    for (const item of order.items || []) {
      const owner = identity(item);
      if (owner.reference === 'manual' || owner.reference === 'sku' || !clean(item.sku)) continue;
      const skuKey = `${order.business_id || 'bm'}:${clean(item.sku)}`;
      const owners = skuOwners.get(skuKey) || new Set<string>();
      owners.add(`${owner.reference}:${owner.id}`);
      skuOwners.set(skuKey, owners);
    }
  for (const order of orders) {
    if (order.status === 'cancelado') continue;
    const completed = isDeliveredForProfit(order) || order.status === 'devuelto';
    const financials = calculateOrderFinancials(order);
    for (const item of order.items || []) {
      if (item.state === 'cancelado' || item.confirmation_state === 'out_of_stock') continue;
      const businessId = order.business_id || 'bm';
      let { reference, id } = identity(item);
      const owners = skuOwners.get(`${businessId}:${clean(item.sku)}`);
      if (reference === 'sku' && owners?.size === 1) {
        const owner = [...owners][0];
        const separator = owner.indexOf(':');
        reference = owner.slice(0, separator) as 'normalized_listing' | 'catalog_product';
        id = owner.slice(separator + 1);
      }
      const key = `${businessId}:${reference}:${id}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = {
          row: {
            key,
            businessId,
            productId:
              reference === 'normalized_listing' || reference === 'catalog_product' ? id : null,
            reference,
            title: item.title || 'Producto sin nombre',
            image: item.image_url || null,
            skus: [],
            ...emptyProductSales(),
          },
          orders: new Set(),
          customers: new Set(),
          pending: new Set(),
        };
        groups.set(key, entry);
      }
      const row = entry.row;
      if (clean(item.sku) && !row.skus.includes(clean(item.sku))) row.skus.push(clean(item.sku));
      const f = calculateItemFinancials(item);
      if (!completed) {
        row.pendingUnits += f.netQty;
        entry.pending.add(order.order_id);
        continue;
      }
      if (!f.recognizedQty) continue;
      const discountShare =
        financials.netClientBeforeDiscount > 0
          ? (financials.remainingDiscount * f.netClient) / financials.netClientBeforeDiscount
          : 0;
      const sale = f.netClient - discountShare;
      row.units += f.netQty;
      row.sales += sale;
      row.profit += sale - f.netCost;
      row.returns += f.returnedQty;
      if (item.price_cost == null) row.missingCostUnits += f.netQty;
      entry.orders.add(order.order_id);
      if (order.customer_id && f.netQty > 0) entry.customers.add(order.customer_id);
      const date = order.delivered_at || order.paid_at || order.created_at;
      if (f.netQty > 0 && date && (!row.lastSale || Date.parse(date) > Date.parse(row.lastSale)))
        row.lastSale = date;
    }
  }
  return [...groups.values()].map(({ row, orders, customers, pending }) => ({
    ...row,
    sales: money(row.sales),
    profit: money(row.profit),
    orderIds: [...orders],
    customerIds: [...customers],
    pendingOrderIds: [...pending],
    orders: orders.size,
    customers: customers.size,
    pendingOrders: pending.size,
  }));
}

export function salesForProduct(rows: readonly ProductSales[], product: NormalizedListingDocV3) {
  const skus = new Set(product.listing.items.map((item) => clean(item.sku)).filter(Boolean));
  const matches = rows.filter(
    (row) =>
      row.businessId === (product.business_id || 'bm') &&
      ((row.reference === 'normalized_listing' && row.productId === product.normalized_id) ||
        (row.reference === 'sku' && row.skus.some((sku) => skus.has(sku)))),
  );
  const result = emptyProductSales();
  for (const row of matches) {
    result.units += row.units;
    result.sales += row.sales;
    result.profit += row.profit;
    result.returns += row.returns;
    result.orders += row.orders;
    result.customers += row.customers;
    result.pendingUnits += row.pendingUnits;
    result.pendingOrders += row.pendingOrders;
    result.missingCostUnits += row.missingCostUnits;
    if (
      row.lastSale &&
      (!result.lastSale || Date.parse(row.lastSale) > Date.parse(result.lastSale))
    )
      result.lastSale = row.lastSale;
  }
  result.sales = money(result.sales);
  result.profit = money(result.profit);
  result.orders = new Set(matches.flatMap((row) => row.orderIds || [])).size;
  result.customers = new Set(matches.flatMap((row) => row.customerIds || [])).size;
  result.pendingOrders = new Set(matches.flatMap((row) => row.pendingOrderIds || [])).size;
  return result;
}

export function rankProductSales(
  rows: readonly ProductSales[],
  metric: 'units' | 'sales' | 'profit' = 'units',
): ProductSales[] {
  return rows
    .filter((row) => row.units > 0 && (metric !== 'profit' || row.missingCostUnits === 0))
    .slice()
    .sort(
      (a, b) =>
        b[metric] - a[metric] ||
        b.units - a.units ||
        b.sales - a.sales ||
        a.key.localeCompare(b.key),
    );
}
