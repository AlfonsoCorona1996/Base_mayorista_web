import {
  CatalogImportMappingV2,
  barcodeValidationIssue,
  buildIdentifiers,
  emptyPriceRule,
  evaluatePriceRule,
} from "./catalog-import-v2.types";

function mapping(): CatalogImportMappingV2 {
  return {
    skuColumn: "",
    primaryBarcodeColumn: "Codigo_Barra",
    alternateBarcodeColumns: ["SKU OPC 2"],
    supplierSkuColumn: "SKU NAZAN",
    supplierVariantColumn: "VARIANTE",
    genericColumn: "GENERICO",
    internetColumn: "CÓD. INTERNET",
    modelColumn: "MODELO",
    styleColumn: "ESTILO",
    bundleColumn: "COMBOID",
    ocrAliasColumns: [],
    customIdentifierColumns: [],
    nameColumns: [],
    brandColumn: "",
    categoryColumn: "",
    colorColumn: "COLOR",
    sizeColumn: "TALLA",
    impulsProductIdColumn: "",
    priceCostColumn: "",
    priceCostDiscountPct: 0,
    priceClientaMarkupPct: 0,
    costRule: emptyPriceRule(),
    clientaRule: emptyPriceRule("cost"),
  };
}

describe("contratos de importación de catálogo v2", () => {
  it("conserva ceros iniciales y valida GTIN sin convertir códigos a número", () => {
    expect(barcodeValidationIssue("0059310781000")).toBeNull();
    expect(barcodeValidationIssue("PENDIENTE")).not.toBeNull();
  });

  it("clasifica cada código en su alcance correcto", () => {
    const identifiers = buildIdentifiers({
      Codigo_Barra: "0059310781000",
      "SKU OPC 2": "3332194192924",
      "SKU NAZAN": "205000449728",
      VARIANTE: "18332701",
      GENERICO: "183327",
      "CÓD. INTERNET": "866893",
      MODELO: "059-33",
      ESTILO: "10321",
      COMBOID: "COM184",
    }, mapping());

    expect(identifiers.find((entry) => entry.value === "205000449728")?.type).toBe("supplier_sku");
    expect(identifiers.find((entry) => entry.type === "generic")?.scope).toBe("group");
    expect(identifiers.find((entry) => entry.type === "bundle")?.scope).toBe("bundle");
    expect(identifiers.find((entry) => entry.value === "0059310781000")?.indexable).toBeTrue();
  });

  it("evalúa descuento por columna, ajuste fijo y redondeo", () => {
    const rule = emptyPriceRule("column");
    Object.assign(rule, {
      mode: "formula" as const,
      sourceColumn: "PRECIO",
      percentOperation: "discount" as const,
      percentSource: "column" as const,
      percentColumn: "DESCUENTO",
      amountOperation: "add" as const,
      amountSource: "fixed" as const,
      amountValue: 10,
      rounding: "0.50" as const,
    });

    expect(evaluatePriceRule({ PRECIO: "$199.00", DESCUENTO: "30" }, rule, null, "Costo").value)
      .toBe(149.5);
  });

  it("mantiene el cero como número para que la validación de costo pueda rechazarlo", () => {
    const rule = emptyPriceRule("column");
    rule.sourceColumn = "COSTO";
    expect(evaluatePriceRule({ COSTO: 0 }, rule, null, "Costo").value).toBe(0);
  });

  it("no requiere una regla de precio final: el mapeo solo trae costo y clienta", () => {
    const built = mapping();
    expect(built.costRule).toBeDefined();
    expect(built.clientaRule).toBeDefined();
    expect((built as unknown as Record<string, unknown>)["finalRule"]).toBeUndefined();

    const clienta = evaluatePriceRule({}, built.clientaRule, 100, "Precio clienta");
    expect(clienta.value).toBe(100);
  });
});
