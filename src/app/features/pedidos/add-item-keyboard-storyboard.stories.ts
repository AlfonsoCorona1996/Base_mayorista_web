import type { Meta, StoryObj } from '@storybook/angular';
import { AddItemKeyboardStoryboardComponent } from './add-item-keyboard-storyboard.component';

const meta: Meta<AddItemKeyboardStoryboardComponent> = {
  title: 'Pedidos/Pedido detalle/Agregar producto - teclado en mobile',
  component: AddItemKeyboardStoryboardComponent,
  tags: ['autodocs'],
  args: {
    keyboardOpen: false,
    keyboardAware: false,
    keyboardHeightPx: 320,
  },
  argTypes: {
    keyboardOpen: {
      control: 'boolean',
      description: 'Simula que el teclado del sistema está abierto (el usuario está escribiendo en el buscador).',
    },
    keyboardAware: {
      control: 'boolean',
      description:
        'Aplica el fix real ya implementado en pedido-detalle.ts/css: resta el alto del teclado (medido con visualViewport) al 100dvh de la hoja.',
    },
    keyboardHeightPx: {
      control: { type: 'range', min: 220, max: 420, step: 10 },
      description: 'Alto aproximado del teclado simulado, en px (iOS con barra predictiva ronda 320-360px).',
    },
  },
  globals: {
    viewport: { value: 'mobile390', isRotated: false },
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Reproduce el bug reportado: la hoja de "Agregar producto" se dimensiona con `100dvh`, unidad que ' +
          'no se encoge cuando aparece el teclado en pantalla (el navegador solo reduce el `visualViewport`, no ' +
          'el layout viewport). El teclado tapa entonces el input, la lista de sugerencias y el botón de guardar, ' +
          'sin que nada se reacomode; eso es lo que se siente como "no puedo hacer scroll" aunque el scroll en sí ' +
          'funcione, porque la fila de sugerencias queda oculta o reducida a una franja mínima debajo del teclado. ' +
          'El toggle "keyboardAware" muestra el fix real: un `effect()` sobre `addItemModalOpen` mide el teclado ' +
          'con la API `visualViewport` y expone `--add-item-keyboard-inset`, que el backdrop resta de su `100dvh`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<AddItemKeyboardStoryboardComponent>;

export const TecladoCerrado: Story = {
  name: '1. Teclado cerrado (diseño actual)',
  args: {
    keyboardOpen: false,
  },
};

export const TecladoAbiertoBug: Story = {
  name: '2. Teclado abierto — bug reportado',
  args: {
    keyboardOpen: true,
    keyboardAware: false,
  },
};

export const TecladoAbiertoConFix: Story = {
  name: '3. Teclado abierto — con el fix aplicado',
  args: {
    keyboardOpen: true,
    keyboardAware: true,
  },
};

export const TecladoAndroidConFix: Story = {
  name: '4. Teclado abierto (Android, ~260px) — con el fix',
  args: {
    keyboardOpen: true,
    keyboardAware: true,
    keyboardHeightPx: 260,
  },
};
