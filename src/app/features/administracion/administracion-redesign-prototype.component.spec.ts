import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdministracionRedesignPrototypeComponent } from './administracion-redesign-prototype.component';

describe('AdministracionRedesignPrototypeComponent responsive layout', () => {
  let fixture: ComponentFixture<AdministracionRedesignPrototypeComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdministracionRedesignPrototypeComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AdministracionRedesignPrototypeComponent);
    fixture.componentRef.setInput('initialView', 'socios');
    fixture.componentRef.setInput('initialPartnerScope', 'general');
  });

  for (const width of [1440, 1024, 768, 390, 360]) {
    it(`contains page overflow at ${width}px`, () => {
      const host = fixture.nativeElement as HTMLElement;
      host.style.display = 'block';
      host.style.width = `${width}px`;
      host.style.maxWidth = `${width}px`;
      fixture.detectChanges();

      const page = host.querySelector<HTMLElement>('.finance-prototype');
      const tableScroller = host.querySelector<HTMLElement>('.distribution-history-table')?.parentElement;

      expect(page).withContext('The administration page should exist').not.toBeNull();
      expect(page!.scrollWidth)
        .withContext(`The page must not create horizontal overflow at ${width}px`)
        .toBeLessThanOrEqual(page!.clientWidth + 1);
      expect(tableScroller?.classList.contains('table-scroll'))
        .withContext('The wide financial history must own its horizontal scroll')
        .toBeTrue();
      expect(tableScroller!.clientWidth)
        .withContext(`The table scroller must remain inside the page at ${width}px`)
        .toBeLessThanOrEqual(page!.clientWidth + 1);
    });
  }

  it('uses compact navigation labels and touch-sized controls on narrow screens', () => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = 'block';
    host.style.width = '360px';
    host.style.maxWidth = '360px';
    fixture.detectChanges();

    const fullLabel = host.querySelector<HTMLElement>('.section-nav .nav-label--full');
    const shortLabel = host.querySelector<HTMLElement>('.section-nav .nav-label--short');
    const buttons = Array.from(host.querySelectorAll<HTMLElement>('.section-nav button'));

    expect(getComputedStyle(fullLabel!).display).toBe('none');
    expect(getComputedStyle(shortLabel!).display).not.toBe('none');
    expect(buttons.every((button) => button.getBoundingClientRect().height >= 44)).toBeTrue();
  });
});
