export type CatalogIdentifierType =
  | "barcode"
  | "supplier_sku"
  | "supplier_variant"
  | "generic"
  | "internet"
  | "model"
  | "style"
  | "bundle"
  | "ocr_alias"
  | "custom";

export type CatalogIdentifierScope = "variant" | "group" | "bundle";

export interface CatalogImportIdentifier {
  type: CatalogIdentifierType;
  value: string;
  normalized_value: string;
  scope: CatalogIdentifierScope;
  primary?: boolean;
  indexable: boolean;
  validation_issue?: string | null;
  source_column: string;
}

export type PriceRuleMode = "direct" | "formula";
export type PriceRuleBase = "column" | "cost";
export type PricePercentOperation = "none" | "discount" | "markup";
export type PricePercentSource = "fixed" | "column";
export type PriceAmountOperation = "none" | "add" | "subtract";
export type PriceAmountSource = "fixed" | "column";
export type PriceRounding = "none" | "integer" | "0.05" | "0.10" | "0.50";

export interface CatalogPriceRule {
  mode: PriceRuleMode;
  base: PriceRuleBase;
  sourceColumn: string;
  fallbackColumns: string[];
  percentOperation: PricePercentOperation;
  percentSource: PricePercentSource;
  percentValue: number;
  percentColumn: string;
  amountOperation: PriceAmountOperation;
  amountSource: PriceAmountSource;
  amountValue: number;
  amountColumn: string;
  rounding: PriceRounding;
}

export interface CatalogImportMappingV2 {
  skuColumn: string;
  primaryBarcodeColumn: string;
  alternateBarcodeColumns: string[];
  supplierSkuColumn: string;
  supplierVariantColumn: string;
  genericColumn: string;
  internetColumn: string;
  modelColumn: string;
  styleColumn: string;
  bundleColumn: string;
  ocrAliasColumns: string[];
  customIdentifierColumns: string[];
  nameColumns: string[];
  brandColumn: string;
  categoryColumn: string;
  colorColumn: string;
  sizeColumn: string;
  impulsProductIdColumn: string;
  priceCostColumn: string;
  priceCostDiscountPct: number;
  priceClientaMarkupPct: number;
  costRule: CatalogPriceRule;
  clientaRule: CatalogPriceRule;
}

export interface EvaluatedPrice {
  value: number | null;
  sourceValue: number | null;
  issue: string | null;
  warnings: string[];
}

export interface CatalogImportV2RowFields {
  primary_barcode: string | null;
  supplier_sku: string | null;
  identifiers: CatalogImportIdentifier[];
  prices: {
    cost: number;
    clienta: number | null;
  };
  import_profile_version: 2;
}

export function emptyPriceRule(base: PriceRuleBase = "column"): CatalogPriceRule {
  return {
    mode: "direct",
    base,
    sourceColumn: "",
    fallbackColumns: [],
    percentOperation: "none",
    percentSource: "fixed",
    percentValue: 0,
    percentColumn: "",
    amountOperation: "none",
    amountSource: "fixed",
    amountValue: 0,
    amountColumn: "",
    rounding: "none",
  };
}

