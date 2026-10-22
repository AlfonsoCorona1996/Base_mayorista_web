import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_PX = 60;

/**
 * Visor de fotografías a pantalla completa: zoom con dos dedos, doble toque, rueda o
 * botones; desplazamiento de la imagen ampliada; galería con deslizamiento o flechas.
 *
 * Es presentacional: no selecciona productos ni modifica formularios. El llamador solo
 * decide qué imágenes mostrar y qué hacer al cerrar. Se dibuja por encima de cualquier
 * hoja o barra fija (z-index propio) y respeta las áreas seguras del iPhone.
 */
@Component({
  selector: "app-image-zoom-viewer",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./image-zoom-viewer.component.html",
  styleUrl: "./image-zoom-viewer.component.css",
})
export class ImageZoomViewerComponent implements AfterViewInit, OnDestroy {
  readonly images = input.required<readonly string[]>();
  readonly startIndex = input(0);
  /** Nombre del producto, para el título accesible y el texto alternativo. */
  readonly label = input("Producto");
  readonly closed = output<void>();

  readonly index = signal(0);
  readonly scale = signal(1);
  readonly offsetX = signal(0);
  readonly offsetY = signal(0);
  readonly loading = signal(true);
  readonly failed = signal(false);

  readonly count = computed(() => this.images().length);
  readonly current = computed(() => this.images()[this.index()] ?? null);
  readonly transform = computed(() => `translate3d(${this.offsetX()}px, ${this.offsetY()}px, 0) scale(${this.scale()})`);
  readonly zoomed = computed(() => this.scale() > 1.01);

  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>("closeButton");
  private readonly stage = viewChild<ElementRef<HTMLElement>>("stage");
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart: { distance: number; scale: number } | null = null;
  private panStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null;
  private swipeStartX: number | null = null;
  private lastTapAt = 0;
  private previouslyFocused: HTMLElement | null = null;
  private initialized = false;

  ngAfterViewInit(): void {
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const start = Math.min(Math.max(0, Math.trunc(this.startIndex())), Math.max(0, this.count() - 1));
    this.index.set(start);
    this.initialized = true;
    queueMicrotask(() => this.closeButton()?.nativeElement.focus({ preventScroll: true }));
  }

  ngOnDestroy(): void {
    this.previouslyFocused?.focus?.({ preventScroll: true });
  }

  close(event?: Event): void {
    event?.stopPropagation();
    this.closed.emit();
  }

  go(delta: number): void {
    const total = this.count();
    if (total <= 1) return;
    this.index.set((this.index() + delta + total) % total);
    this.resetZoom();
    this.loading.set(true);
    this.failed.set(false);
  }

  select(index: number): void {
    if (index === this.index()) return;
    this.index.set(index);
    this.resetZoom();
    this.loading.set(true);
    this.failed.set(false);
  }

  zoomBy(factor: number): void {
    this.setScale(this.scale() * factor);
  }

  resetZoom(): void {
    this.scale.set(1);
    this.offsetX.set(0);
    this.offsetY.set(0);
  }

  onImageLoad(): void {
    this.loading.set(false);
  }

  onImageError(): void {
    this.loading.set(false);
    this.failed.set(true);
  }

  @HostListener("document:keydown", ["$event"])
  onKeydown(event: KeyboardEvent): void {
    if (!this.initialized) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.close();
        break;
      case "ArrowRight":
        event.preventDefault();
        this.go(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.go(-1);
        break;
      case "+":
      case "=":
        event.preventDefault();
        this.zoomBy(1.5);
        break;
      case "-":
        event.preventDefault();
        this.zoomBy(1 / 1.5);
        break;
    }
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  onPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    this.stage()?.nativeElement.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.pinchStart = { distance: this.pointerDistance(), scale: this.scale() };
      this.panStart = null;
      this.swipeStartX = null;
      return;
    }
    if (this.zoomed()) {
      this.panStart = { x: event.clientX, y: event.clientY, offsetX: this.offsetX(), offsetY: this.offsetY() };
    } else {
      this.swipeStartX = event.clientX;
    }
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2 && this.pinchStart) {
      const distance = this.pointerDistance();
      if (this.pinchStart.distance > 0) this.setScale(this.pinchStart.scale * (distance / this.pinchStart.distance));
      return;
    }
    if (this.panStart) {
      this.offsetX.set(this.panStart.offsetX + (event.clientX - this.panStart.x));
      this.offsetY.set(this.panStart.offsetY + (event.clientY - this.panStart.y));
    }
  }

  onPointerUp(event: PointerEvent): void {
    const wasSingle = this.pointers.size === 1;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    if (!wasSingle) return;
    this.panStart = null;
    if (this.swipeStartX !== null && !this.zoomed()) {
      const dx = event.clientX - this.swipeStartX;
      this.swipeStartX = null;
      if (Math.abs(dx) >= SWIPE_PX) {
        this.go(dx < 0 ? 1 : -1);
        return;
      }
    }
    const now = Date.now();
    if (now - this.lastTapAt < 300) {
      this.lastTapAt = 0;
      if (this.zoomed()) this.resetZoom();
      else this.setScale(DOUBLE_TAP_SCALE);
    } else {
      this.lastTapAt = now;
    }
  }

  private setScale(value: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
    this.scale.set(next);
    if (next <= 1.01) {
      this.offsetX.set(0);
      this.offsetY.set(0);
    }
  }

  private pointerDistance(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
