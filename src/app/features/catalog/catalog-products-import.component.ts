import { CurrencyPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  CatalogProduct,
  CatalogProductImportRow,
  CatalogProductsService,
} from "../../core/catalog-products.service";
import { CatalogImportJobsService } from "../../core/catalog-import-jobs.service";
import { Supplier, SuppliersService } from "../../core/suppliers.service";

type MappingKey =
  | "skuColumn"
  | "brandColumn"
  | "categoryColumn"
  | "colorColumn"
  | "sizeColumn"
  | "priceCostColumn";

type PercentMappingKey = "priceCostDiscountPct" | "priceClientaMarkupPct";

interface ImportMapping {
  skuColumn: string;
  nameColumns: string[];
  brandColumn: string;
  categoryColumn: string;
  colorColumn: string;
  sizeColumn: string;
  priceCostColumn: string;
  priceCostDiscountPct: number;
  priceClientaMarkupPct: number;
}

interface PreviewRow extends CatalogProductImportRow {
  rowNumber: number;
  valid: boolean;
  issue: string | null;
}

interface PreviewSummary {
  rows: PreviewRow[];
  sample: PreviewRow[];
  validRows: PreviewRow[];
  total: number;
  valid: number;
  missingSku: number;
  duplicateSku: number;
  invalidValues: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-catalog-products-import",
  imports: [FormsModule, CurrencyPipe],
  templateUrl: "./catalog-products-import.component.html",
  styleUrl: "./catalog-products-import.component.css",
})
export class CatalogProductsImportComponent implements OnDestroy {
  private catalogProducts = inject(CatalogProductsService);
  private suppliers = inject(SuppliersService);
  readonly importJobs = inject(CatalogImportJobsService);

  loading = signal(false);
  parsing = signal(false);
  importing = signal(false);
  importModalOpen = signal(false);
  supplierPickerError = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  fileName = signal("");
  selectedSupplierId = signal("");
  headers = signal<string[]>([]);
  rawRows = signal<Record<string, unknown>[]>([]);
  search = signal("");
  mapping = signal<ImportMapping>(this.emptyMapping());
  validating = signal(false);
  private previewState = signal<PreviewSummary>(this.emptyPreview());
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private validationRun = 0;
  private destroyed = false;

  products = computed(() => {
    return this.catalogProducts.catalogoPageProducts();
  });

  pageState = computed(() => this.catalogProducts.pageState());

  preview = computed(() => this.previewState());

  catalogSuppliers = computed(() => this.suppliers.getActiveByBusiness("catalogo"));
  selectedSupplier = computed<Supplier | null>(() =>
    this.catalogSuppliers().find((supplier) => supplier.supplier_id === this.selectedSupplierId()) || null,
  );

  rejectedRows = computed(() => this.preview().rows.filter((row) => !row.valid));
  canImport = computed(() => Boolean(this.mapping().skuColumn) && Boolean(this.selectedSupplier()) && this.preview().valid > 0 && !this.validating() && !this.importing());

  constructor() {
    this.importJobs.watch();
    this.suppliers.loadFromFirestore().catch(() => null);
    this.catalogProducts.watchCatalogPage({ businessId: "catalogo" });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.catalogProducts.stopWatchingPage();
  }

  async reload(): Promise<void> {
    this.error.set(null);
    this.catalogProducts.watchCatalogPage({ businessId: "catalogo", searchSku: this.search() });
  }

  openImportModal(): void {
    this.error.set(null);
    this.success.set(null);
    this.supplierPickerError.set(null);
    this.importModalOpen.set(true);
  }

  closeImportModal(): void {
    if (this.parsing() || this.importing()) return;
    this.importModalOpen.set(false);
    this.supplierPickerError.set(null);
  }

  onSupplierSelected(supplierId: string): void {
    this.selectedSupplierId.set(supplierId);
    this.supplierPickerError.set(null);
    if (this.rawRows().length > 0) this.schedulePreviewValidation();
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] || null;
    input.value = "";
    if (!file) return;
    if (!this.selectedSupplier()) {
      this.supplierPickerError.set("Elige el proveedor padre de este catalogo antes de cargar el Excel.");
      return;
    }

    this.error.set(null);
    this.success.set(null);
    this.supplierPickerError.set(null);
    this.fileName.set(file.name);

