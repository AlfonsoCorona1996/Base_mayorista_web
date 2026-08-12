import type { Meta, StoryObj } from "@storybook/angular";
import { AddItemProductExperienceComponent } from "./add-item-product-experience.component";
import type { ProductSelectionImage } from "./add-item-product-selection.component";

function productImage(id: string, background: string, accent: string, label: string, color: string | null): ProductSelectionImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="360" height="300" viewBox="0 0 360 300">
      <rect width="360" height="300" rx="28" fill="${background}"/>
      <ellipse cx="182" cy="235" rx="122" ry="20" fill="#0f172a" opacity=".12"/>
      <path d="M76 188c38-5 67-34 93-77 9-15 29-18 42-8l65 50c11 8 17 21 16 35l-2 23H87c-20 0-27-20-11-23Z" fill="${accent}"/>
      <path d="M123 171c34 3 75-3 116-18" fill="none" stroke="#fff" stroke-width="18" stroke-linecap="round" opacity=".86"/>
      <path d="M92 213h198" stroke="#0f172a" stroke-width="12" stroke-linecap="round" opacity=".78"/>
      <circle cx="202" cy="103" r="18" fill="#fbbf24"/>
      <text x="180" y="276" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#334155">${label}</text>
    </svg>`;
  return {
    id,
    label,
    color,
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
  };
}

const images: readonly ProductSelectionImage[] = [
  productImage("rosa", "#fff1f2", "#f472b6", "Rosa frontal", "Rosa"),
  productImage("rosa-lateral", "#fdf2f8", "#ec4899", "Rosa lateral", "Rosa"),
  productImage("rosa-detalle", "#fff7ed", "#fb7185", "Detalle rosa", "Rosa"),
  productImage("negro", "#f1f5f9", "#334155", "Negro", "Negro"),
  productImage("azul", "#eff6ff", "#60a5fa", "Azul cielo", "Azul cielo"),
  productImage("verde", "#ecfdf5", "#34d399", "Verde menta", "Verde menta"),
  productImage("detalle-suela", "#f8fafc", "#94a3b8", "Detalle de suela", null),
  productImage("empaque", "#fffbeb", "#d97706", "Empaque del producto", null),
];

const meta: Meta<AddItemProductExperienceComponent> = {
  title: "Pedidos/Agregar producto/Experiencia completa",
  component: AddItemProductExperienceComponent,
  tags: ["autodocs"],
  args: {
    productImages: images,
    initialSource: "catalogo",
    focusOnLoad: true,
    optionEditorInitiallyOpen: false,
    imageGalleryInitiallyOpen: false,
    discountInitiallyOpen: false,
    longProductTitle: false,
  },
  argTypes: {
    initialState: {
      control: "select",
      options: ["search", "loading", "results", "selected", "duplicate", "saving", "error", "success", "empty"],
    },
    initialSource: {
      control: "select",
      options: ["catalogo", "inventario", "manual"],
    },
  },
  parameters: {
    docs: {
      description: {
        component:
          "Prototipo interactivo del flujo completo para agregar productos. Incluye foco inicial, búsqueda, escáner, " +
          "un resultado por producto, talla y color elegidos dentro del card, imagen ampliable, opción fuera de catálogo, " +
          "galería filtrable con imágenes sin asignar, duplicados, progreso, error y éxito. " +
          "La opción provisional no modifica el catálogo: queda ligada al pedido y pendiente de revisión.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<AddItemProductExperienceComponent>;

export const BusquedaConFoco: Story = {
  args: {
    initialState: "search",
  },
};

export const Buscando: Story = {
  args: {
    initialState: "loading",
  },
};

export const Resultados: Story = {
  args: {
    initialState: "results",
  },
};

export const ProductoSeleccionado: Story = {
  args: {
    initialState: "selected",
  },
};

export const CambiarDescuentoPrecioClienta: Story = {
  args: {
    initialState: "selected",
    discountInitiallyOpen: true,
  },
};

export const InventarioSinOpcionProvisional: Story = {
  args: {
    initialState: "selected",
    initialSource: "inventario",
  },
};

export const AgregarTallaOColor: Story = {
  args: {
    initialState: "selected",
    optionEditorInitiallyOpen: true,
  },
};

export const GaleriaDeImagenesGuardadas: Story = {
  args: {
    initialState: "selected",
    optionEditorInitiallyOpen: true,
    imageGalleryInitiallyOpen: true,
  },
};

export const ProductoDuplicado: Story = {
  args: {
    initialState: "duplicate",
  },
};

export const Guardando: Story = {
  args: {
    initialState: "saving",
  },
};

export const ErrorRecuperable: Story = {
  args: {
    initialState: "error",
  },
};

export const ExitoCapturaContinua: Story = {
  args: {
    initialState: "success",
  },
};

export const SinResultados: Story = {
  args: {
    initialState: "empty",
  },
};

export const Mobile390OpcionProvisional: Story = {
  args: {
    initialState: "selected",
    optionEditorInitiallyOpen: true,
  },
  parameters: {
    viewport: { defaultViewport: "mobile390" },
  },
};

export const Mobile360CambiarDescuento: Story = {
  args: {
    initialState: "selected",
    discountInitiallyOpen: true,
  },
  parameters: {
    viewport: { defaultViewport: "narrow360" },
  },
};

export const Mobile390GaleriaDeImagenes: Story = {
  args: {
    initialState: "selected",
    optionEditorInitiallyOpen: true,
    imageGalleryInitiallyOpen: true,
  },
  parameters: {
    viewport: { defaultViewport: "mobile390" },
  },
};

export const Narrow360ContenidoLargo: Story = {
  args: {
    initialState: "selected",
    optionEditorInitiallyOpen: true,
    longProductTitle: true,
  },
  parameters: {
    viewport: { defaultViewport: "narrow360" },
  },
};

export const Tablet768ProductoSeleccionado: Story = {
  args: {
    initialState: "selected",
  },
  parameters: {
    viewport: { defaultViewport: "tablet768" },
  },
};

export const Desktop1024Resultados: Story = {
  args: {
    initialState: "results",
  },
  parameters: {
    viewport: { defaultViewport: "desktop1024" },
  },
};

export const Desktop1440OpcionProvisional: Story = {
  args: {
    initialState: "selected",
    optionEditorInitiallyOpen: true,
  },
  parameters: {
    viewport: { defaultViewport: "desktop1440" },
  },
};