export function normalizeIdentifierValue(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeIdentifierKey(value: unknown): string {
  return normalizeIdentifierValue(value).toUpperCase().replace(/\s+/g, "");
}

export function barcodeValidationIssue(value: string): string | null {
  const normalized = normalizeIdentifierKey(value);
  if (!normalized || normalized === "PENDIENTE") return "Código pendiente; se conserva como evidencia pero no se indexa";
  if (!/^\d+$/.test(normalized)) return "El código de barras debe contener solo dígitos";
  if (![8, 12, 13, 14].includes(normalized.length)) return "Longitud no compatible con GTIN (8, 12, 13 o 14 dígitos)";
  const digits = normalized.split("").map(Number);
  const check = digits.pop() ?? 0;
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? null : "Dígito verificador GTIN inválido";
}

function parseNumber(value: unknown): { value: number | null; invalid: boolean } {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, invalid: false };
  const parsed = Number(raw.replace(/[$,\s]/g, "").replace(/%$/, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return { value: null, invalid: true };
  return { value: parsed, invalid: false };
}

function roundPrice(value: number, rounding: PriceRounding): number {
  const step = rounding === "integer" ? 1 : rounding === "none" ? 0.01 : Number(rounding);
  return Number((Math.round(value / step) * step).toFixed(2));
}

export function evaluatePriceRule(
  row: Record<string, unknown>,
  rule: CatalogPriceRule,
  cost: number | null,
  label: string,
): EvaluatedPrice {
  let sourceValue: number | null = null;
  const warnings: string[] = [];
  if (rule.base === "cost") {
    sourceValue = cost;
  } else {
    const columns = [rule.sourceColumn, ...(rule.fallbackColumns || [])].filter(Boolean);
    for (const column of columns) {
      const parsed = parseNumber(row[column]);
      if (parsed.invalid) {
        warnings.push(`${label}: se ignoró un valor inválido en ${column}`);
        continue;
      }
      if (parsed.value !== null) {
        sourceValue = parsed.value;
        break;
      }
    }
  }
  if (sourceValue === null) return { value: null, sourceValue: null, issue: `${label}: falta una base numérica`, warnings };

  let value = sourceValue;
  if (rule.mode === "formula" && rule.percentOperation !== "none") {
    const parsedPercent = rule.percentSource === "column"
      ? parseNumber(row[rule.percentColumn])
      : { value: Number(rule.percentValue || 0), invalid: false };
    if (parsedPercent.invalid || parsedPercent.value === null) {
      return { value: null, sourceValue, issue: `${label}: porcentaje inválido o vacío`, warnings };
    }
    const percent = Math.max(0, parsedPercent.value) / 100;
    value *= rule.percentOperation === "discount" ? 1 - percent : 1 + percent;
  }
  if (rule.mode === "formula" && rule.amountOperation !== "none") {
    const parsedAmount = rule.amountSource === "column"
      ? parseNumber(row[rule.amountColumn])
      : { value: Number(rule.amountValue || 0), invalid: false };
    if (parsedAmount.invalid || parsedAmount.value === null) {
      return { value: null, sourceValue, issue: `${label}: importe fijo inválido o vacío`, warnings };
    }
    value += rule.amountOperation === "subtract" ? -parsedAmount.value : parsedAmount.value;
  }
  if (!Number.isFinite(value) || value < 0) return { value: null, sourceValue, issue: `${label}: el resultado no es válido`, warnings };
  return { value: roundPrice(value, rule.rounding), sourceValue, issue: null, warnings };
}

export function identifierFromColumn(
  row: Record<string, unknown>,
  column: string,
  type: CatalogIdentifierType,
  scope: CatalogIdentifierScope,
  primary = false,
): CatalogImportIdentifier | null {
  if (!column) return null;
  const value = normalizeIdentifierValue(row[column]);
  if (!value) return null;
  const validationIssue = type === "barcode" ? barcodeValidationIssue(value) : null;
  return {
    type,
    value,
    normalized_value: normalizeIdentifierKey(value),
    scope,
    primary,
    indexable: validationIssue === null,
    validation_issue: validationIssue,
    source_column: column,
  };
}

export function buildIdentifiers(row: Record<string, unknown>, mapping: CatalogImportMappingV2): CatalogImportIdentifier[] {
  const identifiers = [
    identifierFromColumn(row, mapping.primaryBarcodeColumn, "barcode", "variant", true),
    ...mapping.alternateBarcodeColumns.map((column) => identifierFromColumn(row, column, "barcode", "variant")),
    identifierFromColumn(row, mapping.supplierSkuColumn, "supplier_sku", "variant"),
    identifierFromColumn(row, mapping.supplierVariantColumn, "supplier_variant", "variant"),
    identifierFromColumn(row, mapping.genericColumn, "generic", "group"),
    identifierFromColumn(row, mapping.internetColumn, "internet", "group"),
    identifierFromColumn(row, mapping.modelColumn, "model", "group"),
    identifierFromColumn(row, mapping.styleColumn, "style", "group"),
    identifierFromColumn(row, mapping.bundleColumn, "bundle", "bundle"),
    ...mapping.ocrAliasColumns.map((column) => identifierFromColumn(row, column, "ocr_alias", "variant")),
    ...mapping.customIdentifierColumns.map((column) => identifierFromColumn(row, column, "custom", "variant")),
  ].filter((identifier): identifier is CatalogImportIdentifier => identifier !== null);

  const seen = new Set<string>();
  return identifiers.filter((identifier) => {
    const key = `${identifier.type}|${identifier.normalized_value}|${identifier.scope}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
