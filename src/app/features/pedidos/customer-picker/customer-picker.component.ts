import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";

export interface CustomerPickerOption {
  id: string;
  name: string;
  /** Dato secundario para distinguir homónimas (WhatsApp). */
  detail: string;
}

/** Mismo vocabulario que `PedidosPage.customerSearchState` (FIX 01). */
export type CustomerPickerState = "idle" | "loading" | "error" | "results" | "no-results";

/**
 * Teléfonos (vertical u horizontal): el buscador se abre en una hoja propia. En
 * escritorio y tablet se mantiene el autocomplete anclado al campo.
 */
export const CUSTOMER_PICKER_SHEET_QUERY = "(max-width: 767.98px), (pointer: coarse) and (max-height: 540px)";

/** Media query que activa la hoja. Las pruebas la sustituyen para fijar el modo. */
export const CUSTOMER_PICKER_SHEET_MEDIA = new InjectionToken<string>("CUSTOMER_PICKER_SHEET_MEDIA", {
  providedIn: "root",
  factory: () => CUSTOMER_PICKER_SHEET_QUERY,
});

let nextPickerId = 0;

/**
 * Buscador de clientas para crear un pedido.
 *
 * - Escritorio y tablet: combobox con listbox anclado. No se cierra por un blur
 *   sin destino (p. ej. al ocultar el teclado táctil); se cierra al seleccionar,
 *   con Escape, al pasar el foco a otro control o al tocar fuera.
 * - Teléfono: el campo abre una hoja de búsqueda que ocupa el área visible. Su
 *   alto sigue a `visualViewport` (el teclado no tapa el campo ni los resultados)
 *   y el documento queda fijo mientras está abierta para evitar saltos de scroll.
 *
 * Es presentacional: no consulta datos. La página decide las opciones, el estado
 * de carga y qué hacer al elegir.
 */
