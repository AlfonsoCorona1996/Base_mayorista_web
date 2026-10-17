import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { CategoriesService, Category } from '../../core/categories.service';
import { NormalizedListingDocV3 } from '../../core/firestore-contracts';
import { NormalizedListingsService } from '../../core/normalized-listings.service';
import { SuppliersService } from '../../core/suppliers.service';
import ReviewPage from './review';

const category: Category = {
  id: 'ropa',
  name: 'Ropa',
  fullPath: 'Ropa',
  parentId: null,
  level: 0,
  active: true,
  order: 1,
};
const photo =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#dae7ff"/></svg>',
  );
function draft(): NormalizedListingDocV3 {
  return {
    schema_version: 'normalized_v3.0',
    normalized_id: 'review-test',
    raw_post_id: 'raw-test',
    supplier_id: 'supplier',
    business_id: 'bm',
    created_at: null,
    updated_at: null,
    cover_images: [photo],
    product_colors: [{ name: 'Azul marino', image_url: photo }],
    listing: {
      title: 'Conjunto deportivo infantil con nombre largo para comprobar la pantalla',
      category_hint: 'Ropa',
      keywords: ['conjunto deportivo', 'palabra'.repeat(18)],
      supplierSku: '0001-A',
      items: ['6', '8', '10', '12'].map((name) => ({
        variant_id: 'v' + name,
        variant_name: name,
        sku: 'INTERNAL-' + name,
        stock_state: 'in_stock',
        notes: null,
        color_stock: [{ color_name: 'Azul marino', stock_state: 'in_stock' }],
        prices: { precio_costo: 100, precio_clienta: 150, precio_final: 200, currency: 'MXN' },
      })),
    },
    workflow: { status: 'needs_review', validated_by: null, validated_at: null },
    review: { preview_image_url: null, excluded_image_urls: [], edited_at: null, edited_by: null },
  };
}

