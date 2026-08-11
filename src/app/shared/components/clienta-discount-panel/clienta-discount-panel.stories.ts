import type { Meta, StoryObj } from "@storybook/angular";
import { ClientaDiscountPanelComponent } from "./clienta-discount-panel.component";

const meta: Meta<ClientaDiscountPanelComponent> = {
  title: "Pedidos/Clienta discount panel",
  component: ClientaDiscountPanelComponent,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Panel presentacional usado por PedidoDetalle para definir el precio clienta. " +
          "Estas historias son la fuente de verdad para revisar sus estados visuales antes de integrarlos.",
      },
    },
  },
  argTypes: {
    mode: {
      control: "inline-radio",
      options: ["pct", "fixed"],
    },
    percent: {
      control: { type: "number", min: 0, max: 100, step: 1 },
    },
    fixedAmount: {
      control: { type: "number", min: 0, step: 1 },
    },
    modeChange: { action: "modeChange" },
    percentChange: { action: "percentChange" },
    fixedAmountChange: { action: "fixedAmountChange" },
    cancel: { action: "cancel" },
    apply: { action: "apply" },
  },
};

export default meta;
type Story = StoryObj<ClientaDiscountPanelComponent>;

export const DefaultPercent: Story = {
  args: {
    panelId: "storybook-discount-percent",
    title: "Definir precio clienta",
    mode: "pct",
    percent: 25,
    fixedAmount: 0,
    previewText: "$75.00",
    saving: false,
    applyDisabled: false,
    applyLabel: "Aplicar precio",
    helpText: "Después guarda los cambios del producto para confirmar.",
  },
};

export const FixedAmount: Story = {
  args: {
    ...DefaultPercent.args,
    panelId: "storybook-discount-fixed",
    mode: "fixed",
    fixedAmount: 35,
    previewText: "$65.00",
  },
};

export const Invalid: Story = {
  args: {
    ...FixedAmount.args,
    panelId: "storybook-discount-invalid",
    previewText: "—",
    applyDisabled: true,
    errorText: "Captura primero el precio final para calcular el descuento.",
  },
};

export const Saving: Story = {
  args: {
    ...FixedAmount.args,
    panelId: "storybook-discount-saving",
    saving: true,
  },
};

export const Mobile390: Story = {
  args: {
    ...FixedAmount.args,
    panelId: "storybook-discount-mobile-390",
  },
  parameters: {
    viewport: { defaultViewport: "mobile390" },
  },
};

export const Narrow360: Story = {
  args: {
    ...DefaultPercent.args,
    panelId: "storybook-discount-mobile-360",
    title: "Definir precio clienta para este producto",
    helpText: "Guarda los cambios del producto para confirmar el descuento y conservar la bitácora.",
  },
  parameters: {
    viewport: { defaultViewport: "narrow360" },
  },
};
