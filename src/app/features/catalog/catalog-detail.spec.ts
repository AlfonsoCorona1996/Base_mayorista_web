import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import CatalogDetailPage from './catalog-detail';
import { NormalizedListingsService } from '../../core/normalized-listings.service';
import { SuppliersService } from '../../core/suppliers.service';
import { OrdersService } from '../../core/orders.service';
import { InventoryService } from '../../core/inventory.service';
import { FeatureFlagsService } from '../../core/feature-flags.service';
import { BusinessScopeService } from '../../core/business-scope.service';
import type { NormalizedListingDocV3 } from '../../core/firestore-contracts';

describe('Catalog detail: presentation and editing', () => {
  let fixture: ComponentFixture<CatalogDetailPage>;
  let page: CatalogDetailPage;
  let root: HTMLElement;
  const sample: NormalizedListingDocV3 = {
    schema_version: 'normalized_v3.0',
    normalized_id: 'product',
    raw_post_id: 'raw',
    supplier_id: 'supplier',
    business_id: 'bm',
    created_at: null,
    updated_at: null,
    cover_images: ['photo-a.jpg'],
    preview_image_url: 'photo-a.jpg',
    product_colors: [
      { name: 'Azul', image_url: 'photo-a.jpg' },
      { name: 'Negro', image_url: 'photo-b.jpg' },
    ],
    listing: {
      title: 'Pantalón de mezclilla',
      category_hint: 'Ropa / Mujer / Pantalones',
      supplierSku: 'ET-123',
      keywords: ['mezclilla'],
      items: [
        {
          variant_id: 'm',
          variant_name: 'M',
          sku: 'BM-123-M',
          stock_state: 'in_stock',
          notes: null,
          color_stock: [
            { color_name: 'Azul', stock_state: 'in_stock' },
            { color_name: 'Negro', stock_state: 'last_pair' },
          ],
          prices: { precio_costo: 720, precio_clienta: 1080, precio_final: 1440, currency: 'MXN' },
        },
      ],
    },
    workflow: { status: 'validated', validated_at: null, validated_by: null },
    review: { preview_image_url: null, excluded_image_urls: [], edited_at: null, edited_by: null },
  };
  const updateListing = jasmine.createSpy('updateListing').and.resolveTo();
  const inventoryFeature = signal(true);

  beforeEach(async () => {
    updateListing.calls.reset();
    inventoryFeature.set(true);
    await TestBed.configureTestingModule({
      imports: [CatalogDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'product' } } } },
        { provide: Router, useValue: { navigateByUrl: jasmine.createSpy().and.resolveTo(true) } },
        {
          provide: NormalizedListingsService,
          useValue: { getById: async () => structuredClone(sample), updateListing },
        },
        { provide: SuppliersService, useValue: { getById: () => ({ display_name: 'Proveedor' }) } },
        {
          provide: OrdersService,
          useValue: {
            loadFromFirestore: () => {},
            list: signal([]),
            forBusiness: () => [],
            syncState: signal('server'),
            loadError: signal(null),
          },
        },
        {
          provide: BusinessScopeService,
          useValue: { availableBusinessIds: () => ['bm'], activeBusinessIds: () => ['bm'] },
        },
        { provide: InventoryService, useValue: { loadFromFirestore: () => {}, items: signal([]) } },
        { provide: FeatureFlagsService, useValue: { enabled: () => inventoryFeature() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CatalogDetailPage);
    page = fixture.componentInstance;
    root = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('browses color photos without changing the cover or writing the product', () => {
    root.querySelectorAll<HTMLButtonElement>('.color-option')[1].click();
    fixture.detectChanges();
    expect(root.querySelector<HTMLImageElement>('.hero-photo img')?.getAttribute('src')).toBe(
      'photo-b.jpg',
    );
    expect(page.coverUrl()).toBe('photo-a.jpg');
    expect(root.querySelector('.color-option .cover-label')?.textContent).toContain('Portada');
    expect(updateListing).not.toHaveBeenCalled();
  });

  it('saves an edited cost while preserving independently entered sale and client prices', async () => {
    root.querySelector<HTMLButtonElement>('.edit-toggle')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = root.querySelector<HTMLInputElement>('#price-precio_costo-0')!;
    input.value = '725.50';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.actions-bar .btn-primary')!.click();
    await fixture.whenStable();
    expect(updateListing).toHaveBeenCalledOnceWith(
      'product',
      jasmine.objectContaining({
        listing: jasmine.objectContaining({
          items: [
            jasmine.objectContaining({
              prices: {
                precio_costo: 725.5,
                precio_clienta: 1080,
                precio_final: 1440,
                currency: 'MXN',
              },
            }),
          ],
        }),
      }),
    );
  });

  it('keeps stock edits coupled to their variant and announces saved state', async () => {
    const select = root.querySelector<HTMLSelectElement>('#variant-state-0')!;
    select.value = Array.from(select.options).find(
      (option) => option.textContent?.trim() === 'Agotado',
    )!.value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(
      page
        .doc()
        ?.listing.items[0].color_stock.every((color) => color.stock_state === 'out_of_stock'),
    ).toBeTrue();
    root.querySelector<HTMLButtonElement>('.actions-bar .btn-primary')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('.actions-bar [role="status"]')?.textContent).toContain(
      'guardados correctamente',
    );
  });

  it('respects the catalog price scope and the inventory feature flag', () => {
    page.doc.set({ ...page.doc()!, business_id: 'catalogo' });
    inventoryFeature.set(false);
    fixture.detectChanges();
    expect(root.querySelector('.price-overview')?.textContent).not.toContain('Precio de venta');
    expect(root.querySelector('.price-overview')?.textContent).toContain('Precio clienta');
    expect(root.querySelector('.performance-section')).toBeNull();
  });
  it('shows loading and errors instead of a false zero sales value', () => {
    const orders = TestBed.inject(OrdersService);
    orders.syncState.set('loading');
    fixture.detectChanges();
    expect(root.querySelector('.sales-metrics')).toBeNull();
    expect(root.querySelector('.sales-summary [role="status"]')?.textContent).toContain('Cargando');
    orders.syncState.set('error');
    orders.loadError.set('No se pudo consultar pedidos');
    fixture.detectChanges();
    expect(root.querySelector('.sales-metrics')).toBeNull();
    expect(root.querySelector('.sales-summary [role="alert"]')?.textContent).toContain(
      'No se pudieron',
    );
  });
});
