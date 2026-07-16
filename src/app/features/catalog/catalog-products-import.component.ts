import { CurrencyPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  CatalogProduct,
  CatalogProductImportRow,
  CatalogProductsService,
} from "../../core/catalog-products.service";
import {
  CatalogImportAuditRow,
  CatalogImportJob,
  CatalogImportJobsService,
  CatalogImportMode,
} from "../../core/catalog-import-jobs.service";
import { Supplier, SuppliersService } from "../../core/suppliers.service";

type ConsoleTab = "products" | "imports" | "quality";
type WizardStep = "file" | "headers" | "columns" | "prices" | "review" | "result";

type MappingKey =
  | "skuColumn"
  | "brandColumn"
  | "categoryColumn"
  | "colorColumn"
  | "sizeColumn"
  | "priceCostColumn"
  | "impulsProductIdColumn";

type PercentMappingKey = "priceCostDiscountPct" | "priceClientaMarkupPct";

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

interface HeaderCandidate {
  rowIndex: number;
  rowNumber: number;
  score: number;
  labels: string[];
}

interface ParsedExcel {
  headers: string[];
  rawRows: Record<string, unknown>[];
  matrix: unknown[][];
  sheetName: string | null;
  headerIndex: number;
  headerCandidates: HeaderCandidate[];
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

interface ProductHealthPill {
  label: string;
  tone: "ok" | "warn" | "danger" | "info" | "muted";
  icon: string;
}

interface SupplierConsoleOption {
  key: string;
  supplier_id: string | null;
  label: string;
  productCount: number;
  importCount: number;
  issueCount: number;
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
  consoleTab = signal<ConsoleTab>("products");
  wizardStep = signal<WizardStep>("file");
  importModalOpen = signal(false);
  supplierPickerError = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  fileName = signal("");
  importMode = signal<CatalogImportMode>("full");
  sourceSheetName = signal<string | null>(null);
  headerRowIndex = signal<number | null>(null);
  headerCandidates = signal<HeaderCandidate[]>([]);
  parsedMatrix = signal<unknown[][]>([]);
  selectedCatalogSupplierKey = signal("");
  selectedSupplierId = signal("");
  headers = signal<string[]>([]);
  rawRows = signal<Record<string, unknown>[]>([]);
  search = signal("");
  mapping = signal<ImportMapping>(this.emptyMapping());
  validating = signal(false);
  selectedJobId = signal<string | null>(null);
  selectedJobRows = signal<CatalogImportAuditRow[]>([]);
  selectedJobRowsLoading = signal(false);
  rollbackBusyId = signal<string | null>(null);
  private previewState = signal<PreviewSummary>(this.emptyPreview());
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private validationRun = 0;
  private destroyed = false;

  products = computed(() => this.catalogProducts.catalogoPageProducts().filter((product) => this.supplierKey(product.supplier_id) === this.activeCatalogSupplierKey()));

