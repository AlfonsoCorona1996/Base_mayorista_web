import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ProductSalesService } from '../../core/product-sales.service';
import { rankProductSales } from '../../core/product-sales';
import { BusinessScopeService } from '../../core/business-scope.service';

@Component({
  standalone: true,
  selector: 'app-product-sales-ranking',
  imports: [CurrencyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ranking" aria-labelledby="ranking-title">
      <div class="ranking-head">
        <div>
          <p class="eyebrow">VENTAS ACUMULADAS</p>
          <h2 id="ranking-title">Tu producto estrella</h2>
        </div>
        <label class="sort-label"
          >Comparar por<select [value]="metric()" (change)="changeMetric($event)">
            <option value="units">Unidades vendidas</option>
            <option value="sales">Venta neta</option>
            <option value="profit">Ganancia</option>
          </select></label
        >
      </div>
      @if (sales.state() === 'error') {
        <div class="state error" role="alert">
          <p>No se pudieron actualizar las ventas. Reintenta para consultar el ranking.</p>
          <button type="button" (click)="sales.retry()">Reintentar</button>
        </div>
      } @else if (sales.state() !== 'server') {
        <p class="state" role="status">
          {{
            sales.state() === 'cache' ? 'Confirmando ventas con el servidor…' : 'Cargando ventas…'
          }}
        </p>
      } @else {
        @if (ranked()[0]; as star) {
          <div class="star">
            <span class="position">1</span>
            <div>
              <p class="star-title">{{ star.title }}</p>
              <p class="context">
                {{ star.units }} unidades netas · {{ star.orders }}
                {{ star.orders === 1 ? 'pedido' : 'pedidos' }} ·
                {{ scope.businessShortLabel(star.businessId === 'catalogo' ? 'catalogo' : 'bm') }}
              </p>
              @if (star.reference === 'manual' || star.reference === 'sku') {
                <p class="context">Registro histórico sin vínculo al catálogo</p>
              }
            </div>
          </div>
          <div class="star-metrics">
            <div>
              <span>Venta neta</span
              ><strong>{{ star.sales | currency: 'MXN' : 'symbol' : '1.2-2' }}</strong>
            </div>
            <div>
              <span>Ganancia</span
              ><strong>{{ star.profit | currency: 'MXN' : 'symbol' : '1.2-2' }}</strong>
            </div>
            <div>
              <span>Devoluciones</span><strong>{{ star.returns }}</strong>
            </div>
          </div>
          @if (star.missingCostUnits) {
            <p class="quality">
              Ganancia incompleta: hay {{ star.missingCostUnits }} unidades sin costo registrado.
            </p>
          }
          <details class="ranking-comparison">
            <summary>Ver los 5 primeros productos</summary>
            <ol class="ranking-list">
              @for (row of ranked().slice(0, 5); track row.key; let i = $index) {
                <li>
                  <span class="rank-number">{{ i + 1 }}</span>
                  <div class="rank-copy">
                    @if (row.reference === 'normalized_listing' && row.productId) {
                      <a [routerLink]="['/main/catalogo', row.productId]">{{ row.title }}</a>
                    } @else {
                      <span>{{ row.title }}</span>
                    }
                    <small
                      >{{ row.units }} uds. ·
                      {{ row.sales | currency: 'MXN' : 'symbol' : '1.2-2' }} venta ·
                      {{ row.profit | currency: 'MXN' : 'symbol' : '1.2-2' }} ganancia</small
                    >
                    @if (row.reference === 'manual' || row.reference === 'sku') {
                      <small>Producto histórico sin vínculo al catálogo</small>
                    }
                  </div>
                </li>
              }
            </ol>
          </details>
          <details>
            <summary>Cómo se calcula</summary>
            <p>
              Incluye todos los pedidos del negocio seleccionado, con independencia de los filtros y
              páginas del catálogo. Se agrupan tallas y colores por producto; se descuentan
              devoluciones y descuentos. El envío se excluye de la venta del producto.
            </p>
            <p>
              Los registros manuales se agrupan por su nombre y se identifican aparte. Los productos
              vinculados al catálogo se agrupan por su ID.
            </p>
            <p>
              La comparación por ganancia requiere que todos los costos del producto estén
              registrados.
            </p>
          </details>
        } @else {
          <p class="state">
            {{
              metric() === 'profit'
                ? 'No hay productos con costos completos para comparar la ganancia.'
                : 'Todavía no hay ventas concretadas registradas para este negocio.'
            }}
          </p>
        }
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      font-family: Inter, sans-serif;
      color: #202631;
    }
    * {
      box-sizing: border-box;
    }
    h2,
    p {
      margin: 0;
    }
    h2 {
      font-size: 1rem;
      font-weight: 650;
    }
    .ranking {
      background: #fff;
      border: 1px solid #e2e5ea;
      border-radius: var(--ui-radius-lg);
      padding: var(--ui-space-16);
      margin-block: var(--ui-space-16);
    }
    .ranking-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--ui-space-16);
      align-items: start;
    }
    .eyebrow {
      font-size: 0.625rem;
      letter-spacing: 0.1em;
      color: #637083;
      margin-bottom: var(--ui-space-8);
    }
    .sort-label {
      display: grid;
      gap: var(--ui-space-8);
      font-size: 0.75rem;
      color: #637083;
      min-width: 0;
    }
    select,
    button {
      min-height: var(--ui-touch-target-min);
      font: inherit;
      border: 1px solid #d3dbe7;
      border-radius: var(--ui-radius-sm);
      padding: var(--ui-space-8) var(--ui-space-12);
      background: #fff;
      color: #202631;
      max-width: 100%;
    }
    select {
      font-size: 1rem;
    }
    button {
      cursor: pointer;
    }
    :is(button, select, a, summary):focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 3px;
    }
    .star {
      display: flex;
      align-items: center;
      gap: var(--ui-space-12);
      margin-top: var(--ui-space-24);
    }
    .star > div,
    .rank-copy {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .position {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      width: var(--ui-space-48);
      height: var(--ui-space-48);
      background: #eff6ff;
      color: #2563eb;
      border-radius: var(--ui-radius-md);
      font-size: 1.25rem;
      font-weight: 650;
    }
    .star-title {
      font-size: 1.1rem;
      font-weight: 650;
      line-height: 1.4;
    }
    .context {
      font-size: 0.75rem;
      color: #637083;
      margin-top: var(--ui-space-4);
    }
    .star-metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--ui-space-16);
      margin-block: var(--ui-space-24);
    }
    .star-metrics div {
      display: grid;
      gap: var(--ui-space-4);
      min-width: 0;
    }
    .star-metrics span {
      font-size: 0.75rem;
      color: #637083;
    }
    .star-metrics strong {
      font-size: 1rem;
      overflow-wrap: anywhere;
    }
    .ranking-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: var(--ui-space-12);
    }
    .ranking-list li {
      display: flex;
      gap: var(--ui-space-12);
      align-items: center;
      border-top: 1px solid #e2e5ea;
      padding-top: var(--ui-space-12);
    }
    .rank-number {
      width: var(--ui-space-24);
      flex-shrink: 0;
      font-size: 0.8rem;
      color: #637083;
    }
    .rank-copy {
      display: grid;
      gap: var(--ui-space-4);
      font-size: 0.85rem;
    }
    .rank-copy a {
      display: inline-flex;
      align-items: center;
      min-height: var(--ui-touch-target-min);
      color: #1d4ed8;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .rank-copy small {
      font-size: 0.75rem;
      color: #637083;
    }
    details {
      margin-top: var(--ui-space-16);
      color: #637083;
      font-size: 0.75rem;
    }
    summary {
      min-height: var(--ui-touch-target-min);
      align-content: center;
      cursor: pointer;
    }
    details p {
      margin-left: var(--ui-space-12);
      padding: var(--ui-space-8) var(--ui-space-12);
      border-left: 2px solid #e2e5ea;
      background: #f6f7f9;
      line-height: 1.5;
    }
    .state {
      margin-top: var(--ui-space-16);
      font-size: 0.85rem;
      line-height: 1.5;
      color: #637083;
    }
    .state button {
      margin-top: var(--ui-space-12);
    }
    .error {
      color: #b42318;
    }
    .quality {
      background: #fff2df;
      color: #92520d;
      padding: var(--ui-space-12);
      font-size: 0.75rem;
      margin-bottom: var(--ui-space-16);
    }
    @media (min-width: 768px) {
      .ranking {
        padding: var(--ui-space-24);
      }
      .star-metrics {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      select {
        font-size: 0.85rem;
      }
    }
  `,
})
export class ProductSalesRankingComponent {
  readonly sales = inject(ProductSalesService);
  readonly scope = inject(BusinessScopeService);
  readonly metric = signal<'units' | 'sales' | 'profit'>('units');
  readonly ranked = computed(() => rankProductSales(this.sales.activeRows(), this.metric()));
  changeMetric(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'units' || value === 'sales' || value === 'profit') this.metric.set(value);
  }
}
