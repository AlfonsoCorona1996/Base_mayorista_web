import { signal } from "@angular/core";

/**
 * Virtualización de presentación para Pedidos (tabla y tarjetas).
 *
 * Solo decide QUÉ elementos se montan: búsqueda, filtros, contadores, selección,
 * exportaciones y acciones masivas siguen trabajando sobre la lista completa.
 *
 * - Alturas variables: se mide cada elemento montado y se guarda por id. Los no
 *   medidos usan el promedio de los medidos (o la estimación inicial).
 * - Grilla de N columnas: una "fila virtual" agrupa N elementos y mide lo que el
 *   más alto. La tabla es el caso N = 1 sin separación.
 * - Lo no montado se sustituye por espaciadores (padding o filas vacías) que
 *   conservan el alto total, así el scroll llega al primer y al último pedido.
 * - Anclaje: cuando cambian datos o alturas por encima de lo visible, el primer
 *   pedido visible se mantiene en su sitio en pantalla. Con un cambio de filtro u
 *   orden la lista vuelve al inicio.
 */
export interface VirtualRange {
  /** Primer índice montado (inclusive) de la lista completa. */
  start: number;
  /** Último índice montado (exclusivo). */
  end: number;
  /** Alto que sustituye a los elementos anteriores a `start`. */
  padTop: number;
  /** Alto que sustituye a los elementos posteriores a `end`. */
  padBottom: number;
}

export interface VirtualGridOptions {
  /** Alto inicial estimado de un elemento sin medir. */
  estimate: number;
  /** Margen montado por encima y por debajo del área visible. */
  overscanPx: number;
  /** Elementos montados antes de conocer el viewport. */
  initialCount: number;
}

/** Política al recibir una lista nueva. */
export type VirtualListChange = "reset" | "keep";

type Scroller = HTMLElement | Window;
/** "element": el contenedor tiene su propio scroll (tabla). "page": desplaza el documento (tarjetas). */
type ScrollMode = "element" | "page";

interface Anchor {
  id: string;
  /** Distancia del inicio del área visible respecto del inicio de la fila del ancla. */
  delta: number;
}

const ITEM_ATTRIBUTE = "data-vid";

export class VirtualGridController {
  readonly range = signal<VirtualRange>({ start: 0, end: 0, padTop: 0, padBottom: 0 });

  private ids: string[] = [];
  private indexById = new Map<string, number>();
  private readonly heights = new Map<string, number>();
  private measuredSum = 0;
  private cols = 1;
  private gap = 0;
  private contentWidth = 0;
  private offsets: number[] = [0];

  private scroller: HTMLElement | null = null;
  private mode: ScrollMode = "page";
  private content: HTMLElement | null = null;
  private headerOffset: () => number = () => 0;
  private resizeObserver: ResizeObserver | null = null;
  private frame = 0;
  private pendingAnchor: Anchor | null = null;
  private pendingReset = false;

  constructor(private readonly options: VirtualGridOptions) {}

  /** Número de elementos de la lista completa. */
  get count(): number {
    return this.ids.length;
  }

  // ── Datos ────────────────────────────────────────────────────────────────