  allCatalogProducts = computed(() => this.catalogProducts.catalogoProducts());
  supplierOptions = computed<SupplierConsoleOption[]>(() => {
    const map = new Map<string, SupplierConsoleOption>();
    const ensure = (supplierId: string | null | undefined, label?: string | null) => {
      const key = this.supplierKey(supplierId);
      const existing = map.get(key);
      if (existing) {
        if (!existing.supplier_id && supplierId) existing.supplier_id = supplierId;
        if ((existing.label === "Sin proveedor" || !existing.label) && label) existing.label = label;
        return existing;
      }
      const option: SupplierConsoleOption = {
        key,
        supplier_id: supplierId || null,
        label: label?.trim() || (supplierId ? supplierId : "Sin proveedor"),
        productCount: 0,
        importCount: 0,
        issueCount: 0,
      };
      map.set(key, option);
      return option;
    };

    for (const supplier of this.catalogSuppliers()) ensure(supplier.supplier_id, supplier.display_name);
    for (const product of this.allCatalogProducts()) {
      const option = ensure(product.supplier_id, product.supplier_name);
      option.productCount += 1;
    }
    for (const job of this.importJobs.jobs()) {
      const option = ensure(job.supplier_id, job.supplier_name);
      option.importCount += 1;
    }
    for (const product of this.allCatalogProducts()) {
      if (this.productHealth(product).some((pill) => pill.tone !== "ok")) {
        ensure(product.supplier_id, product.supplier_name).issueCount += 1;
      }
    }

    return Array.from(map.values())
      .filter((option) => option.productCount > 0 || option.importCount > 0 || Boolean(option.supplier_id))
      .sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
  });
  activeCatalogSupplierKey = computed(() => {
    const selected = this.selectedCatalogSupplierKey();
    const options = this.supplierOptions();
    if (selected && options.some((option) => option.key === selected)) return selected;
    return options[0]?.key || "";
  });
  activeCatalogSupplier = computed(() => this.supplierOptions().find((option) => option.key === this.activeCatalogSupplierKey()) || null);
  scopedCatalogProducts = computed(() => this.allCatalogProducts().filter((product) => this.supplierKey(product.supplier_id) === this.activeCatalogSupplierKey()));
  scopedImportJobs = computed(() => this.importJobs.jobs().filter((job) => this.supplierKey(job.supplier_id) === this.activeCatalogSupplierKey()));
  activeSupplierJob = computed(() => this.importJobs.activeJobs().find((job) => this.supplierKey(job.supplier_id) === this.activeCatalogSupplierKey()) || null);

  pageState = computed(() => this.catalogProducts.pageState());

  preview = computed(() => this.previewState());

  catalogSuppliers = computed(() => this.suppliers.getActiveByBusiness("catalogo"));
  selectedSupplier = computed<Supplier | null>(() =>
    this.catalogSuppliers().find((supplier) => supplier.supplier_id === this.selectedSupplierId()) || null,
  );

  rejectedRows = computed(() => this.preview().rows.filter((row) => !row.valid));
  latestFullImportBySupplier = computed(() => {
    const out = new Map<string, CatalogImportJob>();
    for (const job of this.importJobs.completedJobs()) {
      if (!job.supplier_id || job.import_mode !== "full" || job.rollback_status === "completed") continue;
      const current = out.get(job.supplier_id);
      if (!current || this.toMillis(job.completed_at || job.updated_at) > this.toMillis(current.completed_at || current.updated_at)) {
        out.set(job.supplier_id, job);
      }
    }
    return out;
  });
  productKpis = computed(() => {
    const rows = this.scopedCatalogProducts();
    return {
      total: rows.length,
      updated: rows.filter((row) => this.productHealth(row).some((pill) => pill.label === "Actualizado")).length,
      stale: rows.filter((row) => this.productHealth(row).some((pill) => pill.label === "Precio viejo" || pill.label === "No vino en ultimo Excel")).length,
      missingPrice: rows.filter((row) => row.price_cost === null || row.price_clienta === null).length,
      review: rows.filter((row) => row.price_health_flags?.includes("large_price_change") || row.last_import_status === "price_review").length,
    };
  });
  qualityProducts = computed(() => this.scopedCatalogProducts().filter((product) => this.productHealth(product).some((pill) => pill.tone !== "ok")));
  criticalImportIssues = computed(() => {
    const issues: string[] = [];
    const mapping = this.mapping();
    const preview = this.preview();
    if (!this.selectedSupplier()) issues.push("Selecciona proveedor.");
    if (!this.fileName()) issues.push("Carga un archivo Excel.");
    if (!mapping.skuColumn) issues.push("Mapea la columna SKU/codigo.");
    if (!mapping.priceCostColumn) issues.push("Mapea la columna de precio costo.");
    if (preview.total > 0 && preview.duplicateSku / Math.max(1, preview.total) > 0.2) issues.push("Hay demasiados SKU duplicados.");
    if (preview.invalidValues > 0 && preview.valid === 0) issues.push("No hay filas validas por precios invalidos.");
    return issues;
  });
  importWarnings = computed(() => {
    const warnings: string[] = [];
    const preview = this.preview();
    if (this.rejectedRows().length > 0) warnings.push(`${this.rejectedRows().length} fila(s) no se importaran.`);
    if (preview.total > 0 && !this.mapping().nameColumns.length) warnings.push("El nombre se armara con SKU porque no elegiste columnas de nombre.");
    if (this.importMode() === "full") warnings.push("Catálogo completo marcara como precio viejo lo que no venga en este Excel.");
    return warnings;
  });
  canImport = computed(() => this.criticalImportIssues().length === 0 && this.preview().valid > 0 && !this.validating() && !this.importing());
  selectedJob = computed(() => this.scopedImportJobs().find((job) => job.job_id === this.selectedJobId()) || null);