    this.parsing.set(true);
    try {
      const parsed = await this.parseExcelFile(file);
      this.headers.set(parsed.headers);
      this.rawRows.set(parsed.rawRows);
      this.mapping.set(this.autodetectMapping(parsed.headers));
      this.previewState.set(this.emptyPreview());
      this.importModalOpen.set(false);
      this.schedulePreviewValidation(0);
    } catch (error: any) {
      this.headers.set([]);
      this.rawRows.set([]);
      this.mapping.set(this.emptyMapping());
      this.previewState.set(this.emptyPreview());
      this.error.set(error?.message || "No se pudo leer el Excel.");
    } finally {
      this.parsing.set(false);
    }
  }

  setMappingField(field: MappingKey, value: string): void {
    this.mapping.update((current) => ({ ...current, [field]: value }));
    this.schedulePreviewValidation();
  }

  setPercentField(field: PercentMappingKey, value: number | string): void {
    this.mapping.update((current) => ({ ...current, [field]: this.clampPercent(value) }));
    this.schedulePreviewValidation();
  }

  toggleNameColumn(column: string, checked: boolean): void {
    this.mapping.update((current) => {
      const set = new Set(current.nameColumns);
      if (checked) set.add(column);
      else set.delete(column);
      return { ...current, nameColumns: [...set] };
    });
    this.schedulePreviewValidation();
  }

  isNameColumnSelected(column: string): boolean {
    return this.mapping().nameColumns.includes(column);
  }

  async importValidRows(): Promise<void> {
    if (!this.canImport()) return;
    const supplier = this.selectedSupplier();
    if (!supplier) {
      this.supplierPickerError.set("Elige el proveedor padre de este catalogo antes de importar.");
      this.importModalOpen.set(true);
      return;
    }
    this.importing.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const mapping = this.mapping();
      const validRows = this.preview().validRows.map((row) => this.toImportRow(row));
      const job = await this.importJobs.createJob({
        business_id: "catalogo",
        file_name: this.fileName() || "catalogo.xlsx",
        total_rows: this.preview().total,
        valid_rows: validRows.length,
        rejected_rows: this.rejectedRows().length,
        supplier_id: supplier.supplier_id,
        supplier_name: supplier.display_name,
        price_cost_discount_pct: mapping.priceCostDiscountPct,
        price_clienta_markup_pct: mapping.priceClientaMarkupPct,
      });
      const chunkSize = 400;
      for (let start = 0, chunkIndex = 0; start < validRows.length; start += chunkSize, chunkIndex += 1) {
        const chunk = validRows.slice(start, start + chunkSize);
        const finalChunk = start + chunkSize >= validRows.length;
        await this.importJobs.uploadChunk(job.job_id, chunk, chunkIndex, finalChunk);
        await this.yieldToBrowser();
      }
      this.success.set(`Importacion lista: ${validRows.length} producto(s).`);
      this.catalogProducts.watchCatalogPage({ businessId: "catalogo", searchSku: this.search() });
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo importar el archivo.");
    } finally {
      this.importing.set(false);
    }
  }

  productStockLabel(product: CatalogProduct): string {
    if (product.stock_qty === null || product.stock_qty === undefined) return "Sin stock";
    if (product.stock_qty <= 0) return "Agotado";
    return `${product.stock_qty} pza(s)`;
  }

  onSearchChange(value: string): void {
    this.search.set(value);
    this.catalogProducts.watchCatalogPage({ businessId: "catalogo", searchSku: value });
  }

  loadMoreProducts(): void {
    void this.catalogProducts.loadMoreCatalogPage({ businessId: "catalogo", searchSku: this.search() });
  }

  private async parseExcelFile(file: File): Promise<{ headers: string[]; rawRows: Record<string, unknown>[] }> {
    const buffer = await file.arrayBuffer();
    if (typeof Worker !== "undefined") {
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./catalog-import.worker", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<any>) => {
          worker.terminate();
          if (event.data?.ok) {
            resolve({ headers: event.data.headers || [], rawRows: event.data.rawRows || [] });
          } else {
            reject(new Error(event.data?.error || "No se pudo leer el Excel."));
          }
        };
        worker.onerror = (event) => {
          worker.terminate();
          reject(new Error(event.message || "No se pudo leer el Excel."));
        };
        worker.postMessage({ type: "parse", fileName: file.name, buffer }, [buffer]);
      });
    }

    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("El archivo no tiene hojas.");
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
    const headerIndex = matrix.findIndex((row) => this.nonEmptyCount(row) >= 2);
    if (headerIndex < 0) throw new Error("No se detectaron encabezados.");
    const headers = this.uniqueHeaders(matrix[headerIndex] || []);
    const rawRows = matrix
      .slice(headerIndex + 1)
      .map((row, index) => ({
        ...this.rowToRecord(headers, row),
        __row_number: headerIndex + index + 2,
        __row_empty: this.nonEmptyCount(row) === 0,
      }));
    return { headers, rawRows };
  }

  private yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  private schedulePreviewValidation(delay = 100): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.rawRows().length === 0) {
      this.previewState.set(this.emptyPreview());
      this.validating.set(false);
      return;
    }

    this.validating.set(true);
    const run = ++this.validationRun;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      void this.validatePreview(run);
    }, delay);
  }

  private async validatePreview(run: number): Promise<void> {
    const rows = this.rawRows();
    const mapping = this.mapping();
    if (rows.length === 0) {
      if (this.isLatestValidation(run)) {
        this.previewState.set(this.emptyPreview());
        this.validating.set(false);
      }
      return;
    }

    try {
      const preview = await this.buildPreviewInWorker(rows, mapping);
      if (this.isLatestValidation(run)) this.previewState.set(preview);
    } catch {
      if (this.isLatestValidation(run)) this.previewState.set(this.buildPreview(rows, mapping));
    } finally {
      if (this.isLatestValidation(run)) this.validating.set(false);
    }
  }

  private isLatestValidation(run: number): boolean {
    return !this.destroyed && run === this.validationRun;
  }

  private buildPreviewInWorker(rows: Record<string, unknown>[], mapping: ImportMapping): Promise<PreviewSummary> {
    if (typeof Worker === "undefined") return Promise.resolve(this.buildPreview(rows, mapping));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./catalog-import.worker", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<any>) => {
        worker.terminate();
        if (event.data?.ok) {
          resolve(event.data.preview as PreviewSummary);
        } else {
          reject(new Error(event.data?.error || "No se pudo validar el Excel."));
        }
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || "No se pudo validar el Excel."));
      };
      worker.postMessage({ type: "validate", rows, mapping });
    });
  }

  private buildPreview(rows: Record<string, unknown>[], mapping: ImportMapping): PreviewSummary {
    const skuCounts = new Map<string, number>();
    for (const raw of rows) {
      if (raw["__row_empty"] === true || this.nonEmptyRecordCount(raw) === 0) continue;
      const sku = this.textFromColumn(raw, mapping.skuColumn);
      if (!sku) continue;
      const key = sku.toLowerCase();
      skuCounts.set(key, (skuCounts.get(key) || 0) + 1);
    }

    const normalized = rows.map((raw, idx): PreviewRow => {
      const rowNumber = Number(raw["__row_number"] || idx + 2);
      const rowEmpty = raw["__row_empty"] === true || this.nonEmptyRecordCount(raw) === 0;
      const sku = this.textFromColumn(raw, mapping.skuColumn);
      const duplicate = sku ? (skuCounts.get(sku.toLowerCase()) || 0) > 1 : false;
      const priceCostExcel = this.numberFromColumn(raw, mapping.priceCostColumn);
      const priceCost = this.applyDiscount(priceCostExcel.value, mapping.priceCostDiscountPct);
      const priceClienta = this.applyMarkup(priceCostExcel.value, mapping.priceClientaMarkupPct);
      const issue = rowEmpty
        ? "Fila sin datos"
        : !sku
          ? "SKU vacio"
          : duplicate
            ? "SKU duplicado"
            : priceCostExcel.invalid
              ? "Precio costo invalido"
              : null;
      const name = mapping.nameColumns.map((column) => this.textFromColumn(raw, column)).filter(Boolean).join(" ").trim();
      return {
        rowNumber,
        sku,
        name: rowEmpty ? "Fila sin datos" : name || sku || "Producto sin nombre",
        brand_name: this.textFromColumn(raw, mapping.brandColumn) || null,
        supplier_id: this.selectedSupplier()?.supplier_id || null,
        supplier_name: this.selectedSupplier()?.display_name || null,
        category: this.textFromColumn(raw, mapping.categoryColumn) || null,
        color: this.textFromColumn(raw, mapping.colorColumn) || null,
        size: this.textFromColumn(raw, mapping.sizeColumn) || null,
        price_cost_excel: priceCostExcel.value,
        price_cost_discount_pct: mapping.priceCostDiscountPct,
        price_cost: priceCost,
        price_clienta_markup_pct: mapping.priceClientaMarkupPct,
        price_clienta: priceClienta,
        original_row: this.originalRow(raw),
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

  private toImportRow(row: PreviewRow): CatalogProductImportRow {
    const supplier = this.selectedSupplier();
    return {
      sku: row.sku,
      name: row.name,
      brand_name: row.brand_name,
      supplier_id: supplier?.supplier_id || row.supplier_id || null,
      supplier_name: supplier?.display_name || row.supplier_name || null,
      category: row.category,
      color: row.color,
      size: row.size,
      price_cost_excel: row.price_cost_excel,
      price_cost_discount_pct: row.price_cost_discount_pct,
      price_cost: row.price_cost,
      price_clienta_markup_pct: row.price_clienta_markup_pct,
      price_clienta: row.price_clienta,
      original_row: row.original_row,
    };
  }

  private emptyMapping(): ImportMapping {
    return {
      skuColumn: "",
      nameColumns: [],
      brandColumn: "",
      categoryColumn: "",
      colorColumn: "",
      sizeColumn: "",
      priceCostColumn: "",
      priceCostDiscountPct: 0,
      priceClientaMarkupPct: 0,
    };
  }

  private autodetectMapping(headers: string[]): ImportMapping {
    const sku = this.guessHeader(headers, ["sku", "codigo", "clave", "cod", "id"]);
    const name = this.guessHeader(headers, ["nombre", "producto", "descripcion", "articulo", "modelo"]);
    return {
      skuColumn: sku,
      nameColumns: name ? [name] : headers.filter((header) => header !== sku).slice(0, 1),
      brandColumn: this.guessHeader(headers, ["marca", "brand", "fabricante"]),
      categoryColumn: this.guessHeader(headers, ["categoria", "departamento", "linea", "familia"]),
      colorColumn: this.guessHeader(headers, ["color", "tono"]),
      sizeColumn: this.guessHeader(headers, ["talla", "medida", "size"]),
      priceCostColumn: this.guessHeader(headers, ["costo", "precio costo", "cost"]),
      priceCostDiscountPct: 0,
      priceClientaMarkupPct: 0,
    };
  }

  private guessHeader(headers: string[], aliases: string[]): string {
    const normalizedAliases = aliases.map((alias) => this.normalizeText(alias));
    return headers.find((header) => {
      const normalized = this.normalizeText(header);
      return normalizedAliases.some((alias) => normalized === alias || normalized.includes(alias));
    }) || "";
  }

  private uniqueHeaders(row: unknown[]): string[] {
    const used = new Map<string, number>();
    return row.map((value, index) => {
      const base = String(value || `Columna ${index + 1}`).trim() || `Columna ${index + 1}`;
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      return count > 0 ? `${base} (${count + 1})` : base;
    });
  }

  private rowToRecord(headers: string[], row: unknown[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? "";
    });
    return out;
  }

  private nonEmptyCount(row: unknown[]): number {
    return row.filter((value) => String(value ?? "").trim().length > 0).length;
  }

  private nonEmptyRecordCount(row: Record<string, unknown>): number {
    return Object.entries(row).filter(([key, value]) => !key.startsWith("__") && String(value ?? "").trim().length > 0).length;
  }

  private textFromColumn(row: Record<string, unknown>, column: string): string {
    if (!column) return "";
    return String(row[column] ?? "").trim();
  }

  private numberFromColumn(row: Record<string, unknown>, column: string): { value: number | null; invalid: boolean } {
    const value = this.textFromColumn(row, column).replace(/[$,\s]/g, "");
    if (!value) return { value: null, invalid: false };
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return { value: null, invalid: true };
    return { value: Number(number.toFixed(2)), invalid: false };
  }

  private clampPercent(value: unknown): number {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Number(number.toFixed(2))));
  }

  private applyDiscount(value: number | null, percent: number): number | null {
    if (value === null) return null;
    return Number(Math.max(0, value * (1 - this.clampPercent(percent) / 100)).toFixed(2));
  }

  private applyMarkup(value: number | null, percent: number): number | null {
    if (value === null) return null;
    return Number(Math.max(0, value * (1 + this.clampPercent(percent) / 100)).toFixed(2));
  }

  private integerFromColumn(row: Record<string, unknown>, column: string): { value: number | null; invalid: boolean } {
    const parsed = this.numberFromColumn(row, column);
    if (parsed.invalid || parsed.value === null) return parsed;
    return { value: Math.trunc(parsed.value), invalid: false };
  }

  private originalRow(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__")));
  }

  private emptyPreview(): PreviewSummary {
    return {
      rows: [],
      sample: [],
      validRows: [],
      total: 0,
      valid: 0,
      missingSku: 0,
      duplicateSku: 0,
      invalidValues: 0,
    };
  }

  private normalizeText(value: unknown): string {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }
}
