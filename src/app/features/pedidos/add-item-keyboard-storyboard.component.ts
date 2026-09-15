import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Reproduccion aislada del bug real: la hoja de "agregar producto" se
 * dimensiona con 100dvh, unidad que NO se encoge cuando aparece el teclado
 * en pantalla (el navegador solo reduce el visualViewport, no el layout
 * viewport). El teclado real es una capa nativa que se pinta encima de la
 * pagina; aqui se simula con `.keyboard-mock` para poder verlo sin un
 * telefono a la mano.
 *
 * `keyboardAware` representa el fix ya aplicado en pedido-detalle.ts/css:
 * mientras el modal esta abierto, un effect() mide con la API
 * visualViewport cuanto tapa el teclado y expone ese alto como la variable
 * --add-item-keyboard-inset, que el backdrop resta de su 100dvh.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: 'app-add-item-keyboard-storyboard',
  templateUrl: './add-item-keyboard-storyboard.component.html',
  styleUrl: './add-item-keyboard-storyboard.component.css',
})
export class AddItemKeyboardStoryboardComponent {
  readonly keyboardOpen = input(false);
  readonly keyboardAware = input(false);
  readonly keyboardHeightPx = input(320);

  readonly suggestions = [
    { title: 'Sandalia plataforma', meta: 'Talla 24 · Rosa', tag: 'Catálogo' },
    { title: 'Sandalia plataforma', meta: 'Talla 25 · Negro', tag: 'Catálogo' },
    { title: 'Tenis casual bordado', meta: 'Talla 23 · Blanco', tag: 'Inventario' },
    { title: 'Tenis casual bordado', meta: 'Talla 24 · Blanco', tag: 'Inventario' },
    { title: 'Bolsa crossbody mini', meta: 'Único · Café', tag: 'Catálogo' },
    { title: 'Bolsa crossbody mini', meta: 'Único · Negro', tag: 'Catálogo' },
  ] as const;

  readonly frameStyle = computed(() => ({
    '--keyboard-inset': this.keyboardOpen() ? `${this.keyboardHeightPx()}px` : '0px',
  }));

  readonly statusLabel = computed(() => {
    if (!this.keyboardOpen()) return 'Teclado cerrado — diseño actual, tal cual lo ves hoy.';
    return this.keyboardAware()
      ? 'Teclado abierto, con el fix: la hoja resta el alto del teclado y todo queda visible.'
      : 'Teclado abierto, sin el fix: la hoja sigue midiendo 100dvh completo y el teclado tapa la mitad de abajo.';
  });
}
