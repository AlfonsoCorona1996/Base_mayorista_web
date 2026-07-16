/// <reference lib="webworker" />

import * as XLSX from "xlsx";

interface ParseRequest {
  type: "parse";
  fileName: string;
  buffer: ArrayBuffer;
}

interface ValidateRequest {
  type: "validate";
  rows: Record<string, unknown>[];
  mapping: ImportMapping;
}

type WorkerRequest = ParseRequest | ValidateRequest;

interface HeaderCandidate {
  rowIndex: number;
  rowNumber: number;
  score: number;
  labels: string[];
}

interface ImportMapping {
  skuColumn: string;
  nameColumns: string[];
  brandColumn: string;
  categoryColumn: string;
  colorColumn: string;
  sizeColumn: string;
  priceCostColumn: string;
  impulsProductIdColumn: string;
  priceCostDiscountPct: number;
  priceClientaMarkupPct: number;
}

interface PreviewRow {
  rowNumber: number;
  sku: string;
  name: string;
  brand_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  category: string | null;
  color: string | null;
  size: string | null;
  impuls_product_id: string | null;
  cklass_model: string | null;
  cklass_color: string | null;
  cklass_size: string | null;
  cklass_barcode: string | null;
  cklass_catalog: string | null;
  cklass_model_display: string | null;
  cklass_product_code: string | null;
  image_key: string | null;
  price_cost_excel: number | null;
  price_cost_discount_pct: number | null;
  price_cost: number | null;
  price_clienta_markup_pct: number | null;
  price_clienta: number | null;
  original_row: Record<string, unknown>;
  valid: boolean;
  issue: string | null;
}

function uniqueHeaders(row: unknown[]): string[] {
  const used = new Map<string, number>();
  return row.map((value, index) => {
    const base = String(value || `Columna ${index + 1}`).trim() || `Columna ${index + 1}`;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count > 0 ? `${base} (${count + 1})` : base;
  });
}

function rowToRecord(headers: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  headers.forEach((header, index) => {
    out[header] = row[index] ?? "";
  });
  return out;
}

function nonEmptyCount(row: unknown[]): number {
  return row.filter((value) => String(value ?? "").trim().length > 0).length;
}

const HEADER_KEYWORDS = [
  "sku",
  "codigo",
  "clave",
  "cod",
  "modelo",
  "producto",
  "descripcion",
  "articulo",
  "nombre",
  "costo",
  "precio",
  "marca",
  "categoria",
  "linea",
  "familia",
  "color",
  "talla",
  "medida",
  "barcode",
  "barra",
  "generico",
  "catalogo",
];

function headerScore(row: unknown[], rowIndex: number): HeaderCandidate | null {
  const labels = row.map((value) => String(value ?? "").trim()).filter(Boolean);
  const nonEmpty = labels.length;
  if (nonEmpty < 2) return null;
  const normalized = labels.map((value) => normalizeHeaderKey(value));
  const keywordHits = normalized.filter((value) => HEADER_KEYWORDS.some((keyword) => value.includes(normalizeHeaderKey(keyword)))).length;
  const numericLike = labels.filter((value) => /^\$?\s*[\d,.]+%?$/.test(value)).length;
  const shortLabels = labels.filter((value) => value.length <= 32).length;
  const score = keywordHits * 12 + nonEmpty * 2 + shortLabels - numericLike * 6 - rowIndex * 0.15;
  if (score <= 0) return null;
  return { rowIndex, rowNumber: rowIndex + 1, score, labels: labels.slice(0, 8) };
}

function detectHeaderCandidates(matrix: unknown[][]): HeaderCandidate[] {
  return matrix
    .slice(0, 40)
    .map((row, index) => headerScore(row, index))
    .filter((candidate): candidate is HeaderCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function nonEmptyRecordCount(row: Record<string, unknown>): number {
  return Object.entries(row).filter(([key, value]) => !key.startsWith("__") && String(value ?? "").trim().length > 0).length;
}

function textFromColumn(row: Record<string, unknown>, column: string): string {
  if (!column) return "";
  return String(row[column] ?? "").trim();
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeHeaderKey(value: unknown): string {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function textFromKnownColumn(row: Record<string, unknown>, aliases: string[]): string {
  const aliasSet = new Set(aliases.map((alias) => normalizeHeaderKey(alias)));
  const key = Object.keys(row).find((header) => aliasSet.has(normalizeHeaderKey(header)));
  return key ? String(row[key] ?? "").trim() : "";
}

function extractCklassFields(row: Record<string, unknown>) {
  const model = textFromKnownColumn(row, ["MODELO", "modelo"]) || null;
  const color = textFromKnownColumn(row, ["COLOR", "color"]) || null;
  const size = textFromKnownColumn(row, ["TALLA", "talla"]) || null;
  const barcode = textFromKnownColumn(row, ["Codigo_Barra", "codigo_barra", "codigo barra", "codigo de barra"]) || null;
  const catalog = textFromKnownColumn(row, ["CATALOGO", "catalogo", "catálogo"]) || null;
  const modelDisplay = model ? model.replace(/-/g, "") : null;
  const cleanBarcode = barcode ? barcode.replace(/\s+/g, "") : "";
  const productCode = cleanBarcode.length > 7 ? cleanBarcode.slice(0, -7) : null;
  const imageKey = model && color && catalog ? `CKLASS|${model}|${color}|${catalog}` : null;

  return {
    cklass_model: model,
    cklass_color: color,
    cklass_size: size,
    cklass_barcode: barcode,
    cklass_catalog: catalog,
    cklass_model_display: modelDisplay,
    cklass_product_code: productCode,
    image_key: imageKey,
  };
}

function numberFromColumn(row: Record<string, unknown>, column: string): { value: number | null; invalid: boolean } {
  const raw = textFromColumn(row, column);
  if (!raw) return { value: null, invalid: false };
  const number = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(number) || number < 0) return { value: null, invalid: true };
  return { value: Number(number.toFixed(2)), invalid: false };
}

function clampPercent(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Number(number.toFixed(2))));
}

function applyDiscount(value: number | null, percent: number): number | null {
  if (value === null) return null;
  return Number(Math.max(0, value * (1 - clampPercent(percent) / 100)).toFixed(2));
}

function applyMarkup(value: number | null, percent: number): number | null {
  if (value === null) return null;
  return Number(Math.max(0, value * (1 + clampPercent(percent) / 100)).toFixed(2));
}

function originalRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__")));
}

