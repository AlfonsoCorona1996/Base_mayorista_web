import { Injectable, computed, inject } from '@angular/core';
import { OrdersService } from './orders.service';
import { BusinessScopeService } from './business-scope.service';
import { buildProductSales, salesForProduct } from './product-sales';
import type { NormalizedListingDocV3 } from './firestore-contracts';

@Injectable({ providedIn: 'root' })
export class ProductSalesService {
  private orders = inject(OrdersService);
  private scope = inject(BusinessScopeService);
  readonly state = computed(() => this.orders.syncState());
  readonly error = computed(() => this.orders.loadError());
  readonly rows = computed(() =>
    buildProductSales(
      this.scope.availableBusinessIds().flatMap((id) => this.orders.forBusiness(id)),
    ),
  );
  readonly activeRows = computed(() =>
    this.rows().filter((row) => this.scope.activeBusinessIds().includes(row.businessId)),
  );

  statsFor(product: NormalizedListingDocV3) {
    return salesForProduct(this.rows(), product);
  }
  retry(): void {
    void this.orders.loadFromFirestore();
  }
}