describe('Review flujo rápido', () => {
  let fixture: ComponentFixture<ReviewPage>;
  let page: ReviewPage;
  let listings: jasmine.SpyObj<NormalizedListingsService>;
  let categories: jasmine.SpyObj<CategoriesService>;
  beforeEach(async () => {
    listings = jasmine.createSpyObj('NormalizedListingsService', [
      'saveReviewDecision',
      'invalidateAllValidated',
      'updateListing',
      'reject',
      'loadAllValidated',
    ]);
    listings.saveReviewDecision.and.resolveTo();
    listings.loadAllValidated.and.resolveTo([]);
    categories = jasmine.createSpyObj('CategoriesService', [
      'getAll',
      'getRoots',
      'getChildren',
      'getByPath',
      'getById',
      'search',
      'ensurePath',
      'addCategory',
      'loadCategories',
    ]);
    categories.loadCategories.and.resolveTo();
    categories.getAll.and.returnValue([category]);
    categories.getRoots.and.returnValue([category]);
    categories.getChildren.and.returnValue([]);
    categories.search.and.returnValue([category]);
    categories.getByPath.and.returnValue(null);
    categories.getById.and.returnValue(category);
    categories.addCategory.and.resolveTo(category.id);
    categories.ensurePath.and.resolveTo(category.fullPath);
    await TestBed.configureTestingModule({
      imports: [ReviewPage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => 'review-test' } } },
        },
        { provide: Router, useValue: { navigateByUrl: jasmine.createSpy().and.resolveTo(true) } },
        { provide: NormalizedListingsService, useValue: listings },
        { provide: AuthService, useValue: { uid: () => 'user' } },
        { provide: CategoriesService, useValue: categories },
        {
          provide: SuppliersService,
          useValue: {
            getActive: () => [
              { supplier_id: 'supplier', display_name: 'Proveedor con nombre comercial largo' },
            ],
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ReviewPage);
    page = fixture.componentInstance;
    spyOn(page, 'load').and.resolveTo();
    page.draft.set(draft());
    page.rawImages.set([photo]);
    page['initializeSharedPriceInputs']();
    page.rawText.set('Mensaje del proveedor '.repeat(45));
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('guarda campos manuales y publica sin modificar SKU internos ni portadas', async () => {
    page.keywordInput = ' SNEAKERS ';
    page.addKeyword();
    page.setSupplierSku(' 0002-B ');
    const secondPhoto = photo + '#second';
    page.draft()!.cover_images.push(secondPhoto);
    await page.save();
    let patch = listings.saveReviewDecision.calls.mostRecent().args[1];
    expect(patch.listing?.keywords).toContain('sneakers');
    expect(patch.listing?.supplierSku).toBe('0002-B');
    expect(patch.listing?.extractionOverrides).toEqual({ keywords: true, supplierSku: true });
    expect(patch.cover_images).toEqual([photo, secondPhoto]);
    expect(patch.listing?.items[0].sku).toBe('INTERNAL-6');
    page.confirmPopup();
    page.confirmCategory();
    await page.validate();
    patch = listings.saveReviewDecision.calls.mostRecent().args[1];
    expect(patch.listing?.supplierSku).toBe('0002-B');
    expect(listings.saveReviewDecision.calls.mostRecent().args[3]?.validatedBy).toBe('user');
  });

  it('requiere confirmación explícita, la guarda y la invalida para otra ruta', async () => {
    expect(page.categoryConfirmed()).toBeFalse();
    await page.validate();
    expect(listings.saveReviewDecision).not.toHaveBeenCalled();
    expect(page.fieldErrors().category).toContain('Confirma');
    page.confirmCategory();
    expect(page.categoryConfirmed()).toBeTrue();
    await page.save();
    expect(listings.saveReviewDecision.calls.mostRecent().args[1].listing?.categoryReview?.confirmedBy).toBe('user');
    page.draft.set({ ...page.draft()!, listing: { ...page.draft()!.listing, category_hint: 'Otra' } });
    expect(page.categoryConfirmed()).toBeFalse();
  });

  it('muestra y descarta la propuesta sin crear categorías ni abrir menús', () => {
    page.draft()!.listing.category_hint = null;
    page.draft()!.listing.category_proposed = 'Ropa > Nueva';
    page.editableCategoryProposal.set('Ropa > Nueva');
    fixture.detectChanges();
    const proposal = fixture.nativeElement.querySelector('.category-proposal') as HTMLElement;
    expect(proposal.closest('details')).toBeNull();
    expect(proposal.textContent).toContain('Crear categoría y aceptar');
    page.dismissCategoryProposal();
    expect(categories.ensurePath).not.toHaveBeenCalled();
    expect(page.draft()!.listing.category_proposed).toBeNull();
    expect(page.categoryConfirmed()).toBeFalse();
  });

  it('conserva la propuesta si Firebase rechaza la creación', async () => {
    page.editableCategoryProposal.set('Ropa > Nueva');
    categories.ensurePath.and.rejectWith(new Error('Sin permiso'));
    await page.acceptCategoryProposal();
    expect(page.editableCategoryProposal()).toBe('Ropa > Nueva');
    expect(page.categoryConfirmed()).toBeFalse();
    expect(page.categoryProposalSaving()).toBeFalse();
  });

  it('requiere revisar asociaciones dudosas y vuelve a pedirlo al editar el color', () => {
    const value = draft();
    value.product_colors[0].review_required = true;
    page.draft.set(value);
    expect(page.colorReviewNeeded()).toBeTrue();
    page.confirmColors();
    expect(page.colorReviewNeeded()).toBeFalse();
    page.draft.set({ ...value, product_colors: [{ ...value.product_colors[0], name: 'Azul cielo' }] });
    expect(page.colorReviewNeeded()).toBeTrue();
  });

  it('protege nombre y características corregidos manualmente', () => {
    page.setTitle('Pantalón recto de mezclilla');
    page.draft()!.listing.attributes = [{ kind: 'material', value: 'algodón', source: 'text' }];
    page.editAttribute(0, 'mezclilla');
    expect(page.draft()!.listing.extractionOverrides?.title).toBeTrue();
    expect(page.draft()!.listing.extractionOverrides?.attributes).toBeTrue();
    expect(page.draft()!.listing.attributes?.[0].source).toBe('manual');
  });

  it('conserva stock desconocido y permite restaurar una foto excluida', () => {
    const value = draft();
    value.listing.items[0].stock_state = 'unknown_qty';
    page['normalizeV3Draft'](value);
    expect(value.listing.items[0].stock_state).toBe('unknown_qty');
    page.draft.set(value);
    page.removeImage(photo);
    expect(page.galleryImages()).toEqual([]);
    expect(page.draft()!.product_colors[0].image_url).toBeNull();
    page.restoreImage(photo);
    expect(page.galleryImages()).toContain(photo);
  });

  it('inicia Review con disponibilidad para variantes y colores sin confirmar', () => {
    const value = draft();
    value.listing.items[0].stock_state = 'unknown_qty';
    value.listing.items[0].color_stock[0].stock_state = 'unknown_qty';
    value.listing.items[1].stock_state = 'out_of_stock';
    value.listing.items[1].color_stock[0].stock_state = 'out_of_stock';
    value.listing.items[2].stock_state = 'last_pair';
    Reflect.deleteProperty(value.listing.items[3], 'stock_state');
    Reflect.deleteProperty(value.listing.items[3].color_stock[0], 'stock_state');
    page['normalizeV3Draft'](value, true);
    expect(value.listing.items[0].stock_state).toBe('in_stock');
    expect(value.listing.items[0].color_stock[0].stock_state).toBe('in_stock');
    expect(value.listing.items[1].stock_state).toBe('out_of_stock');
    expect(value.listing.items[1].color_stock[0].stock_state).toBe('out_of_stock');
    expect(value.listing.items[2].stock_state).toBe('last_pair');
    expect(value.listing.items[3].stock_state).toBe('in_stock');
    expect(value.listing.items[3].color_stock[0].stock_state).toBe('in_stock');
  });

  it('crea las nuevas variantes disponibles por defecto', () => {
    page.variantInput = '14';
    page.addVariant();
    const variant = page.draft()!.listing.items.at(-1)!;
    expect(variant.stock_state).toBe('in_stock');
    expect(variant.color_stock.every(color => color.stock_state === 'in_stock')).toBeTrue();
  });

  it('bloquea variantes equivalentes al añadir, renombrar y guardar', async () => {
    page.variantInput = '06.00';
    page.addVariant();
    expect(page.draft()!.listing.items.length).toBe(4);
    page.renameVariant(1, ' 6 ');
    expect(page.draft()!.listing.items[1].variant_name).toBe('8');
    page.draft()!.listing.items[1].variant_name = '06';
    await page.save();
    expect(listings.saveReviewDecision).not.toHaveBeenCalled();
  });

  it('crea categoría inline con padre y acepta una propuesta usando el servicio compartido', async () => {
    page.categoryParentId = 'padre';
    page.newCategoryName = 'Conjuntos';
    await page.createInlineCategory();
    expect(categories.addCategory).toHaveBeenCalledWith('Conjuntos', 'padre');
    expect(page.draft()!.listing.category_hint).toBe(category.fullPath);
    page.editableCategoryProposal.set(' RÓPA ');
    await page.acceptCategoryProposal();
    expect(categories.ensurePath).toHaveBeenCalledWith('RÓPA');
    expect(page.draft()!.listing.category_proposed).toBeNull();
    expect(page.editableCategoryProposal()).toBe('');
  });

  it('selecciona foto sin crear el color hasta confirmar y conserva la portada', () => {
    const prompt = spyOn(window, 'prompt');
    page.addGlobalColorWithImage();
    page.newColorName = 'Rojo vino';
    expect(page.canAddNewColor()).toBeFalse();
    page.assignImageToColor(photo);
    expect(page.draft()!.product_colors.length).toBe(1);
    expect(page.canAddNewColor()).toBeTrue();
    page.submitNewColor();
    expect(page.draft()!.product_colors.length).toBe(2);
    expect(page.draft()!.product_colors[1]).toEqual({ name: 'Rojo vino', image_url: photo, image_id: null });
    expect(page.draft()!.cover_images[0]).toBe(photo);
    expect(page.showImagePicker()).toBeFalse();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rechaza colores duplicados y cancelar no modifica los colores', () => {
    page.addGlobalColorWithImage();
    page.newColorName = '  AZUL MARINO  ';
    page.assignImageToColor(photo);
    page.submitNewColor();
    expect(page.newColorError()).toContain('Ya existe');
    expect(page.draft()!.product_colors.length).toBe(1);
    page.closeImagePicker();
    expect(page.draft()!.product_colors.length).toBe(1);
  });

  it('crea un color sin foto mediante el mismo formulario y protege la edición', () => {
    page.addGlobalColorWithoutImage();
    page.submitNewColor();
    expect(page.newColorError()).toContain('nombre');
    page.newColorName = '  Verde   olivo  ';
    page.submitNewColor();
    expect(page.draft()!.product_colors[1].name).toBe('Verde olivo');
    expect(page.draft()!.product_colors[1].image_url).toBeNull();
    expect(page.draft()!.listing.extractionOverrides?.colors).toBeTrue();
  });

  it('permite cancelar selectores y fusión con Escape salvo durante una escritura', () => {
    page.openCoverSelector();
    fixture.detectChanges();
    const picker = fixture.nativeElement.querySelector('dialog[aria-labelledby="picker-title"]') as HTMLDialogElement;
    const cancelPicker = new Event('cancel', { cancelable: true });
    picker.dispatchEvent(cancelPicker);
    expect(cancelPicker.defaultPrevented).toBeFalse();
    page.uploading.set(true);
    fixture.detectChanges();
    const busyPicker = new Event('cancel', { cancelable: true });
    picker.dispatchEvent(busyPicker);
    expect(busyPicker.defaultPrevented).toBeTrue();
    page.uploading.set(false);
    page.closeImagePicker();
    fixture.detectChanges();
    const merge = fixture.nativeElement.querySelector('dialog[aria-labelledby="merge-title"]') as HTMLDialogElement;
    const cancelMerge = new Event('cancel', { cancelable: true });
    merge.dispatchEvent(cancelMerge);
    expect(cancelMerge.defaultPrevented).toBeFalse();
    page.mergeApplying.set(true);
    fixture.detectChanges();
    const busyMerge = new Event('cancel', { cancelable: true });
    merge.dispatchEvent(busyMerge);
    expect(busyMerge.defaultPrevented).toBeTrue();
  });

  it('abre la galería, navega, contiene foco y devuelve foco al cerrar', async () => {
    page.rawImages.set([photo, photo + '#2']);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const trigger = root.querySelector<HTMLButtonElement>('.photo-open')!;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    const dialog = root.querySelector<HTMLDialogElement>('.lightbox')!;
    expect(dialog.open).toBeTrue();
    expect(dialog.contains(document.activeElement)).toBeTrue();
    page.stepLightbox(1);
    fixture.detectChanges();
    expect(page.lightboxIndex()).toBe(1);
    page.stepLightbox(1);
    expect(page.lightboxIndex()).toBe(0);
    dialog.close();
    expect(document.activeElement).toBe(trigger);
  });

  it('mantiene precios individuales, notas, mensaje y fusión cerrados inicialmente', () => {
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelectorAll('.variant-prices').length).toBe(0);
    expect(root.querySelectorAll('.variant-editor').length).toBe(0);
    expect(
      root.querySelector<HTMLDialogElement>('#merge-title')?.closest('dialog')?.open,
    ).toBeFalse();
    expect(root.querySelector('.raw-message')?.closest('details')?.open).toBeFalse();
    page.useSharedPrices.set(false);
    fixture.detectChanges();
    expect(root.querySelectorAll('.variant-prices').length).toBe(4);
  });

  it('enfoca el proveedor con error contextual sin publicar ni perder datos', async () => {
    page.draft()!.supplier_id = null;
    const title = page.draft()!.listing.title;
    await page.validate();
    fixture.detectChanges();
    await new Promise<void>(resolve => setTimeout(resolve));
    const select = fixture.nativeElement.querySelector('#supplier-select') as HTMLSelectElement;
    expect(document.activeElement).toBe(select);
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.querySelector('#supplier-error').textContent).toContain('proveedor');
    expect(page.popupState()).toBeNull();
    expect(page.draft()!.listing.title).toBe(title);
    expect(listings.saveReviewDecision).not.toHaveBeenCalled();
    page.draft()!.supplier_id = 'supplier';
    page.onSupplierChange();
    expect(page.fieldErrors().supplier).toBeUndefined();
  });

  it('integra colores compartidos, sin fotografía y fotos adicionales sin perder asociaciones', () => {
    const value = draft();
    value.product_colors.push({ name: 'Azul compartido', image_url: photo }, { name: 'Sin foto', image_url: null });
    page.draft.set(value);
    page.rawImages.set([photo, photo + '#extra']);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.color-card').length).toBe(3);
    expect(page.unassignedImages()).toEqual([photo + '#extra']);
    expect(page.imageColorLabel(photo)).toContain('Azul compartido');
    page.selectedPreview.set(photo + '#extra');
    page.removeImage(photo + '#extra');
    expect(page.previewImage()).toBe(photo);
    expect(page.draft()!.product_colors[0].image_url).toBe(photo);
  });

  it('edita variantes en diálogo y confirma antes de eliminar sus datos', () => {
    const root: HTMLElement = fixture.nativeElement;
    const trigger = root.querySelector<HTMLButtonElement>('.variant-chip button')!;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    const dialog = root.querySelector<HTMLDialogElement>('.variant-editor')!;
    expect(dialog.open).toBeTrue();
    expect(dialog.contains(document.activeElement)).toBeTrue();
    const confirm = spyOn(window, 'confirm').and.returnValue(false);
    page.confirmRemoveVariant(0);
    expect(page.draft()!.listing.items.length).toBe(4);
    confirm.and.returnValue(true);
    page.confirmRemoveVariant(0);
    fixture.detectChanges();
    expect(page.draft()!.listing.items.length).toBe(3);
    expect(page.expandedVariant()).toBeNull();
  });

  it('navega el visor, amplía y restablece el desplazamiento al cambiar de foto', () => {
    page.rawImages.set([photo, photo + '#2']);
    page.onLightboxKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(page.lightboxIndex()).toBe(1);
    page.toggleLightboxZoom();
    expect(page.lightboxZoom()).toBe(2);
    page.lightboxPan.set({ x: 30, y: -20 });
    page.stepLightbox(1);
    expect(page.lightboxIndex()).toBe(0);
    expect(page.lightboxPan()).toEqual({ x: 0, y: 0 });
    expect(page.lightboxZoom()).toBe(1);
  });

  it('avisa de guardado sin abrir un modal que interrumpa la edición', async () => {
    await page.save();
    fixture.detectChanges();
    const notice = fixture.nativeElement.querySelector('.review-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('Guardado correctamente');
    expect(fixture.nativeElement.querySelector('dialog[open]')).toBeNull();
    page.confirmPopup();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.review-notice')).toBeNull();
  });

  it('muestra carga, vacío, sin resultados y error, y deshabilita la edición mientras guarda', () => {
    const root: HTMLElement = fixture.nativeElement;
    page.loading.set(true);
    fixture.detectChanges();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Cargando');
    page.loading.set(false);
    const empty = draft();
    empty.listing.items = [];
    empty.listing.keywords = [];
    empty.cover_images = [];
    empty.product_colors = [];
    page.draft.set(empty);
    page.rawImages.set([]);
    page.showCategoryDropdown.set(true);
    page.filteredCategories.set([]);
    page.error.set('No se pudo guardar. Intenta de nuevo.');
    fixture.detectChanges();
    expect(root.textContent).toContain('No hay fotos disponibles');
    expect(root.textContent).toContain('Añade al menos una variante');
    expect(root.textContent).toContain('Sin resultados');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Intenta de nuevo');
    page.saving.set(true);
    fixture.detectChanges();
    expect(root.querySelector('fieldset')?.disabled).toBeTrue();
    expect(root.querySelector<HTMLButtonElement>('.actions-bar button')?.disabled).toBeTrue();
  });

  for (const [width, height] of [
    [360, 800],
    [375, 667],
    [390, 844],
    [430, 932],
    [768, 1024],
    [1024, 768],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ]) {
    it(`sin desbordamiento y controles táctiles a ${width} × ${height}`, async () => {
      // Real browser layout inside a same-origin viewport, with the actual Angular template and CSS.
      const frame = document.createElement('iframe');
      frame.style.cssText = `width:${width}px;height:${height}px;border:0`;
      document.body.appendChild(frame);
      const view = frame.contentDocument!;
      const styles = view.createElement('style');
      for (const sheet of [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]) {
        try {
          styles.textContent += Array.from(sheet.cssRules)
            .map((rule) => rule.cssText)
            .join('\n');
        } catch {
          /* Remote font sheets are not needed for layout assertions. */
        }
      }
      view.head.appendChild(styles);
      // Angular's test builder may install the global sheet in the runner document.
      const tokens = getComputedStyle(document.documentElement);
      for (const name of Array.from(tokens))
        if (name.startsWith('--ui-'))
          view.documentElement.style.setProperty(name, tokens.getPropertyValue(name));
      view.body.style.margin = '0';
      view.body.appendChild(fixture.nativeElement);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      try {
        expect(view.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        for (const button of view.querySelectorAll<HTMLButtonElement>('button')) {
          if (
            !button.checkVisibility() ||
            button.closest('dialog:not([open])') ||
            button.closest('details:not([open])')
          )
            continue;
          const bounds = button.getBoundingClientRect();
          expect(bounds.height)
            .withContext(button.textContent || '')
            .toBeGreaterThanOrEqual(44);
          expect(bounds.right)
            .withContext(button.textContent || '')
            .toBeLessThanOrEqual(width);
          expect(bounds.left).toBeGreaterThanOrEqual(0);
        }
        page.expandedVariant.set('v6');
        page.showCategoryDropdown.set(true);
        page.filteredCategories.set([]);
        fixture.detectChanges();
        expect(view.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      } finally {
        frame.remove();
      }
    });
  }
});
