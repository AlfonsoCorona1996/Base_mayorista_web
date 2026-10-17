import type { Meta, StoryObj } from "@storybook/angular";
import { CustomerPickerComponent, CustomerPickerOption } from "./customer-picker.component";

const OPTIONS: CustomerPickerOption[] = [
  { id: "c-ana", name: "Ana Lopez", detail: "55 1234 5678" },
  { id: "c-anabel", name: "Anabel María de los Ángeles Hernández Villaseñor de la Garza", detail: "55 8765 4321" },
  { id: "c-anahi", name: "Anahí Ruiz", detail: "" },
  { id: "c-anais", name: "Anaís Duarte", detail: "33 1111 2222" },
  { id: "c-ana-paula", name: "Ana Paula Medina", detail: "81 3333 4444" },
  { id: "c-anastasia", name: "Anastasia Ortega", detail: "55 5555 6666" },
];

/** Las variables --ios-* viven en el :host de PedidosPage; aquí se replican para verlo igual. */
const PEDIDOS_CONTEXT = [
  "--ios-border: rgba(15, 23, 42, 0.1)",
  "--ios-surface-soft: #f8f9fd",
  "--ios-text: #111827",
  "--ios-muted: #6b7280",
  "--ios-blue: #007aff",
  "--ios-danger: #b4233c",
  "display: block",
  "width: min(560px, 100%)",
  "padding: 14px",
  "border-radius: 20px",
  "background: #ffffff",
  "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
].join("; ");

const meta: Meta<CustomerPickerComponent> = {
  title: "Pedidos/Buscador de clientas",
  component: CustomerPickerComponent,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Buscador de clientas de «Crear pedido». En escritorio y tablet es un combobox anclado; en teléfono abre una hoja " +
          "que sigue el área visible del teclado (visualViewport). Cambia de patrón según el ancho del viewport: usa el selector de viewport.",
      },
    },
  },
  render: (args) => ({
    props: args,
    template: `
      <div style="${PEDIDOS_CONTEXT}">
        <app-customer-picker
          [query]="query"
          [options]="options"
          [state]="state"
          [selectedName]="selectedName"
          (picked)="picked($event)"
          (selectionCleared)="selectionCleared()"
          (retry)="retry()"
        />
      </div>
    `,
  }),
  argTypes: {
    state: { control: "inline-radio", options: ["idle", "loading", "error", "results", "no-results"] },
    picked: { action: "picked" },
    selectionCleared: { action: "selectionCleared" },
    retry: { action: "retry" },
  },
};

export default meta;
type Story = StoryObj<CustomerPickerComponent>;

export const EscritorioConResultados: Story = {
  args: { query: "ana", options: OPTIONS, state: "results", selectedName: null },
  globals: { viewport: { value: "desktop1024", isRotated: false } },
};

export const EscritorioCargando: Story = {
  args: { query: "ana", options: [], state: "loading", selectedName: null },
  globals: { viewport: { value: "desktop1440", isRotated: false } },
};

export const EscritorioError: Story = {
  args: { query: "ana", options: [], state: "error", selectedName: null },
  globals: { viewport: { value: "tablet768", isRotated: false } },
};

export const EscritorioSinResultados: Story = {
  args: { query: "zulema", options: [], state: "no-results", selectedName: null },
  globals: { viewport: { value: "desktop1024", isRotated: false } },
};

export const TelefonoSinSeleccion: Story = {
  args: { query: "", options: [], state: "idle", selectedName: null },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const TelefonoConSeleccionLarga: Story = {
  args: {
    query: "Anabel",
    options: OPTIONS.slice(1, 2),
    state: "results",
    selectedName: "Anabel María de los Ángeles Hernández Villaseñor de la Garza",
  },
  globals: { viewport: { value: "narrow360", isRotated: false } },
};

export const TelefonoResultados: Story = {
  args: { query: "ana", options: OPTIONS, state: "results", selectedName: null },
  globals: { viewport: { value: "mobile390", isRotated: false } },
  parameters: { docs: { description: { story: "Toca el campo para abrir la hoja de búsqueda." } } },
};

export const TelefonoError: Story = {
  args: { query: "ana", options: [], state: "error", selectedName: null },
  globals: { viewport: { value: "narrow360", isRotated: false } },
};