function buildPreview(rows: Record<string, unknown>[], mapping: ImportMapping) {
  const skuCounts = new Map<string, number>();
  for (const raw of rows) {
    if (raw["__row_empty"] === true || nonEmptyRecordCount(raw) === 0) continue;
    const sku = textFromColumn(raw, mapping.skuColumn);
    if (!sku) continue;
    const key = sku.toLowerCase();
    skuCounts.set(key, (skuCounts.get(key) || 0) + 1);
  }

  const normalized = rows.map((raw, index): PreviewRow => {
    const rowNumber = Number(raw["__row_number"] || index + 2);
    const rowEmpty = raw["__row_empty"] === true || nonEmptyRecordCount(raw) === 0;
    const sku = textFromColumn(raw, mapping.skuColumn);
    const cklassFields = extractCklassFields(raw);
    const duplicate = sku ? (skuCounts.get(sku.toLowerCase()) || 0) > 1 : false;
    const priceCostExcel = numberFromColumn(raw, mapping.priceCostColumn);
    const priceCostDiscountPct = clampPercent(mapping.priceCostDiscountPct);
    const priceClientaMarkupPct = clampPercent(mapping.priceClientaMarkupPct);
    const priceCost = applyDiscount(priceCostExcel.value, priceCostDiscountPct);
    const priceClienta = applyMarkup(priceCostExcel.value, priceClientaMarkupPct);
    const issue = rowEmpty
      ? "Fila sin datos"
      : !sku
        ? "SKU vacio"
        : duplicate
          ? "SKU duplicado"
          : priceCostExcel.invalid
            ? "Precio costo invalido"
            : null;
    const name = mapping.nameColumns.map((column) => textFromColumn(raw, column)).filter(Boolean).join(" ").trim();
    return {
      rowNumber,
      sku,
      name: rowEmpty ? "Fila sin datos" : name || sku || "Producto sin nombre",
      brand_name: textFromColumn(raw, mapping.brandColumn) || null,
      supplier_id: null,
      supplier_name: null,
      category: textFromColumn(raw, mapping.categoryColumn) || null,
      color: textFromColumn(raw, mapping.colorColumn) || null,
      size: textFromColumn(raw, mapping.sizeColumn) || null,
      impuls_product_id: textFromColumn(raw, mapping.impulsProductIdColumn) || null,
      ...cklassFields,
      price_cost_excel: priceCostExcel.value,
      price_cost_discount_pct: priceCostDiscountPct,
      price_cost: priceCost,
      price_clienta_markup_pct: priceClientaMarkupPct,
      price_clienta: priceClienta,
      original_row: originalRow(raw),
      valid: !issue,
      issue,
    };
  });

  const validRows = normalized.filter((row) => row.valid);
  return {
    rows: normalized,
    sample: normalized.slice(0, 20),
    validRows,
    total: normalized.length,
    valid: validRows.length,
    missingSku: normalized.filter((row) => row.issue === "SKU vacio").length,
    duplicateSku: normalized.filter((row) => row.issue === "SKU duplicado").length,
    invalidValues: normalized.filter((row) => row.issue?.includes("invalido")).length,
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message?.type !== "parse" && message?.type !== "validate") return;

  try {
    if (message.type === "validate") {
      self.postMessage({ ok: true, type: "validate", preview: buildPreview(message.rows || [], message.mapping) });
      return;
    }

    const workbook = XLSX.read(message.buffer, { type: "array", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("El archivo no tiene hojas.");
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
    const headerCandidates = detectHeaderCandidates(matrix);
    const headerIndex = headerCandidates[0]?.rowIndex ?? matrix.findIndex((row) => nonEmptyCount(row) >= 2);
    if (headerIndex < 0) throw new Error("No se detectaron encabezados.");

    const headers = uniqueHeaders(matrix[headerIndex] || []);
    const rawRows = matrix
      .slice(headerIndex + 1)
      .map((row, index) => ({
        ...rowToRecord(headers, row),
        __row_number: headerIndex + index + 2,
        __row_empty: nonEmptyCount(row) === 0,
      }));

    self.postMessage({
      ok: true,
      type: "parse",
      fileName: message.fileName,
      sheetName,
      matrix,
      headerIndex,
      headerCandidates,
      headers,
      rawRows,
    });
  } catch (error: any) {
    self.postMessage({ ok: false, type: message.type, error: error?.message || "No se pudo leer el Excel." });
  }
};