  /**
   * Recibe la lista completa (ids en orden de presentación).
   * - `reset`: cambio de filtro, búsqueda, orden o negocio. La lista vuelve al inicio.
   * - `keep`: cambio de datos (snapshot). El primer pedido visible queda en su sitio;
   *   si la persona está al inicio de la lista, se sigue viendo el inicio (los
   *   pedidos nuevos o actualizados aparecen arriba, como antes).
   */
  setItems(ids: string[], change: VirtualListChange): void {
    const anchor = change === "keep" && this.isBound() ? this.captureAnchor() : null;
    this.ids = ids;
    this.indexById = new Map(ids.map((id, index) => [id, index]));
    this.rebuild();

    if (!this.isBound()) {
      this.setRange(this.rangeForRows(0, this.rowAtOffset(0) + this.rowsFor(this.options.initialCount)));
      return;
    }
    if (change === "reset") {
      this.pendingAnchor = null;
      this.pendingReset = true;
      this.setRange(this.rangeForRegion(0, this.viewportHeight()));
      this.schedule();
      return;
    }
    if (anchor && this.indexById.has(anchor.id)) {
      const row = this.rowOf(this.indexById.get(anchor.id)!);
      const top = this.offsets[row] + anchor.delta;
      this.pendingAnchor = anchor;
      this.setRange(this.rangeForRegion(top, top + this.viewportHeight()));
      this.schedule();
      return;
    }
    this.update(true);
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  /**
   * Conecta el controlador con su contenedor de elementos (tbody o grilla).
   * - Con `scroller`: ese elemento tiene su propio scroll (tabla).
   * - Sin `scroller`: desplaza la página. El scroll se escucha en captura sobre
   *   `document`, porque en esta app quien desplaza suele ser el body y su evento
   *   no llega a `window`.
   */
  bind(content: HTMLElement, scroller?: HTMLElement | null, headerOffset?: () => number): void {
    this.unbind();
    this.content = content;
    this.scroller = scroller ?? null;
    this.mode = scroller ? "element" : "page";
    this.headerOffset = headerOffset ?? (() => 0);
    if (scroller) scroller.addEventListener("scroll", this.onScroll, { passive: true });
    else document.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    window.addEventListener("resize", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(content);
      if (scroller) this.resizeObserver.observe(scroller);
    }
    this.schedule();
  }

  unbind(): void {
    if (this.scroller) this.scroller.removeEventListener("scroll", this.onScroll);
    else document.removeEventListener("scroll", this.onScroll, { capture: true });
    window.removeEventListener("resize", this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.scroller = null;
    this.content = null;
    this.pendingAnchor = null;
    this.pendingReset = false;
  }

  /**
   * Después de cada render: aplica el ajuste de scroll pendiente (reinicio o
   * ancla), que debe ocurrir antes de pintar. No escribe señales: medir y
   * recalcular el rango se hace en el siguiente frame, así un render nunca
   * encadena otro dentro del mismo ciclo de Angular.
   */
  afterRender(): void {
    if (!this.isBound()) return;
    if (this.pendingReset) {
      this.pendingReset = false;
      this.scrollToListStart();
    }
    if (this.pendingAnchor) {
      const anchor = this.pendingAnchor;
      this.pendingAnchor = null;
      this.restoreAnchor(anchor);
    }
    this.schedule();
  }

  /** Lleva el inicio de la lista al inicio del área visible, si quedó por encima. */
  scrollToListStart(): void {
    const region = this.visibleRegion();
    if (!region || region.top <= 0) return;
    this.scrollBy(-region.top);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private readonly onScroll = (): void => this.schedule();

  private schedule(): void {
    if (this.frame || typeof requestAnimationFrame === "undefined") return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.isBound()) return;
      if (this.measure()) return;
      this.update(false);
    });
  }

  private isBound(): boolean {
    return !!this.content;
  }

