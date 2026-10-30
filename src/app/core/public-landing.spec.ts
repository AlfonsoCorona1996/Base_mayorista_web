import { isLightweightPublicPath } from "./public-landing";

describe("isLightweightPublicPath", () => {
  it("reconoce la encuesta de aniversario con o sin barra final", () => {
    expect(isLightweightPublicPath("/aniversario")).toBeTrue();
    expect(isLightweightPublicPath("/aniversario/")).toBeTrue();
    expect(isLightweightPublicPath("/Aniversario")).toBeTrue();
  });

  it("no afecta al panel ni a otras páginas", () => {
    expect(isLightweightPublicPath("/")).toBeFalse();
    expect(isLightweightPublicPath("/main/dashboard")).toBeFalse();
    expect(isLightweightPublicPath("/aniversarios")).toBeFalse();
    expect(isLightweightPublicPath("/track/abc")).toBeFalse();
  });
});
