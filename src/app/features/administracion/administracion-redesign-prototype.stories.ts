import type { Meta, StoryObj } from '@storybook/angular';
import {
  AdministracionRedesignPrototypeComponent,
  type AdministrationPrototypeBusiness,
  type AdministrationPrototypeView,
  type PartnerPrototypeScope,
} from './administracion-redesign-prototype.component';

const meta: Meta<AdministracionRedesignPrototypeComponent> = {
  id: 'administracion-redesign-centro-financiero',
  title: 'Administración/Rediseño/Centro financiero',
  component: AdministracionRedesignPrototypeComponent,
  tags: ['autodocs'],
  args: {
    initialView: 'resumen',
    initialPartnerScope: 'general',
    initialBusiness: 'bm',
  },
  argTypes: {
    initialView: {
      control: 'inline-radio',
      options: ['resumen', 'mensual', 'inventario', 'socios'] satisfies readonly AdministrationPrototypeView[],
      description: 'Vista inicial del prototipo. La navegación interna permite cambiarla.',
    },
    initialPartnerScope: {
      control: 'inline-radio',
      options: ['general', 'mensual'] satisfies readonly PartnerPrototypeScope[],
      description: 'Nivel inicial de análisis dentro de Utilidades y socios.',
    },
    initialBusiness: {
      control: 'inline-radio',
      options: ['bm', 'catalogo'] satisfies readonly AdministrationPrototypeBusiness[],
      description: 'Simula el negocio activo heredado del selector global. Nunca combina ambos negocios.',
    },
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Boceto interactivo y aislado del rediseño de Administración. Presenta un resumen ejecutivo accionable, ' +
          'análisis mensual, capital inmovilizado en inventario y distribución 50/50 entre socios. Todos los datos son ficticios; ' +
          'esta story no consume servicios ni modifica operaciones financieras.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<AdministracionRedesignPrototypeComponent>;

export const ResumenEjecutivo: Story = {};

export const AnalisisMensual: Story = {
  args: { initialView: 'mensual' },
};

export const InventarioYCapital: Story = {
  args: { initialView: 'inventario' },
};

export const UtilidadesYSocios: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general' },
};

export const SociosAnalisisMensual: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'mensual' },
};

export const CatalogoSociosGeneral: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general', initialBusiness: 'catalogo' },
};

export const Desktop1024: Story = {
  globals: { viewport: { value: 'desktop1024', isRotated: false } },
};

export const Tablet768: Story = {
  globals: { viewport: { value: 'tablet768', isRotated: false } },
};

export const Mobile390: Story = {
  globals: { viewport: { value: 'mobile390', isRotated: false } },
};

export const Narrow360Socios: Story = {
  args: { initialView: 'socios' },
  globals: { viewport: { value: 'narrow360', isRotated: false } },
};

export const Mobile390Inventario: Story = {
  args: { initialView: 'inventario' },
  globals: { viewport: { value: 'mobile390', isRotated: false } },
};

export const SociosDesktop1440: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general' },
  globals: { viewport: { value: 'desktop1440', isRotated: false } },
};

export const SociosDesktop1024: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general' },
  globals: { viewport: { value: 'desktop1024', isRotated: false } },
};

export const SociosTablet768: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general' },
  globals: { viewport: { value: 'tablet768', isRotated: false } },
};

export const SociosMobile390: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general' },
  globals: { viewport: { value: 'mobile390', isRotated: false } },
};

export const SociosMobile360: Story = {
  args: { initialView: 'socios', initialPartnerScope: 'general' },
  globals: { viewport: { value: 'narrow360', isRotated: false } },
};
