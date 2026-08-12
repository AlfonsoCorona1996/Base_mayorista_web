import { ComponentFixture, TestBed, fakeAsync, tick } from "@angular/core/testing";
import {
  AddItemProductSelectionComponent,
  ProductSelectionImage,
  ProvisionalProductOption,
} from "./add-item-product-selection.component";

describe("AddItemProductSelectionComponent", () => {
  let fixture: ComponentFixture<AddItemProductSelectionComponent>;
  const images: readonly ProductSelectionImage[] = [
    { id: "rosa", label: "Rosa", color: "Rosa", url: "data:image/svg+xml,rosa" },
    { id: "negro", label: "Negro", color: "Negro", url: "data:image/svg+xml,negro" },
    { id: "detalle", label: "Detalle", color: null, url: "data:image/svg+xml,detalle" },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddItemProductSelectionComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AddItemProductSelectionComponent);
    fixture.componentRef.setInput("productTitle", "Sandalia Winnie Pooh");
    fixture.componentRef.setInput("variant", "25");
    fixture.componentRef.setInput("color", "Rosa");
    fixture.componentRef.setInput("images", images);
    fixture.componentRef.setInput("currentImageId", "rosa");
    fixture.componentRef.setInput("availableVariants", ["24", "25", "26", "27"]);
    fixture.componentRef.setInput("availableColors", ["Rosa", "Negro"]);
    fixture.detectChanges();
  });

  it("opens an inline editor for a missing option", () => {
    const element = fixture.nativeElement as HTMLElement;
    const action = element.querySelector<HTMLButtonElement>(".selection__missing-action");

    action?.click();
    fixture.detectChanges();

    expect(element.querySelector(".option-editor")).not.toBeNull();
    expect(element.querySelector(".selection__option-picker")).toBeNull();
    expect(element.querySelector(".selection__missing")).toBeNull();
    expect(element.querySelector(".option-editor h4")?.textContent).toContain("Agregar talla o color");
    expect(element.textContent).not.toContain("Nueva opción provisional");
  });

  it("moves focus into the provisional editor and returns it on cancel", fakeAsync(() => {
    const element = fixture.nativeElement as HTMLElement;
    const action = element.querySelector<HTMLButtonElement>(".selection__missing-action")!;

    action.click();
    fixture.detectChanges();
    tick();
    expect(document.activeElement).toBe(element.querySelector(".option-editor__fields input"));

    element.querySelector<HTMLButtonElement>(".option-editor__close")?.click();
    fixture.detectChanges();
    tick();
    expect(document.activeElement).toBe(element.querySelector(".selection__missing-action"));
  }));

  it("restores the catalog option picker after cancelling the alternate flow", () => {
    fixture.componentInstance.openEditor();
    fixture.detectChanges();
    fixture.componentInstance.closeEditor();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector(".selection__option-picker")).not.toBeNull();
    expect(element.querySelector(".selection__missing")).not.toBeNull();
    expect(element.querySelector(".option-editor")).toBeNull();
  });

  it("reports whether the provisional editor has an unconfirmed option", () => {
    const states: boolean[] = [];
    fixture.componentInstance.provisionalEditorOpenChange.subscribe((open) => states.push(open));

    fixture.componentInstance.openEditor();
    fixture.componentInstance.closeEditor();

    expect(states).toEqual([true, false]);
  });

  it("hides and blocks the provisional option flow when it is not allowed", () => {
    fixture.componentRef.setInput("allowProvisionalOption", false);
    fixture.detectChanges();
    fixture.componentInstance.openEditor();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector(".selection__missing")).toBeNull();
    expect(element.querySelector(".option-editor")).toBeNull();
    expect(element.querySelector(".selection__option-picker")).not.toBeNull();
  });

  it("selects an existing catalog combination inside the product card", () => {
    const emittedVariants: string[] = [];
    fixture.componentInstance.catalogOptionChange.subscribe((option) => emittedVariants.push(option.variant));
    const element = fixture.nativeElement as HTMLElement;
    const selects = element.querySelectorAll<HTMLSelectElement>(".selection__option-fields select");

    selects[0].value = "27";
    selects[0].dispatchEvent(new Event("change"));
    fixture.detectChanges();

    expect(selects.length).toBe(2);
    expect(emittedVariants).toEqual(["27"]);
    expect(element.querySelector(".selection__option-picker")?.textContent).toContain("8 combinaciones disponibles");
  });

  it("emits a provisional option and updates the selected card", () => {
    const emittedOptions: ProvisionalProductOption[] = [];
    fixture.componentInstance.provisionalOptionApply.subscribe((option) => {
      emittedOptions.push(option);
    });
    fixture.componentInstance.openEditor();
    fixture.componentInstance.draftVariant.set("26");
    fixture.componentInstance.draftColor.set("Verde menta");
    fixture.componentInstance.selectExistingImage("rosa");
    fixture.detectChanges();

    fixture.componentInstance.applyDraft();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(emittedOptions.map((option) => option.variant)).toEqual(["26"]);
    expect(element.querySelector(".selection__provisional-badge")).not.toBeNull();
    expect(element.textContent).toContain("Verde menta");
  });

  it("previews the draft image in the selected product card and restores it on cancel", () => {
    fixture.componentInstance.openEditor();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const productImage = element.querySelector<HTMLImageElement>(".selection__image-button img");

    fixture.componentInstance.selectExistingImage("negro");
    fixture.detectChanges();

    expect(productImage?.src).toContain("negro");
    expect(element.querySelector(".selection__preview-badge")?.textContent).toContain("Vista previa");

    fixture.componentInstance.closeEditor();
    fixture.detectChanges();

    expect(productImage?.src).toContain("rosa");
    expect(element.querySelector(".selection__preview-badge")).toBeNull();
  });

  it("opens and closes an accessible image preview", () => {
    const element = fixture.nativeElement as HTMLElement;
    const imageButton = element.querySelector<HTMLButtonElement>(".selection__image-button");
    imageButton?.click();
    fixture.detectChanges();

    expect(element.querySelector('[role="dialog"][aria-label="Vista ampliada del producto"]')).not.toBeNull();

    fixture.componentInstance.closeImagePreview();
    fixture.detectChanges();
    expect(element.querySelector(".selection-lightbox")).toBeNull();
  });

  it("opens a filterable gallery that includes unassigned images", () => {
    fixture.componentInstance.openEditor();
    fixture.componentInstance.openImageGallery();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('[role="dialog"] .selection-gallery__grid')).not.toBeNull();
    fixture.componentInstance.setImageGalleryFilter("unassigned");
    fixture.detectChanges();

    const galleryImages = element.querySelectorAll(".selection-gallery__image");
    expect(galleryImages.length).toBe(1);
    expect(galleryImages[0].textContent).toContain("Sin asignar");
  });

  it("enlarges images from both the inline grid and the full gallery", () => {
    fixture.componentInstance.openEditor();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>(".option-editor__image-preview")?.click();
    fixture.detectChanges();
    expect(element.querySelector(".selection-lightbox")).not.toBeNull();

    fixture.componentInstance.closeImagePreview();
    fixture.componentInstance.openImageGallery();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>(".selection-gallery__preview")?.click();
    fixture.detectChanges();
    expect(element.querySelector(".selection-lightbox")).not.toBeNull();
  });

  it("keeps the alternate form inside a 360px container", () => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = "block";
    host.style.width = "360px";
    fixture.componentInstance.openEditor();
    fixture.detectChanges();
    const selection = host.querySelector<HTMLElement>(".selection");

    expect(selection).not.toBeNull();
    expect(selection!.scrollWidth).toBeLessThanOrEqual(selection!.clientWidth);
  });

  it("rejects unsupported image files with an accessible error", () => {
    fixture.componentInstance.openEditor();
    const file = new File(["not-an-image"], "catalogo.gif", { type: "image/gif" });

    fixture.componentInstance.onFileSelected({ target: { files: [file], value: "catalogo.gif" } } as unknown as Event);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.uploadedFile()).toBeNull();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("JPG, PNG o WebP");
  });

  it("keeps an applied upload when an edit is cancelled", () => {
    spyOn(URL, "createObjectURL").and.returnValue("blob:catalog-option");
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    const file = new File(["image"], "verde.webp", { type: "image/webp" });
    fixture.componentInstance.openEditor();
    fixture.componentInstance.onFileSelected({ target: { files: [file], value: "verde.webp" } } as unknown as Event);
    fixture.componentInstance.draftVariant.set("26");
    fixture.componentInstance.draftColor.set("Verde menta");
    fixture.componentInstance.applyDraft();

    fixture.componentInstance.openEditor();
    fixture.componentInstance.closeEditor();

    expect(fixture.componentInstance.activeOption()?.uploadedFile).toBe(file);
    expect(fixture.componentInstance.displayImageUrl()).toBe("blob:catalog-option");
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:catalog-option");
  });
});
