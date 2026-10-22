import { signal } from "@angular/core";

/**
 * Mantiene una hoja de pantalla completa dentro del área realmente visible en móvil.
 *
 * Mismo patrón que validó FIX 02 en el buscador de clientas (`CustomerPickerComponent`):
 * - Sigue `visualViewport.offsetTop` y `visualViewport.height`. En iOS el teclado no
 *   encoge el viewport de layout: Safari desplaza el viewport visual, así que restar solo
 *   la altura del teclado dejaba el encabezado y el buscador por encima de lo visible.
 * - Fija el documento con `position: fixed` (en iOS `overflow: hidden` no basta) y al
 *   cerrar restaura el scroll exacto.
 *
 * Las señales se exponen para estilos (`top`/`height` del fondo). Sin `visualViewport`
 * (escritorio antiguo, pruebas) quedan en 0/null y el CSS usa sus valores normales.
 */
export class VisualViewportSheet {
  readonly top = signal(0);
  readonly height = signal<number | null>(null);

  private active = false;
  private lockedScrollY: number | null = null;
  private lockedBodyStyle: Partial<Record<"position" | "top" | "left" | "right" | "width" | "overflow", string>> = {};

  private readonly onViewportChange = (): void => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!viewport) return;
    this.top.set(Math.max(0, viewport.offsetTop));
    this.height.set(viewport.height);
  };

  get isActive(): boolean {
    return this.active;
  }

  open(): void {
    if (this.active) return;
    this.active = true;
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    viewport?.addEventListener("resize", this.onViewportChange);
    viewport?.addEventListener("scroll", this.onViewportChange);
    this.onViewportChange();
    this.lockDocumentScroll();
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    viewport?.removeEventListener("resize", this.onViewportChange);
    viewport?.removeEventListener("scroll", this.onViewportChange);
    this.top.set(0);
    this.height.set(null);
    this.unlockDocumentScroll();
  }

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
