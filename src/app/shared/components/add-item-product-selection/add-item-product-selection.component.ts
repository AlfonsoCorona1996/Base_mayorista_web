import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  input,
  output,
  signal,
} from "@angular/core";

export interface ProductSelectionImage {
  id: string;
  url: string;
  label: string;
  color?: string | null;
}

type ProductImageFilter = "all" | "color" | "unassigned";

export interface ProvisionalProductOption {
  variant: string;
  color: string;
  imageId: string | null;
  imageUrl: string;
  uploadedFileName: string | null;
  uploadedFile?: File | null;
}

export interface CatalogProductOption {
  variant: string;
  color: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-add-item-product-selection",
  templateUrl: "./add-item-product-selection.component.html",
  styleUrl: "./add-item-product-selection.component.css",
})
export class AddItemProductSelectionComponent implements OnDestroy {
  private static readonly MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
  private static readonly ALLOWED_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

  @ViewChild("variantSelect") private variantSelect?: ElementRef<HTMLSelectElement>;
  @ViewChild("editorOpenButton") private editorOpenButton?: ElementRef<HTMLButtonElement>;
  @ViewChild("draftVariantInput") private draftVariantInput?: ElementRef<HTMLInputElement>;
  @ViewChild("imageGalleryDialog") private imageGalleryDialog?: ElementRef<HTMLElement>;
  @ViewChild("imageLightboxDialog") private imageLightboxDialog?: ElementRef<HTMLElement>;

  readonly panelId = input("add-item-product-selection");
  readonly productTitle = input.required<string>();
  readonly productCode = input<string | null>(null);
  readonly sourceLabel = input("Catálogo");
  readonly variant = input("");
  readonly color = input("");
  readonly images = input<readonly ProductSelectionImage[]>([]);
  readonly availableVariants = input<readonly string[]>([]);
  readonly availableColors = input<readonly string[]>([]);
  readonly currentImageId = input<string | null>(null);
  readonly provisionalOption = input<ProvisionalProductOption | null>(null);
  readonly allowProvisionalOption = input(true);
  readonly editorInitiallyOpen = input(false);
  readonly galleryInitiallyOpen = input(false);
  readonly saving = input(false);
  readonly allowChangeProduct = input(true);
  readonly combinationCount = input<number | null>(null);

  readonly changeProduct = output<void>();
  readonly catalogOptionChange = output<CatalogProductOption>();
  readonly provisionalOptionApply = output<ProvisionalProductOption>();
  readonly provisionalOptionClear = output<void>();
  readonly provisionalEditorOpenChange = output<boolean>();

  readonly editorOpen = signal(false);
  readonly draftVariant = signal("");
  readonly draftColor = signal("");
  readonly selectedImageId = signal<string | null>(null);
  readonly uploadedImageUrl = signal<string | null>(null);
  readonly uploadedFileName = signal<string | null>(null);
  readonly uploadedFile = signal<File | null>(null);
  readonly uploadError = signal<string | null>(null);
  readonly internalOption = signal<ProvisionalProductOption | null>(null);
  readonly imagePreviewUrl = signal<string | null>(null);
  readonly imageGalleryOpen = signal(false);
  readonly imageGalleryFilter = signal<ProductImageFilter>("all");
  readonly gallerySelectedImageId = signal<string | null>(null);
  readonly liveMessage = signal<string | null>(null);

  private initialized = false;
  private imagePreviewTrigger: HTMLElement | null = null;
  private imageGalleryTrigger: HTMLElement | null = null;

  constructor() {
    effect(() => this.internalOption.set(this.provisionalOption()));
    afterNextRender(() => this.initializeIfNeeded());
  }