@Component({
  selector: "app-customer-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: "./customer-picker.component.html",
  styleUrl: "./customer-picker.component.css",
})
export class CustomerPickerComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly changeDetector = inject(ChangeDetectorRef);

  /** Texto buscado. La página filtra con él. */
  readonly query = model("");
  readonly options = input<CustomerPickerOption[]>([]);
  readonly state = input<CustomerPickerState>("idle");
  /** Nombre de la clienta elegida, o null si no hay selección válida. */
  readonly selectedName = input<string | null>(null);
  readonly placeholder = input("Busca por nombre o WhatsApp");

  readonly picked = output<string>();
  /** El texto del campo anclado cambió: la selección anterior deja de ser válida. */
  readonly selectionCleared = output<void>();
  readonly retry = output<void>();

  private readonly uid = ++nextPickerId;
  readonly listboxId = `customer-picker-listbox-${this.uid}`;
  readonly statusId = `customer-picker-status-${this.uid}`;
  readonly sheetTitleId = `customer-picker-title-${this.uid}`;

  /** true: patrón de hoja (teléfono). Se actualiza al rotar o redimensionar. */
  readonly sheetMode = signal(false);
  readonly listOpen = signal(false);
  readonly sheetOpen = signal(false);
  readonly activeIndex = signal(-1);
  /** Área visible (visualViewport) mientras la hoja está abierta. */
  readonly viewportTop = signal(0);
  readonly viewportHeight = signal<number | null>(null);

  readonly inlineListVisible = computed(() => this.listOpen() && !this.sheetMode() && this.state() !== "idle");
  readonly activeOptionId = computed(() => {
    const index = this.activeIndex();
    return index >= 0 && index < this.options().length ? this.optionId(index) : null;
  });

  private readonly inlineInput = viewChild<ElementRef<HTMLInputElement>>("inlineInput");
  private readonly sheetInput = viewChild<ElementRef<HTMLInputElement>>("sheetInput");
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>("trigger");
  private readonly sheet = viewChild<ElementRef<HTMLElement>>("sheet");

  private mediaQuery: MediaQueryList | null = null;
  private lockedScrollY: number | null = null;
  private lockedBodyStyle: Partial<Record<"position" | "top" | "left" | "right" | "width" | "overflow", string>> = {};

  private readonly onMediaChange = (event: MediaQueryListEvent | MediaQueryList): void => {
    const sheet = event.matches;
    if (sheet === this.sheetMode()) return;
    // Al rotar o redimensionar con el selector abierto, se cierra sin perder el texto ni la selección.
    if (!sheet && this.sheetOpen()) this.closeSheet(false);
    if (sheet) this.closeList();
    this.sheetMode.set(sheet);
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.listOpen()) return;
    if (event.target instanceof Node && this.host.nativeElement.contains(event.target)) return;
    this.closeList();
  };

  private readonly onViewportChange = (): void => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    this.viewportTop.set(Math.max(0, viewport.offsetTop));
    this.viewportHeight.set(viewport.height);
  };

  constructor() {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.mediaQuery = window.matchMedia(inject(CUSTOMER_PICKER_SHEET_MEDIA));
      this.sheetMode.set(this.mediaQuery.matches);
      this.mediaQuery.addEventListener("change", this.onMediaChange);
    }

    effect(() => {
      if (this.listOpen()) document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
      else document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    });

    // El índice activo nunca apunta fuera de las opciones vigentes.
    effect(() => {
      const count = this.options().length;
      if (this.activeIndex() >= count) this.activeIndex.set(count - 1);
    });

    inject(DestroyRef).onDestroy(() => {
      this.mediaQuery?.removeEventListener("change", this.onMediaChange);
      document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
      this.detachViewport();
      this.unlockDocumentScroll();
    });
  }

  optionId(index: number): string {
    return `${this.listboxId}-option-${index}`;
  }

  // ── Campo anclado (escritorio / tablet) ──────────────────────────────────

  openList(): void {
    if (!this.sheetMode()) this.listOpen.set(true);
  }

  closeList(): void {
    this.listOpen.set(false);
    this.activeIndex.set(-1);
  }

  onInlineInput(value: string): void {
    this.query.set(value);
    this.selectionCleared.emit();
    this.activeIndex.set(-1);
    this.listOpen.set(true);
  }

  /**
   * Solo se cierra si el foco pasó a otro control fuera del buscador (Tab o clic
   * en otro campo). Un blur sin destino, como ocultar el teclado táctil o cambiar
   * de ventana, no cierra la lista.
   */
  onInlineFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    if (this.host.nativeElement.contains(next)) return;
    this.closeList();
  }

  // ── Hoja (teléfono) ──────────────────────────────────────────────────────

  /**
   * Se llama desde el toque del usuario: la hoja se pinta de inmediato y el foco
   * pasa al buscador en el mismo gesto, condición de iOS para abrir el teclado.
   */
  openSheet(): void {
    if (this.sheetOpen()) return;
    this.lockDocumentScroll();
    this.attachViewport();
    this.sheetOpen.set(true);
    this.activeIndex.set(-1);
    this.changeDetector.detectChanges();
    const field = this.sheetInput()?.nativeElement;
    if (field) {
      field.focus({ preventScroll: true });
      // Al reabrir con texto previo, escribir lo reemplaza; el texto se conserva si solo se cierra.
      if (field.value) field.select();
    }
  }

  closeSheet(restoreFocus = true): void {
    if (!this.sheetOpen()) return;
    this.sheetOpen.set(false);
    this.activeIndex.set(-1);
    this.detachViewport();
    this.unlockDocumentScroll();
    if (restoreFocus) {
      this.changeDetector.detectChanges();
      this.trigger()?.nativeElement.focus({ preventScroll: true });
    }
  }

  /** En la hoja, escribir no invalida la clienta elegida: solo elegir otra la reemplaza. */
  onSheetInput(value: string): void {
    this.query.set(value);
    this.activeIndex.set(-1);
  }

  clearSheetQuery(): void {
    this.query.set("");
    this.activeIndex.set(-1);
    this.sheetInput()?.nativeElement.focus({ preventScroll: true });
  }

  onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget) this.closeSheet();
  }

  /** Mantiene el foco dentro de la hoja (diálogo modal). */
  onSheetKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const sheet = this.sheet()?.nativeElement;
    if (!sheet) return;
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ── Común ────────────────────────────────────────────────────────────────

  /** Teclado: flechas recorren opciones, Enter elige la activa, Escape cierra. */
  onKeydown(event: KeyboardEvent): void {
    const count = this.options().length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.openList();
        if (count > 0) this.activeIndex.set((this.activeIndex() + 1) % count);
        this.scrollActiveIntoView();
        break;
      case "ArrowUp":
        event.preventDefault();
        this.openList();
        if (count > 0) this.activeIndex.set(this.activeIndex() <= 0 ? count - 1 : this.activeIndex() - 1);
        this.scrollActiveIntoView();
        break;
      case "Home":
      case "End":
        if (count > 0 && (this.listOpen() || this.sheetOpen())) {
          event.preventDefault();
          this.activeIndex.set(event.key === "Home" ? 0 : count - 1);
          this.scrollActiveIntoView();
        }
        break;
      case "Enter": {
        const index = this.activeIndex();
        const option = this.options()[index];
        if (option && (this.listOpen() || this.sheetOpen())) {
          event.preventDefault();
          this.choose(option);
        }
        break;
      }
      case "Escape":
        if (this.listOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.closeList();
        }
        break;
    }
  }

  choose(option: CustomerPickerOption): void {
    this.picked.emit(option.id);
    if (this.sheetOpen()) this.closeSheet();
    else this.closeList();
  }

  retryLoad(): void {
    this.retry.emit();
  }

  private scrollActiveIntoView(): void {
    const id = this.activeOptionId();
    if (!id) return;
    queueMicrotask(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" }));
  }

  private attachViewport(): void {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!viewport) return;
    viewport.addEventListener("resize", this.onViewportChange);
    viewport.addEventListener("scroll", this.onViewportChange);
    this.onViewportChange();
  }

  private detachViewport(): void {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    viewport?.removeEventListener("resize", this.onViewportChange);
    viewport?.removeEventListener("scroll", this.onViewportChange);
    this.viewportTop.set(0);
    this.viewportHeight.set(null);
  }

  /**
   * Fija el documento mientras la hoja está abierta. En iOS `overflow: hidden`
   * no basta: el body pasa a `position: fixed` en su posición actual y al cerrar
   * se restaura el scroll exacto.
   */
  private lockDocumentScroll(): void {
    if (this.lockedScrollY !== null || typeof document === "undefined") return;
    const body = document.body;
    this.lockedScrollY = window.scrollY;
    this.lockedBodyStyle = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = "fixed";
    body.style.top = `-${this.lockedScrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
  }

  private unlockDocumentScroll(): void {
    if (this.lockedScrollY === null || typeof document === "undefined") return;
    const body = document.body;
    body.style.position = this.lockedBodyStyle.position ?? "";
    body.style.top = this.lockedBodyStyle.top ?? "";
    body.style.left = this.lockedBodyStyle.left ?? "";
    body.style.right = this.lockedBodyStyle.right ?? "";
    body.style.width = this.lockedBodyStyle.width ?? "";
    body.style.overflow = this.lockedBodyStyle.overflow ?? "";
    const y = this.lockedScrollY;
    this.lockedScrollY = null;
    window.scrollTo(0, y);
  }
}
