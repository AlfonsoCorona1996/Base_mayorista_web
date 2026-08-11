import type { Preview } from "@storybook/angular";

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: "^(cancel|apply|.*Change)$" },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: "centered",
    viewport: {
      options: {
        mobile390: {
          name: "Mobile 390 × 844",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        narrow360: {
          name: "Mobile 360 × 800",
          styles: { width: "360px", height: "800px" },
          type: "mobile",
        },
        tablet768: {
          name: "Tablet 768 × 1024",
          styles: { width: "768px", height: "1024px" },
          type: "tablet",
        },
      },
    },
    a11y: {
      test: "error",
    },
  },
};

export default preview;
