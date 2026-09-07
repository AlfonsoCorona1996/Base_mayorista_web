import { computeDiscountPctFromPrices, resolveSalesNoteDiscountPct } from "./sales-note-render.service";

describe("descuento derivado de los precios", () => {
  it("calcula el porcentaje efectivo con dos decimales", () => {
    expect(computeDiscountPctFromPrices(740, 518)).toBe(30);
    expect(computeDiscountPctFromPrices(179, 134.25)).toBe(25);
    expect(computeDiscountPctFromPrices(599, 449.25)).toBe(25);
    expect(computeDiscountPctFromPrices(1000, 666.67)).toBe(33.33);
  });

  it("devuelve null cuando no hay descuento que representar", () => {
    expect(computeDiscountPctFromPrices(500, 500)).toBeNull();
    expect(computeDiscountPctFromPrices(400, 500)).toBeNull();
    expect(computeDiscountPctFromPrices(0, 300)).toBeNull();
    expect(computeDiscountPctFromPrices(null, 300)).toBeNull();
    expect(computeDiscountPctFromPrices(740, null)).toBeNull();
  });
});

describe("porcentaje de descuento de la nota", () => {
  it("usa los precios reales aunque el discount_pct guardado diga otra cosa", () => {
    // Cubre Sala Avion 3 Piezas del pedido P-260820-YEEJ72SH0T: se represio a
    // 518 sobre un publico de 740, pero discount_pct se quedo en 25.
    expect(resolveSalesNoteDiscountPct(25, 740, 518)).toBe(30);
  });

  it("deriva el porcentaje cuando no hay valor guardado", () => {
    expect(resolveSalesNoteDiscountPct(null, 179, 134.25)).toBe(25);
    expect(resolveSalesNoteDiscountPct(null, 769, 576.75)).toBe(25);
    expect(resolveSalesNoteDiscountPct(undefined, 599, 449.25)).toBe(25);
  });

  it("cae al valor guardado solo cuando no hay precio publico del cual derivar", () => {
    expect(resolveSalesNoteDiscountPct(25, null, 518)).toBe(25);
    expect(resolveSalesNoteDiscountPct("15", 0, 518)).toBe(15);
  });

  it("no inventa descuento cuando el precio publico no es mayor al de clienta", () => {
    expect(resolveSalesNoteDiscountPct(null, 500, 500)).toBeNull();
    expect(resolveSalesNoteDiscountPct(null, 400, 500)).toBeNull();
    expect(resolveSalesNoteDiscountPct(0, 500, 500)).toBeNull();
  });

  it("redondea a entero para la pastilla, sin caer nunca en cero", () => {
    expect(resolveSalesNoteDiscountPct(null, 1000, 666.67)).toBe(33);
    // 1000 -> 998 redondea a 0; mostrar "-0%" seria peor que redondear a 1.
    expect(resolveSalesNoteDiscountPct(null, 1000, 998)).toBe(1);
  });
});