  readonly activeOption = computed(() => this.internalOption() || this.provisionalOption());
  readonly availableCombinationCount = computed(() => (
    this.combinationCount() ?? this.availableVariants().length * this.availableColors().length
  ));
  readonly displayVariant = computed(() => this.activeOption()?.variant || this.variant() || "Sin variante");
  readonly displayColor = computed(() => this.activeOption()?.color || this.color() || "Sin color");
  readonly displayImageUrl = computed(() => {
    if (this.editorOpen()) {
      if (this.selectedImageId() === "uploaded" && this.uploadedImageUrl()) return this.uploadedImageUrl();
      const draftImage = this.images().find((image) => image.id === this.selectedImageId());
      if (draftImage) return draftImage.url;
    }
    const optionImage = this.activeOption()?.imageUrl;
    if (optionImage) return optionImage;
    const preferredId = this.currentImageId();
    return this.images().find((image) => image.id === preferredId)?.url || this.images()[0]?.url || null;
  });
  readonly selectedDraftImageUrl = computed(() => {
    if (this.selectedImageId() === "uploaded") return this.uploadedImageUrl();
    return this.images().find((image) => image.id === this.selectedImageId())?.url || null;
  });
  readonly imagesForSelectedColor = computed(() => {
    const selectedColor = this.normalizeLabel(this.draftColor());
    if (!selectedColor) return [];
    return this.images().filter((image) => this.normalizeLabel(image.color || "") === selectedColor);
  });
  readonly unassignedImages = computed(() => this.images().filter((image) => !image.color?.trim()));
  readonly inlineImages = computed(() => {
    const selectedImage = this.images().find((image) => image.id === this.selectedImageId());
    const candidates = selectedImage
      ? [selectedImage, ...this.imagesForSelectedColor()]
      : this.imagesForSelectedColor();
    const uniqueImages = candidates.filter((image, index, collection) => (
      collection.findIndex((candidate) => candidate.id === image.id) === index
    ));
    return uniqueImages.slice(0, 3);
  });
  readonly filteredGalleryImages = computed(() => {
    if (this.imageGalleryFilter() === "color") return this.imagesForSelectedColor();
    if (this.imageGalleryFilter() === "unassigned") return this.unassignedImages();
    return this.images();
  });
  readonly canConfirmGalleryImage = computed(() => (
    this.images().some((image) => image.id === this.gallerySelectedImageId())
  ));
  readonly editorTitleId = computed(() => `${this.panelId()}-editor-title`);
  readonly variantListId = computed(() => `${this.panelId()}-variants`);
  readonly colorListId = computed(() => `${this.panelId()}-colors`);
  readonly canApplyDraft = computed(() => (
    (this.draftVariant().trim().length > 0 || this.draftColor().trim().length > 0)
    && !!this.selectedDraftImageUrl()
    && !this.saving()
  ));

  initializeIfNeeded(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (this.editorInitiallyOpen() || this.galleryInitiallyOpen()) this.openEditor();
    if (this.galleryInitiallyOpen()) this.openImageGallery();
  }

  openEditor(): void {
    if (!this.allowProvisionalOption()) return;
    this.initializeDraft();
    this.editorOpen.set(true);
    this.provisionalEditorOpenChange.emit(true);
    this.liveMessage.set(null);
    setTimeout(() => this.draftVariantInput?.nativeElement.focus(), 0);
  }

  closeEditor(): void {
    this.restoreAppliedDraft();
    this.editorOpen.set(false);
    this.provisionalEditorOpenChange.emit(false);
    this.focusEditorTrigger();
  }

  selectExistingImage(imageId: string): void {
    this.selectedImageId.set(imageId);
  }

  openImageGallery(event?: Event): void {
    if (!this.allowProvisionalOption()) return;
    this.imageGalleryTrigger = event?.currentTarget as HTMLElement | null;
    this.gallerySelectedImageId.set(this.selectedImageId());
    this.imageGalleryFilter.set(this.imagesForSelectedColor().length > 0 ? "color" : "all");
    this.imageGalleryOpen.set(true);
    setTimeout(() => this.imageGalleryDialog?.nativeElement.querySelector<HTMLButtonElement>("button")?.focus(), 0);
  }

  closeImageGallery(): void {
    if (!this.imageGalleryOpen()) return;
    this.imageGalleryOpen.set(false);
    queueMicrotask(() => this.imageGalleryTrigger?.focus());
  }

  setImageGalleryFilter(filter: ProductImageFilter): void {
    this.imageGalleryFilter.set(filter);
  }

  selectGalleryImage(imageId: string): void {
    this.gallerySelectedImageId.set(imageId);
  }

  confirmGalleryImage(): void {
    const imageId = this.gallerySelectedImageId();
    if (!imageId) return;
    this.selectExistingImage(imageId);
    this.closeImageGallery();
    this.liveMessage.set("Imagen guardada seleccionada para esta opción.");
  }

  chooseCatalogVariant(variant: string): void {
    this.catalogOptionChange.emit({ variant, color: this.color() });
    this.liveMessage.set(`Talla o variante ${variant} seleccionada.`);
  }

  chooseCatalogColor(color: string): void {
    this.catalogOptionChange.emit({ variant: this.variant(), color });
    this.liveMessage.set(`Color ${color} seleccionado.`);
  }

  useCatalogOption(): void {
    this.disposeUploadedUrl(this.activeOption()?.imageUrl || null);
    this.disposeUploadedUrl(this.uploadedImageUrl());
    this.clearUploadedDraft();
    this.internalOption.set(null);
    this.liveMessage.set("Elige una talla y un color disponibles en catálogo.");
    this.provisionalOptionClear.emit();
    queueMicrotask(() => this.focusOptionPicker());
  }

  focusOptionPicker(): void {
    this.variantSelect?.nativeElement.focus();
  }