  constructor() {
    this.importJobs.watch();
    Promise.all([
      this.suppliers.loadFromFirestore().catch(() => null),
      this.catalogProducts.loadFromFirestore().catch(() => null),
    ]).finally(() => {
      this.ensureSupplierSelection();
      this.watchSelectedSupplierPage();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.catalogProducts.stopWatchingPage();
  }

  async reload(): Promise<void> {
    this.error.set(null);
    await this.catalogProducts.loadFromFirestore().catch(() => null);
    this.ensureSupplierSelection();
    this.watchSelectedSupplierPage();
  }

  openImportModal(): void {
    this.error.set(null);
    this.success.set(null);
    this.supplierPickerError.set(null);
    this.wizardStep.set("file");
    this.importMode.set("full");
    const active = this.activeCatalogSupplier();
    if (active?.supplier_id) {
      this.selectedSupplierId.set(active.supplier_id);
      this.applySavedTemplate(active.supplier_id);
    }
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
    this.applySavedTemplate(supplierId);
    if (this.rawRows().length > 0) this.schedulePreviewValidation();
  }

  setConsoleTab(tab: ConsoleTab): void {
    this.consoleTab.set(tab);
  }

  selectCatalogSupplier(key: string): void {
    this.selectedCatalogSupplierKey.set(key);
    const option = this.activeCatalogSupplier();
    if (option?.supplier_id) {
      this.selectedSupplierId.set(option.supplier_id);
      this.applySavedTemplate(option.supplier_id);
    }
    this.search.set("");
    this.selectedJobId.set(null);
    this.selectedJobRows.set([]);
    this.watchSelectedSupplierPage();
  }

  setWizardStep(step: WizardStep): void {
    if (this.canEnterStep(step)) this.wizardStep.set(step);
  }

  nextWizardStep(): void {
    const steps: WizardStep[] = ["file", "headers", "columns", "prices", "review", "result"];
    const current = steps.indexOf(this.wizardStep());
    const next = steps[current + 1];
    if (next && this.canEnterStep(next)) this.wizardStep.set(next);
  }

  prevWizardStep(): void {
    const steps: WizardStep[] = ["file", "headers", "columns", "prices", "review", "result"];
    const current = steps.indexOf(this.wizardStep());
    const prev = steps[current - 1];
    if (prev) this.wizardStep.set(prev);
  }

  canEnterStep(step: WizardStep): boolean {
    if (step === "file") return true;
    if (!this.fileName() || this.headers().length === 0) return false;
    if (step === "headers") return true;
    if (step === "columns") return true;
    if (step === "prices") return Boolean(this.mapping().skuColumn);
    if (step === "review") return Boolean(this.mapping().skuColumn && this.mapping().priceCostColumn);
    if (step === "result") return Boolean(this.success());
    return true;
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
      this.parsedMatrix.set(parsed.matrix);
      this.sourceSheetName.set(parsed.sheetName);
      this.headerRowIndex.set(parsed.headerIndex);
      this.headerCandidates.set(parsed.headerCandidates);
      this.headers.set(parsed.headers);
      this.rawRows.set(parsed.rawRows);
      const detected = this.autodetectMapping(parsed.headers);
      this.mapping.set(this.mappingWithSavedTemplate(detected, this.selectedSupplierId()));
      this.previewState.set(this.emptyPreview());
      this.wizardStep.set("headers");
      this.schedulePreviewValidation(0);
    } catch (error: any) {
      this.parsedMatrix.set([]);
      this.sourceSheetName.set(null);
      this.headerRowIndex.set(null);
      this.headerCandidates.set([]);
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

  onHeaderRowSelected(value: number | string): void {
    const index = Math.max(0, Math.trunc(Number(value)));
    const matrix = this.parsedMatrix();
    if (!matrix.length || index >= matrix.length) return;
    const parsed = this.rowsFromHeader(matrix, index);
    this.headerRowIndex.set(index);
    this.headers.set(parsed.headers);
    this.rawRows.set(parsed.rawRows);
    const detected = this.autodetectMapping(parsed.headers);
    this.mapping.set(this.mappingWithSavedTemplate(detected, this.selectedSupplierId()));
    this.previewState.set(this.emptyPreview());
    this.schedulePreviewValidation(0);
  }

  isNameColumnSelected(column: string): boolean {
    return this.mapping().nameColumns.includes(column);
  }

  mappedColumnPreview(): Array<{ label: string; column: string; values: string[]; required?: boolean }> {
    const mapping = this.mapping();
    return [
      { label: "SKU / código", column: mapping.skuColumn, values: this.columnSamples(mapping.skuColumn), required: true },
      { label: "Nombre", column: mapping.nameColumns.join(" + "), values: this.nameSamples(), required: true },
      { label: "Marca", column: mapping.brandColumn, values: this.columnSamples(mapping.brandColumn) },
      { label: "Categoría", column: mapping.categoryColumn, values: this.columnSamples(mapping.categoryColumn) },
      { label: "Color", column: mapping.colorColumn, values: this.columnSamples(mapping.colorColumn) },
      { label: "Talla", column: mapping.sizeColumn, values: this.columnSamples(mapping.sizeColumn) },
      { label: "ID proveedor", column: mapping.impulsProductIdColumn, values: this.columnSamples(mapping.impulsProductIdColumn) },
    ];
  }

  columnSamples(column: string, limit = 4): string[] {
    if (!column) return [];
    const values: string[] = [];
    for (const row of this.rawRows()) {
      if (row["__row_empty"] === true) continue;
      const value = this.textFromColumn(row, column);
      if (!value) continue;
      if (!values.includes(value)) values.push(value);
      if (values.length >= limit) break;
    }
    return values;
  }

  nameSamples(limit = 4): string[] {
    const columns = this.mapping().nameColumns;
    if (!columns.length) return [];
    const values: string[] = [];
    for (const row of this.rawRows()) {
      if (row["__row_empty"] === true) continue;
      const value = columns.map((column) => this.textFromColumn(row, column)).filter(Boolean).join(" ").trim();
      if (!value) continue;
      if (!values.includes(value)) values.push(value);
      if (values.length >= limit) break;
    }
    return values;
  }

  mappedResultRows(): PreviewRow[] {
    return this.preview().sample.filter((row) => row.valid || row.sku || row.name).slice(0, 6);
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
        import_mode: this.importMode(),
        source_sheet_name: this.sourceSheetName(),
        header_row_index: this.headerRowIndex(),
        mapping_snapshot: {
          ...mapping,
          headerRowIndex: this.headerRowIndex(),
          sourceSheetName: this.sourceSheetName(),
        },
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
      this.saveTemplate(supplier.supplier_id, mapping);
      this.success.set(`Importacion lista: ${validRows.length} producto(s).`);
      this.selectedJobId.set(job.job_id);
      this.selectedCatalogSupplierKey.set(this.supplierKey(supplier.supplier_id));
      this.consoleTab.set("imports");
      this.wizardStep.set("result");
      await this.catalogProducts.loadFromFirestore().catch(() => null);
      this.watchSelectedSupplierPage();
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
    this.watchSelectedSupplierPage();
  }

  loadMoreProducts(): void {
    void this.catalogProducts.loadMoreCatalogPage({
      businessId: "catalogo",
      searchSku: this.search(),
      supplierId: this.activeCatalogSupplier()?.supplier_id || null,
    });
  }

  async selectJob(job: CatalogImportJob): Promise<void> {
    this.selectedJobId.set(job.job_id);
    this.selectedJobRows.set([]);
    this.selectedJobRowsLoading.set(true);
    try {
      this.selectedJobRows.set(await this.importJobs.loadRows(job.job_id, 600));
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar el detalle de importacion.");
    } finally {
      this.selectedJobRowsLoading.set(false);
    }
  }

  async rollbackJob(job: CatalogImportJob, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (job.rollback_status === "completed" || job.rollback_status === "running") return;
    const ok = window.confirm(`Revertir la importacion "${job.file_name}"? Los productos nuevos se desactivaran y los existentes volveran a su estado anterior.`);
    if (!ok) return;
    this.rollbackBusyId.set(job.job_id);
    this.error.set(null);
    try {
      await this.importJobs.rollback(job.job_id);
      this.success.set("Importacion revertida correctamente.");
      await this.catalogProducts.loadFromFirestore().catch(() => null);
      this.watchSelectedSupplierPage();
      await this.selectJob(job);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo revertir la importacion.");
    } finally {
      this.rollbackBusyId.set(null);
    }
  }

  openCorrection(job: CatalogImportJob, event?: Event): void {
    event?.stopPropagation();
    this.error.set(null);
    this.success.set(null);
    this.selectedSupplierId.set(job.supplier_id || "");
    this.importMode.set(job.import_mode);
    if (job.mapping_snapshot) {
      const mapping = job.mapping_snapshot as Partial<ImportMapping>;
      this.mapping.set({ ...this.emptyMapping(), ...mapping });
    }
    this.fileName.set("");
    this.headers.set([]);
    this.rawRows.set([]);
    this.parsedMatrix.set([]);
    this.previewState.set(this.emptyPreview());
    this.wizardStep.set("file");
    this.importModalOpen.set(true);
  }

  productHealth(product: CatalogProduct): ProductHealthPill[] {
    const pills: ProductHealthPill[] = [];
    const latest = product.supplier_id ? this.latestFullImportBySupplier().get(product.supplier_id) : null;
    const lastImportId = product.last_price_import_id || product.last_import_id || null;
    if (product.reverted_from_import_id) {
      pills.push({ label: "Importacion revertida", tone: "danger", icon: "undo" });
    }
    if (product.price_cost === null || product.price_clienta === null) {
      pills.push({ label: "Sin precio", tone: "danger", icon: "error" });
    }
    if (product.price_health_flags?.includes("large_price_change") || product.last_import_status === "price_review") {
      pills.push({ label: "Cambio fuerte", tone: "warn", icon: "warning" });
    }
    if (!lastImportId) {
      pills.push({ label: "Sin historial", tone: "muted", icon: "history" });
    } else if (latest && latest.job_id !== lastImportId) {
      pills.push({ label: "No vino en ultimo Excel", tone: "warn", icon: "event_busy" });
      pills.push({ label: "Precio viejo", tone: "warn", icon: "schedule" });
    }
    if (pills.length === 0) pills.push({ label: "Actualizado", tone: "ok", icon: "check_circle" });
    return pills;
  }

  rowStatusLabel(status: CatalogImportAuditRow["status"]): string {
    const labels: Record<CatalogImportAuditRow["status"], string> = {
      created: "Creado",
      updated: "Actualizado",
      unchanged: "Sin cambio",
      rejected: "Rechazado",
      failed: "Fallido",
      skipped: "Omitido",
    };
    return labels[status] || status;
  }

  rowStatusClass(status: CatalogImportAuditRow["status"]): string {
    if (status === "created" || status === "updated") return "ok";
    if (status === "unchanged") return "muted";
    return "danger";
  }

  jobStatusLabel(job: CatalogImportJob): string {
    if (job.rollback_status === "completed") return "Revertida";
    if (job.rollback_status === "running") return "Revirtiendo";
    if (job.status === "completed") return "Completada";
    if (job.status === "running" || job.status === "queued") return "En proceso";
    return "Fallida";
  }

  jobStatusClass(job: CatalogImportJob): string {
    if (job.rollback_status === "completed") return "muted";
    if (job.status === "completed") return "ok";
    if (job.status === "failed" || job.rollback_status === "failed") return "danger";
    return "info";
  }

  formatDate(value: unknown): string {
    const date = this.toDate(value);
    if (!date) return "Sin fecha";
    return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  shortDate(value: unknown): string {
    const date = this.toDate(value);
    if (!date) return "Sin historial";
    return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" }).format(date);
  }

  private async parseExcelFile(file: File): Promise<ParsedExcel> {
    const buffer = await file.arrayBuffer();
    if (typeof Worker !== "undefined") {
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./catalog-import.worker", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<any>) => {
          worker.terminate();
          if (event.data?.ok) {
            resolve({
              headers: event.data.headers || [],
              rawRows: event.data.rawRows || [],
              matrix: event.data.matrix || [],
              sheetName: event.data.sheetName || null,
              headerIndex: Number(event.data.headerIndex || 0),
              headerCandidates: Array.isArray(event.data.headerCandidates) ? event.data.headerCandidates : [],
            });
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
    const headerCandidates = this.detectHeaderCandidates(matrix);
    const headerIndex = headerCandidates[0]?.rowIndex ?? matrix.findIndex((row) => this.nonEmptyCount(row) >= 2);
    if (headerIndex < 0) throw new Error("No se detectaron encabezados.");
    const parsed = this.rowsFromHeader(matrix, headerIndex);
    return { ...parsed, matrix, sheetName, headerIndex, headerCandidates };
  }

  private supplierKey(supplierId: string | null | undefined): string {
    const text = String(supplierId || "").trim();
    return text || "__missing_supplier__";
  }

  private ensureSupplierSelection(): void {
    const options = this.supplierOptions();
    if (!options.length) {
      this.selectedCatalogSupplierKey.set("");
      return;
    }
    const current = this.selectedCatalogSupplierKey();
    if (!current || !options.some((option) => option.key === current)) {
      this.selectedCatalogSupplierKey.set(options[0].key);
    }
  }

  private watchSelectedSupplierPage(): void {
    this.ensureSupplierSelection();
    this.catalogProducts.watchCatalogPage({
      businessId: "catalogo",
      searchSku: this.search(),
      supplierId: this.activeCatalogSupplier()?.supplier_id || null,
    });
  }

  private templateKey(supplierId: string): string {
    return `base_mayorista_catalog_import_template_${supplierId || "default"}`;
  }

  private saveTemplate(supplierId: string, mapping: ImportMapping): void {
    if (!supplierId) return;
    try {
      localStorage.setItem(this.templateKey(supplierId), JSON.stringify(mapping));
    } catch {
      // La plantilla es una mejora de conveniencia; no debe bloquear la importacion.
    }
  }

  private applySavedTemplate(supplierId: string): void {
    if (!supplierId || this.headers().length === 0) return;
    this.mapping.set(this.mappingWithSavedTemplate(this.mapping(), supplierId));
  }

  private mappingWithSavedTemplate(base: ImportMapping, supplierId: string): ImportMapping {
    if (!supplierId) return base;
    try {
      const raw = localStorage.getItem(this.templateKey(supplierId));
      if (!raw) return base;
      const saved = JSON.parse(raw) as Partial<ImportMapping>;
      const headers = new Set(this.headers());
      const safeColumn = (value: unknown) => {
        const text = String(value || "");
        return headers.has(text) ? text : "";
      };
      const safeColumns = (values: unknown) => Array.isArray(values)
        ? values.map((value) => String(value || "")).filter((value) => headers.has(value))
        : [];
      return {
        ...base,
        skuColumn: safeColumn(saved.skuColumn) || base.skuColumn,
        nameColumns: safeColumns(saved.nameColumns).length ? safeColumns(saved.nameColumns) : base.nameColumns,
        brandColumn: safeColumn(saved.brandColumn) || base.brandColumn,
        categoryColumn: safeColumn(saved.categoryColumn) || base.categoryColumn,
        colorColumn: safeColumn(saved.colorColumn) || base.colorColumn,
        sizeColumn: safeColumn(saved.sizeColumn) || base.sizeColumn,
        priceCostColumn: safeColumn(saved.priceCostColumn) || base.priceCostColumn,
        impulsProductIdColumn: safeColumn(saved.impulsProductIdColumn) || base.impulsProductIdColumn,
        priceCostDiscountPct: this.clampPercent(saved.priceCostDiscountPct ?? base.priceCostDiscountPct),
        priceClientaMarkupPct: this.clampPercent(saved.priceClientaMarkupPct ?? base.priceClientaMarkupPct),
      };
    } catch {
      return base;
    }
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
      const cklassFields = this.extractCklassFields(raw);
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
        impuls_product_id: this.textFromColumn(raw, mapping.impulsProductIdColumn) || null,
        ...cklassFields,
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
      row_number: row.rowNumber,
      brand_name: row.brand_name,
      supplier_id: supplier?.supplier_id || row.supplier_id || null,
      supplier_name: supplier?.display_name || row.supplier_name || null,
      category: row.category,
      color: row.color,
      size: row.size,
      impuls_product_id: row.impuls_product_id,
      cklass_model: row.cklass_model,
      cklass_color: row.cklass_color,
      cklass_size: row.cklass_size,
      cklass_barcode: row.cklass_barcode,
      cklass_catalog: row.cklass_catalog,
      cklass_model_display: row.cklass_model_display,
      cklass_product_code: row.cklass_product_code,
      image_key: row.image_key,
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
      impulsProductIdColumn: "",
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
      impulsProductIdColumn: this.guessHeader(headers, ["generico", "genérico", "id generico", "id genérico", "productid", "product id"]),
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

  private rowsFromHeader(matrix: unknown[][], headerIndex: number): { headers: string[]; rawRows: Record<string, unknown>[] } {
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

  private detectHeaderCandidates(matrix: unknown[][]): HeaderCandidate[] {
    return matrix
      .slice(0, 40)
      .map((row, index) => this.headerCandidate(row, index))
      .filter((candidate): candidate is HeaderCandidate => Boolean(candidate))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private headerCandidate(row: unknown[], rowIndex: number): HeaderCandidate | null {
    const labels = row.map((value) => String(value ?? "").trim()).filter(Boolean);
    if (labels.length < 2) return null;
    const keywords = ["sku", "codigo", "clave", "modelo", "producto", "descripcion", "nombre", "costo", "precio", "marca", "categoria", "color", "talla", "barra", "generico"];
    const hits = labels
      .map((value) => this.normalizeHeaderKey(value))
      .filter((value) => keywords.some((keyword) => value.includes(this.normalizeHeaderKey(keyword))))
      .length;
    const numericLike = labels.filter((value) => /^\$?\s*[\d,.]+%?$/.test(value)).length;
    const score = hits * 12 + labels.length * 2 - numericLike * 6 - rowIndex * 0.15;
    return score > 0 ? { rowIndex, rowNumber: rowIndex + 1, score, labels: labels.slice(0, 8) } : null;
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

  private textFromKnownColumn(row: Record<string, unknown>, aliases: string[]): string {
    const aliasSet = new Set(aliases.map((alias) => this.normalizeHeaderKey(alias)));
    const key = Object.keys(row).find((header) => aliasSet.has(this.normalizeHeaderKey(header)));
    return key ? String(row[key] ?? "").trim() : "";
  }

  private extractCklassFields(row: Record<string, unknown>): Pick<
    CatalogProductImportRow,
    | "cklass_model"
    | "cklass_color"
    | "cklass_size"
    | "cklass_barcode"
    | "cklass_catalog"
    | "cklass_model_display"
    | "cklass_product_code"
    | "image_key"
  > {
    const model = this.textFromKnownColumn(row, ["MODELO", "modelo"]) || null;
    const color = this.textFromKnownColumn(row, ["COLOR", "color"]) || null;
    const size = this.textFromKnownColumn(row, ["TALLA", "talla"]) || null;
    const barcode = this.textFromKnownColumn(row, ["Codigo_Barra", "codigo_barra", "codigo barra", "codigo de barra"]) || null;
    const catalog = this.textFromKnownColumn(row, ["CATALOGO", "catalogo", "catálogo"]) || null;
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

  private normalizeHeaderKey(value: unknown): string {
    return this.normalizeText(value).replace(/[^a-z0-9]+/g, "");
  }

  private toDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
      return (value as { toDate: () => Date }).toDate();
    }
    if (typeof value === "object" && value !== null && typeof (value as { seconds?: unknown }).seconds === "number") {
      return new Date(Number((value as { seconds: number }).seconds) * 1000);
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private toMillis(value: unknown): number {
    return this.toDate(value)?.getTime() || 0;
  }
}