  /** Mide los elementos montados. Devuelve true si cambió algo que obliga a recalcular. */
  private measure(): boolean {
    const content = this.content;
    if (!content) return false;
    let layoutChanged = false;

    const width = content.clientWidth;
    const { cols, gap } = readGrid(content);
    if (cols !== this.cols || gap !== this.gap || Math.abs(width - this.contentWidth) > 1) {
      // Otro ancho u otras columnas: las alturas medidas ya no valen.
      if (this.contentWidth !== 0) this.clearHeights();
      this.cols = cols;
      this.gap = gap;
      this.contentWidth = width;
      layoutChanged = true;
    }

    let heightsChanged = false;
    for (const element of Array.from(content.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`))) {
      const id = element.getAttribute(ITEM_ATTRIBUTE);
      if (!id) continue;
      const height = element.getBoundingClientRect().height;
      if (height <= 0) continue;
      const previous = this.heights.get(id);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) continue;
      if (previous !== undefined) this.measuredSum -= previous;
      this.heights.set(id, height);
      this.measuredSum += height;
      heightsChanged = true;
    }
    if (!heightsChanged && !layoutChanged) return false;

    const anchor = this.captureAnchor();
    this.rebuild();
    if (anchor && this.indexById.has(anchor.id)) {
      const row = this.rowOf(this.indexById.get(anchor.id)!);
      const top = this.offsets[row] + anchor.delta;
      const next = this.rangeForRegion(top, top + this.viewportHeight());
      if (this.setRange(next)) {
        this.pendingAnchor = anchor;
      } else {
        this.restoreAnchor(anchor);
      }
    } else {
      this.update(true);
    }
    return true;
  }

  /** Recalcula el rango si lo montado ya no cubre el área visible con margen. */
  private update(force: boolean): void {
    const region = this.visibleRegion();
    if (!region) return;
    const current = this.range();
    const margin = this.options.overscanPx / 2;
    const rows = this.rowCount();
    const startRow = this.rowOf(current.start);
    const endRow = Math.min(rows, Math.ceil(current.end / this.cols));
    const coversTop = startRow === 0 || this.offsets[startRow] <= region.top - margin;
    const coversBottom = endRow >= rows || this.offsets[endRow] >= region.bottom + margin;
    if (!force && coversTop && coversBottom && current.end <= this.ids.length) return;
    this.setRange(this.rangeForRegion(region.top, region.bottom));
  }

  private setRange(next: VirtualRange): boolean {
    const current = this.range();
    if (
      current.start === next.start &&
      current.end === next.end &&
      Math.abs(current.padTop - next.padTop) < 0.5 &&
      Math.abs(current.padBottom - next.padBottom) < 0.5
    ) {
      return false;
    }
    this.range.set(next);
    return true;
  }

  private rangeForRegion(top: number, bottom: number): VirtualRange {
    const overscan = this.options.overscanPx;
    const startRow = this.rowAtOffset(Math.max(0, top - overscan));
    const endRow = this.rowAtOffset(Math.max(0, bottom + overscan)) + 1;
    return this.rangeForRows(startRow, endRow);
  }

  private rangeForRows(startRow: number, endRow: number): VirtualRange {
    const rows = this.rowCount();
    const first = Math.max(0, Math.min(startRow, rows));
    const last = Math.max(first, Math.min(endRow, rows));
    const total = this.offsets[rows];
    return {
      start: Math.min(this.ids.length, first * this.cols),
      end: Math.min(this.ids.length, last * this.cols),
      padTop: this.offsets[first],
      // Dentro de la grilla la última fila montada no lleva separación inferior: la aporta el espaciador.
      padBottom: Math.max(0, total - this.offsets[last] + (last < rows ? this.gap : 0)),
    };
  }

  /** Área visible en coordenadas del contenido (0 = inicio del primer elemento). */
  private visibleRegion(): { top: number; bottom: number } | null {
    const content = this.content;
    if (!content) return null;
    const contentTop = content.getBoundingClientRect().top;
    let viewportTop: number;
    let viewportBottom: number;
    const scroller = this.scroller;
    if (this.mode === "element" && scroller) {
      const rect = scroller.getBoundingClientRect();
      viewportTop = rect.top + this.headerOffset();
      viewportBottom = rect.top + scroller.clientHeight;
    } else {
      viewportTop = this.headerOffset();
      viewportBottom = window.innerHeight;
    }
    return { top: viewportTop - contentTop, bottom: viewportBottom - contentTop };
  }

  private viewportHeight(): number {
    const region = this.visibleRegion();
    return region ? Math.max(0, region.bottom - region.top) : 0;
  }

  /** Primer pedido visible y su desplazamiento, salvo que se esté al inicio de la lista. */
  private captureAnchor(): Anchor | null {
    const region = this.visibleRegion();
    if (!region || region.top <= 0 || this.ids.length === 0) return null;
    const row = this.rowAtOffset(region.top);
    const id = this.ids[row * this.cols];
    if (!id) return null;
    return { id, delta: region.top - this.offsets[row] };
  }

  private restoreAnchor(anchor: Anchor): void {
    const index = this.indexById.get(anchor.id);
    const region = this.visibleRegion();
    if (index === undefined || !region) return;
    const target = this.offsets[this.rowOf(index)] + anchor.delta;
    const diff = target - region.top;
    if (Math.abs(diff) >= 1) this.scrollBy(diff);
  }

  private scrollBy(delta: number): void {
    const target = this.scroller ?? (this.content ? findScrollParent(this.content) : null);
    if (!target) return;
    if (target instanceof HTMLElement) target.scrollTop += delta;
    else target.scrollBy(0, delta);
  }

  private clearHeights(): void {
    this.heights.clear();
    this.measuredSum = 0;
  }

  private estimate(): number {
    return this.heights.size > 0 ? this.measuredSum / this.heights.size : this.options.estimate;
  }

  private rowCount(): number {
    return Math.ceil(this.ids.length / this.cols);
  }

  private rowOf(index: number): number {
    return Math.floor(index / this.cols);
  }

  private rowsFor(items: number): number {
    return Math.ceil(items / this.cols);
  }

  private rebuild(): void {
    const rows = this.rowCount();
    const estimate = this.estimate();
    const offsets = new Array<number>(rows + 1);
    offsets[0] = 0;
    for (let row = 0; row < rows; row++) {
      let height = 0;
      const end = Math.min(this.ids.length, (row + 1) * this.cols);
      for (let index = row * this.cols; index < end; index++) {
        height = Math.max(height, this.heights.get(this.ids[index]) ?? estimate);
      }
      offsets[row + 1] = offsets[row] + height + (row < rows - 1 ? this.gap : 0);
    }
    this.offsets = offsets;
  }

  /** Fila que contiene el desplazamiento `y` (búsqueda binaria). */
  private rowAtOffset(y: number): number {
    const rows = this.rowCount();
    if (rows === 0) return 0;
    let low = 0;
    let high = rows - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.offsets[mid] <= y) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

/** Columnas y separación entre filas de una grilla CSS; 1 y 0 para cualquier otro contenedor. */
function readGrid(element: HTMLElement): { cols: number; gap: number } {
  const style = getComputedStyle(element);
  if (style.display !== "grid" && style.display !== "inline-grid") return { cols: 1, gap: 0 };
  const template = style.gridTemplateColumns;
  const cols = template && template !== "none" ? template.split(" ").filter(Boolean).length : 1;
  const gap = Number.parseFloat(style.rowGap) || 0;
  return { cols: Math.max(1, cols), gap };
}

/** Ancestro que realmente desplaza el contenido (en esta app suele ser el body). */
export function findScrollParent(element: HTMLElement): Scroller {
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
}
