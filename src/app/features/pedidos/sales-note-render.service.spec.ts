import { salesNoteLogoUrl } from "./sales-note-render.service";

describe("salesNoteLogoUrl", () => {
  it("uses the Catalogo logo for Catalogo sales notes", () => {
    expect(salesNoteLogoUrl("catalogo")).toBe("/logo%20catalogo.png");
  });

  it("keeps the Base Mayorista logo for BM and legacy notes", () => {
    expect(salesNoteLogoUrl("bm")).toBe("/BaseMayoristaLogo.png");
    expect(salesNoteLogoUrl(undefined)).toBe("/BaseMayoristaLogo.png");
  });
});
