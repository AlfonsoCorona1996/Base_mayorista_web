import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, afterNextRender, computed, input, signal } from "@angular/core";
import {
  ClientaDiscountMode,
  ClientaDiscountPanelComponent,
} from "../clienta-discount-panel/clienta-discount-panel.component";
import {
  AddItemProductSelectionComponent,
  CatalogProductOption,
  ProductSelectionImage,
  ProvisionalProductOption,
} from "./add-item-product-selection.component";

export type AddItemExperienceState = "search" | "loading" | "results" | "selected" | "duplicate" | "saving" | "error" | "success" | "empty";
export type AddItemProductSource = "catalogo" | "inventario" | "manual";

interface ProductResult {
  id: string;
  title: string;
  code: string;
  variant: string;
  color: string;
  price: string;
  imageId: string;
  availableVariants: readonly string[];
  availableColors: readonly string[];
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-add-item-product-experience",
  imports: [AddItemProductSelectionComponent, ClientaDiscountPanelComponent],
  templateUrl: "./add-item-product-experience.component.html",
  styleUrl: "./add-item-product-experience.component.css",
})
export class AddItemProductExperienceComponent {
  readonly initialState = input<AddItemExperienceState>("search");
  readonly initialSource = input<AddItemProductSource>("catalogo");
  readonly focusOnLoad = input(true);
  readonly optionEditorInitiallyOpen = input(false);
  readonly imageGalleryInitiallyOpen = input(false);
  readonly discountInitiallyOpen = input(false);
  readonly longProductTitle = input(false);
  readonly productImages = input<readonly ProductSelectionImage[]>([]);

  @ViewChild("searchInput") private searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild("quantityInput") private quantityInput?: ElementRef<HTMLInputElement>;
  @ViewChild("discountButton") private discountButton?: ElementRef<HTMLButtonElement>;
  @ViewChild("discountEditor") private discountEditor?: ElementRef<HTMLElement>;
  @ViewChild(AddItemProductSelectionComponent) private productSelection?: AddItemProductSelectionComponent;

  readonly source = signal<AddItemProductSource>("catalogo");
  readonly query = signal("");
  readonly state = signal<AddItemExperienceState>("search");
  readonly selectedProduct = signal<ProductResult | null>(null);
  readonly quantity = signal(1);
  readonly liveMessage = signal<string | null>(null);
  readonly provisionalOption = signal<ProvisionalProductOption | null>(null);
  readonly provisionalEditorOpen = signal(false);
  readonly finalPrice = signal(100);
  readonly clientaPrice = signal(75);
  readonly costPrice = signal(50);
  readonly discountEditorOpen = signal(false);
  readonly discountMode = signal<ClientaDiscountMode>("pct");
  readonly discountPercent = signal(25);
  readonly discountFixedAmount = signal(25);
  readonly discountSummary = signal("25% de descuento · Ahorras $25.00 MXN");

  readonly sourceLabel = computed(() => {
    if (this.source() === "inventario") return "Inventario";
    if (this.source() === "manual") return "Manual";
    return "Catálogo";
  });
  readonly discountPreviewText = computed(() => this.formatMxn(this.calculateDraftClientaPrice()));
  readonly discountApplyDisabled = computed(() => {
    if (this.discountMode() === "pct") return this.discountPercent() < 0 || this.discountPercent() > 100;
    return this.discountFixedAmount() < 0 || this.discountFixedAmount() > this.finalPrice();
  });

  private appliedDiscount: { mode: ClientaDiscountMode; percent: number; fixedAmount: number } = {
    mode: "pct",
    percent: 25,
    fixedAmount: 25,
  };

  readonly results: readonly ProductResult[] = [
    {
      id: "sandalia-winnie-pooh",
      title: "Sandalia Winnie Pooh",
      code: "BM-SWP",
      variant: "25",
      color: "Rosa",
      price: "Desde $100.00",
      imageId: "rosa",
      availableVariants: ["24", "25", "26", "27"],
      availableColors: ["Rosa", "Negro", "Azul cielo", "Verde menta", "Rojo", "Blanco", "Lila", "Amarillo", "Café", "Naranja"],
    },
    {
      id: "sandalia-winnie-classic",
      title: "Sandalia Winnie Classic",
      code: "BM-SWC",
      variant: "24",
      color: "Negro",
      price: "Desde $110.00",
      imageId: "negro",
      availableVariants: ["23", "24", "25", "26"],
      availableColors: ["Negro", "Blanco", "Rosa", "Rojo", "Azul cielo", "Beige"],
    },
    {
      id: "sandalia-winnie-baby",
      title: "Sandalia Winnie Baby",
      code: "BM-SWB",
      variant: "18",
      color: "Azul cielo",
      price: "Desde $85.00",
      imageId: "azul",
      availableVariants: ["18", "19", "20"],
      availableColors: ["Azul cielo", "Rosa", "Amarillo", "Blanco"],
    },
  ];

