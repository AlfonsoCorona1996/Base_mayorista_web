import { ComponentFixture, TestBed, fakeAsync, tick } from "@angular/core/testing";
import { AddItemProductExperienceComponent } from "./add-item-product-experience.component";

describe("AddItemProductExperienceComponent", () => {
  let fixture: ComponentFixture<AddItemProductExperienceComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddItemProductExperienceComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AddItemProductExperienceComponent);
    fixture.detectChanges();
  });

  it("moves from search results to a selected product", fakeAsync(() => {
    fixture.componentInstance.onSearch("sandalia");
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const firstResult = element.querySelector<HTMLButtonElement>(".experience__results li button");

    firstResult?.click();
    tick();
    fixture.detectChanges();

    expect(element.querySelector("app-add-item-product-selection")).not.toBeNull();
    expect(fixture.componentInstance.selectedProduct()?.title).toBe("Sandalia Winnie Pooh");
    expect(element.querySelectorAll(".selection__option-fields select").length).toBe(2);
  }));

  it("groups search results by product instead of listing every combination", () => {
    fixture.componentInstance.onSearch("sandalia");
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const resultButtons = element.querySelectorAll<HTMLButtonElement>(".experience__results li button");

    expect(resultButtons.length).toBe(3);
    expect(resultButtons[0].textContent).toContain("10 colores · 4 variantes · 40 combinaciones");
    expect(resultButtons[0].textContent).not.toContain("Talla 25");
  });

  it("keeps search controls and results inside a 360px container", () => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = "block";
    host.style.width = "360px";
    fixture.componentInstance.onSearch("sandalia");
    fixture.detectChanges();
    const experience = host.querySelector<HTMLElement>(".experience");

    expect(experience).not.toBeNull();
    expect(experience!.scrollWidth).toBeLessThanOrEqual(experience!.clientWidth);
  });

  it("keeps both footer actions full width in a 360px card", fakeAsync(() => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = "block";
    host.style.width = "360px";
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.detectChanges();
    const cancelButton = host.querySelector<HTMLElement>(".experience__cancel");
    const primaryButton = host.querySelector<HTMLElement>(".experience__primary");

    expect(cancelButton).not.toBeNull();
    expect(primaryButton).not.toBeNull();
    expect(Math.abs(cancelButton!.getBoundingClientRect().width - primaryButton!.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    expect(primaryButton!.getBoundingClientRect().width).toBeGreaterThan(300);
  }));

  it("does not offer provisional catalog options for inventory products", fakeAsync(() => {
    fixture.componentInstance.setSource("inventario");
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector(".selection__source")?.textContent).toContain("Inventario");
    expect(element.querySelector(".selection__missing")).toBeNull();
    expect(element.querySelector(".selection__option-picker")).not.toBeNull();
  }));

  it("applies a new discount to the clienta price", fakeAsync(() => {
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.componentInstance.openDiscountEditor();
    fixture.componentInstance.discountMode.set("pct");
    fixture.componentInstance.discountPercent.set(30);
    fixture.componentInstance.applyClientaDiscount();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(fixture.componentInstance.clientaPrice()).toBe(70);
    expect(element.querySelector(".experience__price-field--clienta")?.textContent).toContain("30% de descuento");
    expect(element.querySelector("app-clienta-discount-panel")).toBeNull();
  }));

  it("uses touch-friendly quantity controls", fakeAsync(() => {
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const increaseButton = element.querySelector<HTMLButtonElement>('[aria-label="Aumentar cantidad"]');
    const decreaseButton = element.querySelector<HTMLButtonElement>('[aria-label="Disminuir cantidad"]');

    increaseButton?.click();
    fixture.detectChanges();
    decreaseButton?.click();
    fixture.detectChanges();
    decreaseButton?.click();

    expect(fixture.componentInstance.quantity()).toBe(1);
  }));

  it("blocks adding the product while a provisional option is unconfirmed", fakeAsync(() => {
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const provisionalButton = element.querySelector<HTMLButtonElement>(".selection__missing-action");

    provisionalButton?.click();
    fixture.detectChanges();
    const addButton = element.querySelector<HTMLButtonElement>(".experience__primary");

    expect(fixture.componentInstance.provisionalEditorOpen()).toBeTrue();
    expect(addButton?.disabled).toBeTrue();
    expect(addButton?.getAttribute("aria-describedby")).toBe("add-product-demo-pending-option");
    expect(element.querySelector(".experience__pending-option")?.textContent).toContain("Confirma o cancela");

    addButton?.click();
    expect(fixture.componentInstance.state()).toBe("selected");

    element.querySelector<HTMLButtonElement>(".option-editor__button")?.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.provisionalEditorOpen()).toBeFalse();
    expect(addButton?.disabled).toBeFalse();
  }));

  it("opens the discount editor as a blocking dialog without changing the price layout", fakeAsync(() => {
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const purchase = element.querySelector<HTMLElement>(".experience__purchase");
    const purchaseHeight = purchase?.getBoundingClientRect().height;
    element.querySelector<HTMLButtonElement>(".experience__discount-button")?.click();
    tick();
    fixture.detectChanges();
    const layer = element.querySelector<HTMLElement>(".experience__discount-layer");
    const editor = element.querySelector<HTMLElement>(".experience__discount-dialog");
    const body = element.querySelector<HTMLElement>(".experience__body");

    expect(layer).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(layer?.parentElement?.classList).toContain("experience");
    expect(editor?.getAttribute("role")).toBe("dialog");
    expect(editor?.getAttribute("aria-modal")).toBe("true");
    expect(body?.hasAttribute("inert")).toBeTrue();
    expect(purchase?.getBoundingClientRect().height).toBe(purchaseHeight);
    expect(element.querySelector(".experience__discount-button")?.getAttribute("aria-expanded")).toBe("true");

    editor?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fixture.detectChanges();
    tick();

    expect(element.querySelector(".experience__discount-layer")).toBeNull();
    expect(document.activeElement).toBe(element.querySelector(".experience__discount-button"));
  }));

  it("keeps the clienta price legible without changing the medium-width layout", fakeAsync(() => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = "block";
    host.style.width = "620px";
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.detectChanges();
    const quantity = host.querySelector<HTMLElement>(".experience__quantity");
    const prices = host.querySelector<HTMLElement>(".experience__prices");
    const clientaInput = host.querySelector<HTMLInputElement>(".experience__money-control--clienta input");
    const discountButton = host.querySelector<HTMLElement>(".experience__discount-button");
    const discountLabel = host.querySelector<HTMLElement>(".experience__discount-button-label");

    expect(Math.abs(prices!.getBoundingClientRect().top - quantity!.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
    expect(clientaInput!.getBoundingClientRect().width).toBeGreaterThan(36);
    expect(discountButton!.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(discountLabel!).display).toBe("none");
    expect(host.querySelector(".experience__money-control--clienta > span")?.textContent).toBe("$");
  }));

  it("shows progress and confirms a successful continuous capture", fakeAsync(() => {
    fixture.componentInstance.selectProduct(fixture.componentInstance.results[0]);
    tick();
    fixture.componentInstance.submit();
    fixture.detectChanges();

    expect(fixture.componentInstance.state()).toBe("saving");

    tick(900);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.state()).toBe("success");
    expect(element.querySelector(".experience__message--success")?.textContent).toContain("Producto añadido");
  }));
});
