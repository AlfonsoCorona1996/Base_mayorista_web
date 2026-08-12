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
        desktop1024: {
          name: "Desktop 1024 × 768",
          styles: { width: "1024px", height: "768px" },
          type: "desktop",
        },
        desktop1440: {
          name: "Desktop 1440 × 900",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
      },
    },
    a11y: {
      test: "error",
    },
  },
};

export default preview;