  onFileSelected(event: Event): void {
    const inputElement = event.target as HTMLInputElement | null;
    const file = inputElement?.files?.[0];
    if (!file) return;
    this.uploadError.set(null);
    if (!AddItemProductSelectionComponent.ALLOWED_UPLOAD_TYPES.has(file.type)) {
      this.uploadError.set("Usa una imagen JPG, PNG o WebP.");
      if (inputElement) inputElement.value = "";
      return;
    }
    if (file.size > AddItemProductSelectionComponent.MAX_UPLOAD_BYTES) {
      this.uploadError.set("La imagen debe pesar máximo 8 MB.");
      if (inputElement) inputElement.value = "";
      return;
    }
    this.disposeUploadedUrl(this.uploadedImageUrl(), this.activeOption()?.imageUrl || null);
    this.clearUploadedDraft();
    this.uploadedImageUrl.set(URL.createObjectURL(file));
    this.uploadedFileName.set(file.name);
    this.uploadedFile.set(file);
    this.selectedImageId.set("uploaded");
  }

  applyDraft(): void {
    const imageUrl = this.selectedDraftImageUrl();
    if (!this.canApplyDraft() || !imageUrl) return;
    const option: ProvisionalProductOption = {
      variant: this.draftVariant().trim(),
      color: this.draftColor().trim(),
      imageId: this.selectedImageId() === "uploaded" ? null : this.selectedImageId(),
      imageUrl,
      uploadedFileName: this.selectedImageId() === "uploaded" ? this.uploadedFileName() : null,
      uploadedFile: this.selectedImageId() === "uploaded" ? this.uploadedFile() : null,
    };
    const previousOption = this.activeOption();
    this.internalOption.set(option);
    if (previousOption?.imageUrl !== option.imageUrl) this.disposeUploadedUrl(previousOption?.imageUrl || null);
    this.editorOpen.set(false);
    this.provisionalEditorOpenChange.emit(false);
    this.liveMessage.set(`Opción provisional lista: ${option.variant}, ${option.color}.`);
    this.provisionalOptionApply.emit(option);
    this.focusEditorTrigger();
  }

  openImagePreview(url: string, event: Event): void {
    this.imagePreviewTrigger = event.currentTarget as HTMLElement | null;
    this.imagePreviewUrl.set(url);
    setTimeout(() => this.imageLightboxDialog?.nativeElement.querySelector<HTMLButtonElement>("button")?.focus(), 0);
  }

  closeImagePreview(): void {
    if (!this.imagePreviewUrl()) return;
    this.imagePreviewUrl.set(null);
    queueMicrotask(() => this.imagePreviewTrigger?.focus());
  }

  onGalleryKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeImageGallery();
      return;
    }
    this.trapDialogFocus(event, this.imageGalleryDialog?.nativeElement || null);
  }

  onLightboxKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeImagePreview();
      return;
    }
    this.trapDialogFocus(event, this.imageLightboxDialog?.nativeElement || null);
  }

  @HostListener("document:keydown.escape")
  onEscape(): void {
    if (this.imagePreviewUrl()) {
      this.closeImagePreview();
      return;
    }
    if (this.imageGalleryOpen()) this.closeImageGallery();
  }

  ngOnDestroy(): void {
    const urls = new Set([
      this.uploadedImageUrl(),
      this.internalOption()?.imageUrl || null,
      this.provisionalOption()?.imageUrl || null,
    ]);
    for (const url of urls) this.disposeUploadedUrl(url);
  }

  private initializeDraft(): void {
    this.restoreAppliedDraft();
    this.draftVariant.set(this.displayVariant() === "Sin variante" ? "" : this.displayVariant());
    this.draftColor.set(this.displayColor() === "Sin color" ? "" : this.displayColor());
    const option = this.activeOption();
    if (option?.uploadedFileName) {
      this.selectedImageId.set("uploaded");
      this.uploadedImageUrl.set(option.imageUrl);
      this.uploadedFileName.set(option.uploadedFileName);
      this.uploadedFile.set(option.uploadedFile || null);
      return;
    }
    const preferredId = option?.imageId || this.currentImageId() || this.images()[0]?.id || null;
    this.selectedImageId.set(preferredId);
  }

  private restoreAppliedDraft(): void {
    const option = this.activeOption();
    this.disposeUploadedUrl(this.uploadedImageUrl(), option?.imageUrl || null);
    this.clearUploadedDraft();
    this.uploadError.set(null);
    if (option?.uploadedFileName) {
      this.uploadedImageUrl.set(option.imageUrl);
      this.uploadedFileName.set(option.uploadedFileName);
      this.uploadedFile.set(option.uploadedFile || null);
      this.selectedImageId.set("uploaded");
      return;
    }
    this.selectedImageId.set(option?.imageId || this.currentImageId() || this.images()[0]?.id || null);
  }

  private clearUploadedDraft(): void {
    this.uploadedImageUrl.set(null);
    this.uploadedFileName.set(null);
    this.uploadedFile.set(null);
  }

  private disposeUploadedUrl(url: string | null, preservedUrl: string | null = null): void {
    if (url && url !== preservedUrl && url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  private focusEditorTrigger(): void {
    setTimeout(() => this.editorOpenButton?.nativeElement.focus(), 0);
  }

  private trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
    if (event.key !== "Tab" || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private normalizeLabel(value: string): string {
    return value.trim().toLocaleLowerCase("es-MX");
  }
}