  private initialized = false;

  constructor() {
    afterNextRender(() => this.initialize());
  }

  setSource(source: AddItemProductSource): void {
    this.source.set(source);
    this.query.set("");
    this.selectedProduct.set(null);
    this.state.set("search");
    this.liveMessage.set(null);
    this.discountEditorOpen.set(false);
    this.provisionalEditorOpen.set(false);
    this.focusSearch();
  }

  onSearch(value: string): void {
    this.query.set(value);
    this.selectedProduct.set(null);
    this.liveMessage.set(null);
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 2) {
      this.state.set("search");
      return;
    }
    this.state.set(normalized.includes("sin resultado") ? "empty" : "results");
  }

  clearSearch(): void {
    this.query.set("");
    this.state.set("search");
    this.focusSearch();
  }

  selectProduct(product: ProductResult): void {
    this.selectedProduct.set(product);
    this.query.set("");
    this.state.set("selected");
    this.provisionalEditorOpen.set(false);
    this.liveMessage.set(`${product.title} seleccionado. Ahora elige talla y color.`);
    setTimeout(() => this.productSelection?.focusOptionPicker(), 0);
  }

  changeProduct(): void {
    this.selectedProduct.set(null);
    this.provisionalOption.set(null);
    this.discountEditorOpen.set(false);
    this.provisionalEditorOpen.set(false);
    this.quantity.set(1);
    this.state.set("search");
    this.liveMessage.set("Selección eliminada. Busca otro producto.");
    this.focusSearch();
  }

  startScanner(): void {
    this.liveMessage.set("Escáner listo. Acerca el código de barras.");
    this.focusSearch();
  }

  onProvisionalOptionApply(option: ProvisionalProductOption): void {
    if (this.source() !== "catalogo") return;
    this.provisionalOption.set(option);
    this.liveMessage.set(`Opción provisional ${option.variant}, ${option.color}, lista para agregar.`);
  }

  onProvisionalEditorOpenChange(open: boolean): void {
    this.provisionalEditorOpen.set(open);
    this.liveMessage.set(open
      ? "Confirma o cancela la nueva opción antes de añadir el producto."
      : null);
  }

  onCatalogOptionChange(option: CatalogProductOption): void {
    this.selectedProduct.update((product) => {
      if (!product) return product;
      return {
        ...product,
        variant: option.variant,
        color: option.color,
        imageId: this.imageIdForColor(option.color, product.imageId),
      };
    });
    this.provisionalOption.set(null);
    this.liveMessage.set(`Talla ${option.variant}, color ${option.color}, seleccionados.`);
  }

  clearProvisionalOption(): void {
    this.provisionalOption.set(null);
    this.liveMessage.set("Opción provisional eliminada. Elige una combinación disponible en catálogo.");
  }

  openDiscountEditor(): void {
    this.discountMode.set(this.appliedDiscount.mode);
    this.discountPercent.set(this.appliedDiscount.percent);
    this.discountFixedAmount.set(this.appliedDiscount.fixedAmount);
    this.discountEditorOpen.set(true);
    this.liveMessage.set("Editor de descuento de precio clienta abierto.");
    setTimeout(() => {
      const editor = this.discountEditor?.nativeElement;
      editor?.querySelector<HTMLButtonElement>("button")?.focus();
    }, 0);
  }

  closeDiscountEditor(): void {
    this.discountEditorOpen.set(false);
    this.liveMessage.set("Cambio de descuento cancelado.");
    setTimeout(() => this.discountButton?.nativeElement.focus(), 0);
  }

  applyClientaDiscount(): void {
    if (this.discountApplyDisabled()) return;
    const mode = this.discountMode();
    const percent = this.discountPercent();
    const fixedAmount = this.discountFixedAmount();
    const price = this.calculateDraftClientaPrice();
    this.appliedDiscount = { mode, percent, fixedAmount };
    this.clientaPrice.set(price);
    this.discountSummary.set(
      mode === "pct"
        ? `${percent}% de descuento · Ahorras ${this.formatMxn(this.finalPrice() - price)}`
        : `${this.formatMxn(fixedAmount)} de descuento fijo`,
    );
    this.discountEditorOpen.set(false);
    this.liveMessage.set(`Precio clienta actualizado a ${this.formatMxn(price)}.`);
    setTimeout(() => this.discountButton?.nativeElement.focus(), 0);
  }

  decreaseQuantity(): void {
    this.quantity.update((quantity) => Math.max(1, quantity - 1));
  }

  increaseQuantity(): void {
    this.quantity.update((quantity) => quantity + 1);
  }

  setQuantity(value: number): void {
    this.quantity.set(Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1);
  }

  setFinalPrice(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.finalPrice.set(value);
  }

  setClientaPrice(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.clientaPrice.set(value);
    const savings = Math.max(0, this.finalPrice() - value);
    this.discountSummary.set(savings > 0 ? `Precio manual · Ahorras ${this.formatMxn(savings)}` : "Precio definido manualmente");
  }

  onDiscountDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeDiscountEditor();
      return;
    }

    if (event.key !== "Tab") return;
    const dialog = this.discountEditor?.nativeElement;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));
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

  submit(): void {
    if (!this.selectedProduct()) {
      this.state.set("error");
      this.liveMessage.set("Selecciona un producto antes de continuar.");
      this.focusSearch();
      return;
    }
    this.state.set("saving");
    this.liveMessage.set("Añadiendo producto al pedido.");
    setTimeout(() => {
      const productTitle = this.selectedProduct()?.title || "Producto";
      this.selectedProduct.set(null);
      this.provisionalOption.set(null);
      this.discountEditorOpen.set(false);
      this.provisionalEditorOpen.set(false);
      this.quantity.set(1);
      this.state.set("success");
      this.liveMessage.set(`${productTitle} añadido. Puedes agregar otro producto.`);
      this.focusSearch();
    }, 900);
  }

  retry(): void {
    if (this.selectedProduct()) {
      this.state.set("selected");
      this.liveMessage.set(null);
      return;
    }
    this.state.set("search");
    this.focusSearch();
  }

  isSaving(): boolean {
    return this.state() === "saving";
  }

  primaryDisabled(): boolean {
    return !this.selectedProduct() || this.isSaving() || this.provisionalEditorOpen();
  }

  resultImage(result: ProductResult): ProductSelectionImage | null {
    return this.productImages().find((image) => image.id === result.imageId) || null;
  }

  combinationCount(result: ProductResult): number {
    return result.availableVariants.length * result.availableColors.length;
  }

  formatMxn(value: number): string {
    return `$${value.toFixed(2)} MXN`;
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.source.set(this.initialSource());
    const state = this.initialState();
    this.state.set(state);
    if (["selected", "duplicate", "saving", "error"].includes(state)) {
      this.selectedProduct.set(this.results[0]);
    }
    if (["loading", "results", "empty"].includes(state)) {
      this.query.set(state === "empty" ? "sin resultado" : "sandalia");
    }
    if (state === "success") {
      this.liveMessage.set("Sandalia Winnie Pooh añadida. Puedes agregar otro producto.");
    }
    if (this.discountInitiallyOpen() && this.selectedProduct()) {
      this.openDiscountEditor();
    }
    if (this.focusOnLoad() && ["search", "loading", "results", "empty", "success"].includes(state)) {
      this.focusSearch();
    }
  }

  private focusSearch(): void {
    setTimeout(() => this.searchInput?.nativeElement.focus(), 0);
  }

  private imageIdForColor(color: string, fallbackImageId: string): string {
    const normalizedColor = color.toLowerCase();
    if (normalizedColor.includes("rosa")) return "rosa";
    if (normalizedColor.includes("negro")) return "negro";
    if (normalizedColor.includes("azul")) return "azul";
    return fallbackImageId;
  }

  private calculateDraftClientaPrice(): number {
    const finalPrice = this.finalPrice();
    const discount = this.discountMode() === "pct"
      ? finalPrice * (this.discountPercent() / 100)
      : this.discountFixedAmount();
    return Math.max(0, finalPrice - discount);
  }
}
