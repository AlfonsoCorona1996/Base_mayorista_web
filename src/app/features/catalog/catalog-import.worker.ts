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

interface ImportMapping {
  skuColumn: string;
  nameColumns: string[];
  supplierColumn: string;
  categoryColumn: string;
  colorColumn: string;
  sizeColumn: string;
  priceCostColumn: string;
  priceClientaColumn: string;
  stockColumn: string;
  imageColumn: string;
  notesColumn: string;
}

interface PreviewRow {
  rowNumber: number;
  sku: string;
  name: string;
  supplier_name: string | null;
  category: string | null;
  color: string | null;
  size: string | null;
  price_cost: number | null;
  price_clienta: number | null;
  stock_qty: number | null;
  image_url: string | null;
  notes: string | null;
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

function nonEmptyRecordCount(row: Record<string, unknown>): number {
  return Object.entries(row).filter(([key, value]) => !key.startsWith("__") && String(value ?? "").trim().length > 0).length;
}

function textFromColumn(row: Record<string, unknown>, column: string): string {
  if (!column) return "";
  return String(row[column] ?? "").trim();
}

function numberFromColumn(row: Record<string, unknown>, column: string): { value: number | null; invalid: boolean } {
  const raw = textFromColumn(row, column);
  if (!raw) return { value: null, invalid: false };
  const number = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(number) || number < 0) return { value: null, invalid: true };
  return { value: Number(number.toFixed(2)), invalid: false };
}

function integerFromColumn(row: Record<string, unknown>, column: string): { value: number | null; invalid: boolean } {
  const parsed = numberFromColumn(row, column);
  if (parsed.invalid || parsed.value === null) return parsed;
  return { value: Math.trunc(parsed.value), invalid: false };
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
    const duplicate = sku ? (skuCounts.get(sku.toLowerCase()) || 0) > 1 : false;
    const priceCost = numberFromColumn(raw, mapping.priceCostColumn);
    const priceClienta = numberFromColumn(raw, mapping.priceClientaColumn);
    const stock = integerFromColumn(raw, mapping.stockColumn);
    const issue = rowEmpty
      ? "Fila sin datos"
      : !sku
        ? "SKU vacio"
        : duplicate
          ? "SKU duplicado"
          : priceCost.invalid
            ? "Precio costo invalido"
            : priceClienta.invalid
              ? "Precio venta invalido"
              : stock.invalid
                ? "Stock invalido"
                : null;
    const name = mapping.nameColumns.map((column) => textFromColumn(raw, column)).filter(Boolean).join(" ").trim();
    return {
      rowNumber,
      sku,
      name: rowEmpty ? "Fila sin datos" : name || sku || "Producto sin nombre",
      supplier_name: textFromColumn(raw, mapping.supplierColumn) || null,
      category: textFromColumn(raw, mapping.categoryColumn) || null,
      color: textFromColumn(raw, mapping.colorColumn) || null,
      size: textFromColumn(raw, mapping.sizeColumn) || null,
      price_cost: priceCost.value,
      price_clienta: priceClienta.value,
      stock_qty: stock.value,
      image_url: textFromColumn(raw, mapping.imageColumn) || null,
      notes: textFromColumn(raw, mapping.notesColumn) || null,
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
    const headerIndex = matrix.findIndex((row) => nonEmptyCount(row) >= 2);
    if (headerIndex < 0) throw new Error("No se detectaron encabezados.");

    const headers = uniqueHeaders(matrix[headerIndex] || []);
    const rawRows = matrix
      .slice(headerIndex + 1)
      .map((row, index) => ({
        ...rowToRecord(headers, row),
        __row_number: headerIndex + index + 2,
        __row_empty: nonEmptyCount(row) === 0,
      }));

    self.postMessage({ ok: true, type: "parse", fileName: message.fileName, headers, rawRows });
  } catch (error: any) {
    self.postMessage({ ok: false, type: message.type, error: error?.message || "No se pudo leer el Excel." });
  }
};
