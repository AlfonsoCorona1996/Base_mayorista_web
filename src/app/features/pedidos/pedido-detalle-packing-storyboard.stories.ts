import type { Meta, StoryObj } from '@storybook/angular';
import {
  PedidoDetallePackingStoryboardComponent,
  type PackingAvailabilityState,
  type PackingStoryboardLayout,
} from './pedido-detalle-packing-storyboard.component';

const meta: Meta<PedidoDetallePackingStoryboardComponent> = {
  title: 'Pedidos/Pedido detalle/Activación de Paquetes',
  component: PedidoDetallePackingStoryboardComponent,
  tags: ['autodocs'],
  args: {
    layoutMode: 'storyboard',
    initialState: 'locked',
  },
  argTypes: {
    layoutMode: {
      control: 'inline-radio',
      options: ['storyboard', 'interactive'] satisfies readonly PackingStoryboardLayout[],
      description:
        'Muestra la secuencia completa o una demostración que puede recorrerse con botones.',
    },
    initialState: {
      control: 'inline-radio',
      options: [
        'locked',
        'ready',
        'opened',
        'packed',
      ] satisfies readonly PackingAvailabilityState[],
      description: 'Estado inicial de la demostración interactiva.',
    },
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Propuesta visual aislada para comunicar cuándo se habilita la sección Paquetes en Pedido detalle. ' +
          'Se habilita con el primer producto empacable, conserva el badge Pendiente hasta completar el pedido ' +
          'y pausa el pulso mientras el usuario trabaja dentro de Paquetes.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<PedidoDetallePackingStoryboardComponent>;

export const StoryboardCompleto: Story = {};

export const DemoInteractiva: Story = {
  args: {
    layoutMode: 'interactive',
    initialState: 'locked',
  },
};

export const RecienHabilitado: Story = {
  args: {
    layoutMode: 'interactive',
    initialState: 'ready',
  },
};

export const PaquetesAbierto: Story = {
  args: {
    layoutMode: 'interactive',
    initialState: 'opened',
  },
};

export const EmpaqueCompleto: Story = {
  args: {
    layoutMode: 'interactive',
    initialState: 'packed',
  },
};

export const Mobile390: Story = {
  args: {
    layoutMode: 'interactive',
    initialState: 'ready',
  },
  globals: {
    viewport: { value: 'mobile390', isRotated: false },
  },
};

export const Narrow360: Story = {
  args: {
    layoutMode: 'interactive',
    initialState: 'locked',
  },
  globals: {
    viewport: { value: 'narrow360', isRotated: false },
  },
};

export const Tablet768: Story = {
  globals: {
    viewport: { value: 'tablet768', isRotated: false },
  },
};

export const Desktop1024: Story = {
  globals: {
    viewport: { value: 'desktop1024', isRotated: false },
  },
};

export const Desktop1440: Story = {
  globals: {
    viewport: { value: 'desktop1440', isRotated: false },
  },
};
