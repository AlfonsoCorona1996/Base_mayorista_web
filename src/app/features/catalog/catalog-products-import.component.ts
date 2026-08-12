import { CurrencyPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  CatalogProduct,
  CatalogProductImportRow,
  CatalogProductMetrics,
  CatalogProductsService,
} from "../../core/catalog-products.service";
import {
  CatalogImportAuditRow,
  CatalogImportJob,
  CatalogImportJobsService,
  CatalogImportMode,
  CatalogImportProfileV2,
} from "../../core/catalog-import-jobs.service";
import { Supplier, SuppliersService } from "../../core/suppliers.service";
import { ApiError } from "../../services/user-admin-api.service";
import {
  CatalogImportMappingV2,
  CatalogImportV2RowFields,
  CatalogPriceRule,
  PriceRounding,
  buildIdentifiers,
  emptyPriceRule,
  evaluatePriceRule,
  normalizeIdentifierKey,
} from "./catalog-import-v2.types";

type ConsoleTab = "products" | "imports" | "quality";
type WizardStep = "file" | "headers" | "columns" | "prices" | "review" | "result";

type MappingKey =
  | "skuColumn"
  | "primaryBarcodeColumn"
  | "supplierSkuColumn"
  | "supplierVariantColumn"
  | "genericColumn"
  | "internetColumn"
  | "modelColumn"
  | "styleColumn"
  | "bundleColumn"
  | "brandColumn"
  | "categoryColumn"
  | "colorColumn"
  | "sizeColumn"
  | "priceCostColumn"
  | "impulsProductIdColumn";

type MultiColumnMappingKey = "alternateBarcodeColumns" | "ocrAliasColumns" | "customIdentifierColumns";
type PriceRuleKey = "costRule" | "clientaRule";
type PriceRuleField = keyof CatalogPriceRule;
type ImportMapping = CatalogImportMappingV2;

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
  warnings: string[];
  primary_barcode: string | null;
  supplier_sku: string | null;
  identifiers: CatalogImportV2RowFields["identifiers"];
  prices: CatalogImportV2RowFields["prices"];
}

interface PreviewSummary {
  rows: PreviewRow[];
  sample: PreviewRow[];
  total: number;
  valid: number;
  missingSku: number;
  duplicateSku: number;
  invalidValues: number;
  missingCost: number;
  identifierConflicts: number;
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

type CatalogMetricsState = CatalogProductMetrics & { exact: boolean };

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
  catalogMetricsBySupplier = signal<Record<string, CatalogMetricsState>>({});
  showAllSuppliersInImports = signal(false);
  duplicateActiveJob = signal<CatalogImportJob | null>(null);
  confirmBusyId = signal<string | null>(null);
  cancelBusyId = signal<string | null>(null);
  private previewState = signal<PreviewSummary>(this.emptyPreview());
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private validationRun = 0;
  private destroyed = false;
  private selectedSourceFile: File | null = null;

  products = computed(() => this.catalogProducts.catalogoPageProducts().filter((product) => this.supplierKey(product.supplier_id) === this.activeCatalogSupplierKey()));

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
    for (const [supplierId, metrics] of Object.entries(this.catalogMetricsBySupplier())) ensure(supplierId).productCount = metrics.total;
    for (const job of this.importJobs.jobs()) {
      const option = ensure(job.supplier_id, job.supplier_name);
      option.importCount += 1;
    }
    for (const [supplierId, metrics] of Object.entries(this.catalogMetricsBySupplier())) ensure(supplierId).issueCount = metrics.quality_issues;

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
  scopedCatalogProducts = computed(() => this.products());
  scopedImportJobs = computed(() =>
    this.showAllSuppliersInImports()
      ? this.importJobs.jobs()
      : this.importJobs.jobs().filter((job) => this.supplierKey(job.supplier_id) === this.activeCatalogSupplierKey()),
  );
  activeSupplierJob = computed(() => this.importJobs.activeJobs().find((job) => this.supplierKey(job.supplier_id) === this.activeCatalogSupplierKey()) || null);

  pageState = computed(() => this.catalogProducts.pageState());

  preview = computed(() => this.previewState());
  priceRuleEntries = computed<Array<{ key: "clientaRule"; label: string; rule: CatalogPriceRule }>>(() => [
    { key: "clientaRule", label: "Clienta", rule: this.mapping().clientaRule },
  ]);

  catalogSuppliers = computed(() => this.suppliers.getActiveByBusiness("catalogo"));
  selectedSupplier = computed<Supplier | null>(() =>
    this.catalogSuppliers().find((supplier) => supplier.supplier_id === this.selectedSupplierId()) || null,
  );

  rejectedCount = computed(() => this.preview().invalidValues);
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
    const supplierId = this.activeCatalogSupplier()?.supplier_id || "";
    const metrics = supplierId ? this.catalogMetricsBySupplier()[supplierId] : null;
    if (metrics) {
      return { total: metrics.total, updated: metrics.updated, stale: metrics.stale, missingPrice: metrics.missing_price, review: metrics.review };
    }
    return {
      total: rows.length,
      updated: rows.filter((row) => this.productHealth(row).some((pill) => pill.label === "Actualizado")).length,
      stale: rows.filter((row) => this.productHealth(row).some((pill) => pill.label === "Precio viejo" || pill.label === "No vino en ultimo Excel")).length,
      missingPrice: rows.filter((row) => row.price_cost === null || row.price_cost <= 0).length,
      review: rows.filter((row) => row.price_health_flags?.includes("large_price_change") || row.last_import_status === "price_review").length,
    };
  });
  metricsAreExact = computed(() => {
    const supplierId = this.activeCatalogSupplier()?.supplier_id || "";
    return Boolean(supplierId && this.catalogMetricsBySupplier()[supplierId]?.exact);
  });
  qualityProducts = computed(() => this.scopedCatalogProducts().filter((product) => this.productHealth(product).some((pill) => pill.tone !== "ok")));
  criticalImportIssues = computed(() => {
    const issues: string[] = [];
    const mapping = this.mapping();
    const preview = this.preview();
    if (!this.selectedSupplier()) issues.push("Selecciona proveedor.");
    if (!this.fileName()) issues.push("Carga un archivo Excel.");
    if (!mapping.primaryBarcodeColumn && !mapping.supplierSkuColumn && !mapping.supplierVariantColumn) {
      issues.push("Mapea al menos un barcode, SKU de proveedor o variante.");
    }
    if (mapping.costRule.base === "column" && !mapping.costRule.sourceColumn) issues.push("Configura la fuente obligatoria del costo.");
    if (preview.identifierConflicts > 0) issues.push(`${preview.identifierConflicts} fila(s) tienen códigos que apuntan a identidades diferentes.`);
    if (preview.invalidValues > 0 && preview.valid === 0) issues.push("No hay filas validas por precios invalidos.");
    return issues;
  });
  importWarnings = computed(() => {
    const warnings: string[] = [];
    const preview = this.preview();
    if (this.rejectedCount() > 0) warnings.push(`${this.rejectedCount()} fila(s) no se importaran.`);
    if (preview.total > 0 && !this.mapping().nameColumns.length) warnings.push("El nombre se armara con el identificador disponible porque no elegiste columnas de nombre.");
    if (preview.duplicateSku > 0) warnings.push(`${preview.duplicateSku} fila(s) repetidas se consolidarán y conservarán como apariciones del catálogo.`);
    if (this.importMode() === "full") warnings.push("Catálogo completo marcara como precio viejo lo que no venga en este Excel.");
    return warnings;
  });
  canImport = computed(() => this.criticalImportIssues().length === 0 && this.preview().valid > 0 && !this.validating() && !this.importing());
  selectedJob = computed(() => this.scopedImportJobs().find((job) => job.job_id === this.selectedJobId()) || null);

  constructor() {
    this.importJobs.watch();
    this.suppliers.loadFromFirestore().catch(() => null).finally(() => {
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
    this.ensureSupplierSelection();
    this.watchSelectedSupplierPage();
  }

  openImportModal(): void {
    this.error.set(null);
    this.success.set(null);
    this.supplierPickerError.set(null);
    this.wizardStep.set("file");
    this.importMode.set("full");
    this.fileName.set("");
    this.selectedSourceFile = null;
    this.headers.set([]);
    this.rawRows.set([]);
    this.parsedMatrix.set([]);
    this.previewState.set(this.emptyPreview());
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
    if (step === "prices") return Boolean(this.mapping().primaryBarcodeColumn || this.mapping().supplierSkuColumn || this.mapping().supplierVariantColumn);
    if (step === "review") return Boolean((this.mapping().primaryBarcodeColumn || this.mapping().supplierSkuColumn || this.mapping().supplierVariantColumn) && this.mapping().costRule.sourceColumn);
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
    this.selectedSourceFile = file;

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
    this.mapping.update((current) => {
      const next = { ...current, [field]: value };
      if (field === "primaryBarcodeColumn") next.skuColumn = value || next.supplierSkuColumn || next.supplierVariantColumn;
      if (field === "supplierSkuColumn" && !next.primaryBarcodeColumn) next.skuColumn = value || next.supplierVariantColumn;
      if (field === "supplierVariantColumn" && !next.primaryBarcodeColumn && !next.supplierSkuColumn) next.skuColumn = value;
      return next;
    });
    this.schedulePreviewValidation();
  }

  setPriceRuleField(ruleKey: PriceRuleKey, field: PriceRuleField, value: string | number): void {
    this.mapping.update((current) => ({
      ...current,
      [ruleKey]: {
        ...current[ruleKey],
        [field]: field === "percentValue" ? this.clampPercent(value) : value,
      },
      ...(ruleKey === "costRule" && field === "sourceColumn" ? { priceCostColumn: String(value || "") } : {}),
    }));
    this.schedulePreviewValidation();
  }

  toggleMultiColumn(field: MultiColumnMappingKey, column: string, checked: boolean): void {
    this.mapping.update((current) => {
      const selected = new Set(current[field]);
      if (checked) selected.add(column);
      else selected.delete(column);
      return { ...current, [field]: [...selected] };
    });
    this.schedulePreviewValidation();
  }

  isMultiColumnSelected(field: MultiColumnMappingKey, column: string): boolean {
    return this.mapping()[field].includes(column);
  }

  togglePriceFallback(ruleKey: PriceRuleKey, column: string, checked: boolean): void {
    this.mapping.update((current) => {
      const selected = new Set(current[ruleKey].fallbackColumns);
      if (checked) selected.add(column);
      else selected.delete(column);
      return { ...current, [ruleKey]: { ...current[ruleKey], fallbackColumns: this.headers().filter((header) => selected.has(header)) } };
    });
    this.schedulePreviewValidation();
  }

  isPriceFallbackSelected(ruleKey: PriceRuleKey, column: string): boolean {
    return this.mapping()[ruleKey].fallbackColumns.includes(column);
  }

  priceRuleLabel(rule: CatalogPriceRule): string {
    if (rule.base === "cost") return "Costo calculado";
    return rule.sourceColumn || "Columna pendiente";
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
      { label: "Barcode principal", column: mapping.primaryBarcodeColumn, values: this.columnSamples(mapping.primaryBarcodeColumn) },
      { label: "SKU proveedor", column: mapping.supplierSkuColumn, values: this.columnSamples(mapping.supplierSkuColumn) },
      { label: "Variante proveedor", column: mapping.supplierVariantColumn, values: this.columnSamples(mapping.supplierVariantColumn) },
      { label: "Modelo / grupo", column: mapping.modelColumn || mapping.genericColumn, values: this.columnSamples(mapping.modelColumn || mapping.genericColumn) },
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
    this.duplicateActiveJob.set(null);
    try {
      const mapping = this.mapping();
      const validRowCount = this.preview().valid;
      const job = await this.importJobs.createJob({
        business_id: "catalogo",
        file_name: this.fileName() || "catalogo.xlsx",
        import_mode: this.importMode(),
        source_sheet_name: this.sourceSheetName(),
        header_row_index: this.headerRowIndex(),
        mapping_snapshot: {
          ...mapping,
          profileVersion: 2,
          headerRowIndex: this.headerRowIndex(),
          sourceSheetName: this.sourceSheetName(),
        },
        total_rows: this.preview().total,
        valid_rows: validRowCount,
        rejected_rows: this.rejectedCount(),
        supplier_id: supplier.supplier_id,
        supplier_name: supplier.display_name,
        price_cost_discount_pct: mapping.costRule.mode === "formula" && mapping.costRule.percentOperation === "discount" && mapping.costRule.percentSource === "fixed" ? mapping.costRule.percentValue : 0,
        price_clienta_markup_pct: mapping.clientaRule.mode === "formula" && mapping.clientaRule.percentOperation === "markup" && mapping.clientaRule.percentSource === "fixed" ? mapping.clientaRule.percentValue : 0,
      });
      if (!this.selectedSourceFile) throw new Error("Vuelve a seleccionar el archivo Excel para continuar.");
      await this.importJobs.uploadSourceFile(job.job_id, this.selectedSourceFile);
      await this.importJobs.saveJobProfile(job.job_id, this.toV2Profile(mapping, supplier.supplier_id));
      // validate() ahora solo encola (el worker en segundo plano hace el
      // parseo/escritura pesada) — ya no se espera aquí a que termine, y por
      // lo tanto tampoco se encadena el commit automáticamente: el usuario lo
      // confirma desde la cola una vez que el job llegue a "validated".
      await this.importJobs.validate(job.job_id);
      this.saveTemplate(supplier.supplier_id, mapping);
      this.success.set(
        `Excel en cola (${validRowCount} fila(s) detectadas). Puedes cerrar esta pantalla o irte a otra sección; ` +
        "cuando termine de validarse, confirma la importación desde la cola.",
      );
      this.selectedJobId.set(job.job_id);
      this.selectedCatalogSupplierKey.set(this.supplierKey(supplier.supplier_id));
      this.consoleTab.set("imports");
      this.wizardStep.set("result");
      this.watchSelectedSupplierPage();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.code === "DUPLICATE_ACTIVE_IMPORT") {
        const existingRaw = (error.body as { existing_job?: Record<string, unknown> } | null)?.existing_job;
        const existing = this.importJobs.jobFromRaw(existingRaw);
        this.duplicateActiveJob.set(existing);
        this.error.set(error.message);
        if (existing) {
          this.selectedJobId.set(existing.job_id);
          this.selectedCatalogSupplierKey.set(this.supplierKey(existing.supplier_id));
          this.consoleTab.set("imports");
          this.importModalOpen.set(false);
        }
      } else {
        this.error.set(error instanceof Error ? error.message : "No se pudo importar el archivo.");
      }
    } finally {
      this.importing.set(false);
    }
  }

  async confirmJob(job: CatalogImportJob, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.confirmBusyId.set(job.job_id);
    this.error.set(null);
    try {
      await this.importJobs.commit(job.job_id);
      this.success.set("Importación confirmada. Los cambios se están aplicando al catálogo.");
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : "No se pudo confirmar la importación.");
    } finally {
      this.confirmBusyId.set(null);
    }
  }

  async cancelJob(job: CatalogImportJob, event?: Event): Promise<void> {
    event?.stopPropagation();
    const ok = window.confirm(
      `¿Cancelar la importación de "${job.file_name}"? Si ya se está aplicando, puede tardar unos segundos en detenerse.`,
    );
    if (!ok) return;
    this.cancelBusyId.set(job.job_id);
    this.error.set(null);
    try {
      await this.importJobs.cancel(job.job_id);
      this.success.set("Importación cancelada.");
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : "No se pudo cancelar la importación.");
    } finally {
      this.cancelBusyId.set(null);
    }
  }

  toggleAllSuppliersInImports(): void {
    this.showAllSuppliersInImports.update((value) => !value);
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
      this.selectedJobRows.set(await this.importJobs.loadRows(job.job_id));
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
      this.selectedSourceFile = null;
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
    if (product.catalog_status === "provisional") {
      pills.push({ label: "Provisional no vendible", tone: "warn", icon: "hourglass_top" });
    } else if (product.catalog_status === "outdated") {
      pills.push({ label: "No vino en ultimo Excel", tone: "warn", icon: "event_busy" });
      pills.push({ label: "Precio viejo", tone: "warn", icon: "schedule" });
    } else if (product.catalog_status === "archived") {
      pills.push({ label: "Archivado", tone: "muted", icon: "archive" });
    }
    if (product.reverted_from_import_id) {
      pills.push({ label: "Importacion revertida", tone: "danger", icon: "undo" });
    }
    if (product.price_cost === null || product.price_cost <= 0) {
      pills.push({ label: "Sin costo", tone: "danger", icon: "error" });
    } else if (product.price_clienta === null) {
      pills.push({ label: "Sin precio de venta", tone: "warn", icon: "sell" });
    }
    if (product.price_health_flags?.includes("large_price_change") || product.last_import_status === "price_review") {
      pills.push({ label: "Cambio fuerte", tone: "warn", icon: "warning" });
    }
    if (!lastImportId) {
      pills.push({ label: "Sin historial", tone: "muted", icon: "history" });
    } else if (latest && latest.job_id !== lastImportId && product.catalog_status !== "outdated") {
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
    return this.importJobs.jobStatusLabel(job);
  }

  jobStatusClass(job: CatalogImportJob): string {
    return this.importJobs.jobStatusClass(job);
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
    const supplierId = this.activeCatalogSupplier()?.supplier_id || null;
    this.catalogProducts.watchCatalogPage({
      businessId: "catalogo",
      searchSku: this.search(),
      supplierId,
    });
    if (supplierId) void this.loadSupplierMetrics(supplierId);
  }

  private async loadSupplierMetrics(supplierId: string): Promise<void> {
    try {
      const metrics = await this.catalogProducts.getMetrics({ businessId: "catalogo", supplierId });
      this.catalogMetricsBySupplier.update((current) => ({ ...current, [supplierId]: { ...metrics, exact: true } }));
    } catch {
      const rows = this.catalogProducts.catalogoPageProducts()
        .filter((row) => row.supplier_id === supplierId);
      this.catalogMetricsBySupplier.update((current) => ({
        ...current,
        [supplierId]: {
          total: rows.length,
          active: rows.filter((row) => row.active !== false).length,
          updated: rows.filter((row) => this.productHealth(row).some((pill) => pill.label === "Actualizado")).length,
          stale: rows.filter((row) => this.productHealth(row).some((pill) => pill.label === "Precio viejo" || pill.label === "No vino en ultimo Excel")).length,
          missing_price: rows.filter((row) => row.price_cost === null || row.price_cost <= 0).length,
          review: rows.filter((row) => row.price_health_flags?.includes("large_price_change") || row.last_import_status === "price_review").length,
          provisional: 0,
          groups: 0,
          variants: rows.length,
          quality_issues: rows.filter((row) => this.productHealth(row).some((pill) => pill.tone !== "ok")).length,
          exact: false,
        },
      }));
    }
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
        primaryBarcodeColumn: safeColumn(saved.primaryBarcodeColumn) || base.primaryBarcodeColumn,
        alternateBarcodeColumns: safeColumns(saved.alternateBarcodeColumns),
        supplierSkuColumn: safeColumn(saved.supplierSkuColumn) || base.supplierSkuColumn,
        supplierVariantColumn: safeColumn(saved.supplierVariantColumn) || base.supplierVariantColumn,
        genericColumn: safeColumn(saved.genericColumn) || base.genericColumn,
        internetColumn: safeColumn(saved.internetColumn) || base.internetColumn,
        modelColumn: safeColumn(saved.modelColumn) || base.modelColumn,
        styleColumn: safeColumn(saved.styleColumn) || base.styleColumn,
        bundleColumn: safeColumn(saved.bundleColumn) || base.bundleColumn,
        ocrAliasColumns: safeColumns(saved.ocrAliasColumns),
        customIdentifierColumns: safeColumns(saved.customIdentifierColumns),
        nameColumns: safeColumns(saved.nameColumns).length ? safeColumns(saved.nameColumns) : base.nameColumns,
        brandColumn: safeColumn(saved.brandColumn) || base.brandColumn,
        categoryColumn: safeColumn(saved.categoryColumn) || base.categoryColumn,
        colorColumn: safeColumn(saved.colorColumn) || base.colorColumn,
        sizeColumn: safeColumn(saved.sizeColumn) || base.sizeColumn,
        priceCostColumn: safeColumn(saved.priceCostColumn) || base.priceCostColumn,
        impulsProductIdColumn: safeColumn(saved.impulsProductIdColumn) || base.impulsProductIdColumn,
        priceCostDiscountPct: this.clampPercent(saved.priceCostDiscountPct ?? base.priceCostDiscountPct),
        priceClientaMarkupPct: this.clampPercent(saved.priceClientaMarkupPct ?? base.priceClientaMarkupPct),
        costRule: this.safePriceRule(saved.costRule, base.costRule, headers),
        clientaRule: this.safePriceRule(saved.clientaRule, base.clientaRule, headers),
      };
    } catch {
      return base;
    }
  }

  private safePriceRule(saved: CatalogPriceRule | undefined, fallback: CatalogPriceRule, headers: Set<string>): CatalogPriceRule {
    if (!saved || typeof saved !== "object") return fallback;
    const safeColumn = (value: unknown) => headers.has(String(value || "")) ? String(value) : "";
    const safeRounding: PriceRounding = ["none", "integer", "0.05", "0.10", "0.50"].includes(saved.rounding) ? saved.rounding : "none";
    return {
      mode: saved.mode === "formula" ? "formula" : "direct",
      base: saved.base === "cost" ? "cost" : "column",
      sourceColumn: safeColumn(saved.sourceColumn) || fallback.sourceColumn,
      fallbackColumns: Array.isArray(saved.fallbackColumns) ? saved.fallbackColumns.map(safeColumn).filter(Boolean) : [],
      percentOperation: saved.percentOperation === "discount" || saved.percentOperation === "markup" ? saved.percentOperation : "none",
      percentSource: saved.percentSource === "column" ? "column" : "fixed",
      percentValue: this.clampPercent(saved.percentValue),
      percentColumn: safeColumn(saved.percentColumn),
      amountOperation: saved.amountOperation === "add" || saved.amountOperation === "subtract" ? saved.amountOperation : "none",
      amountSource: saved.amountSource === "column" ? "column" : "fixed",
      amountValue: this.safeNonNegativeNumber(saved.amountValue),
      amountColumn: safeColumn(saved.amountColumn),
      rounding: safeRounding,
    };
  }

  private toV2Profile(mapping: ImportMapping, supplierId: string): CatalogImportProfileV2 {
    return {
      version: 2,
      supplier_id: supplierId,
      mapping: { ...mapping },
      identity_rules: {
        primary_barcode_column: mapping.primaryBarcodeColumn || null,
        exact_variant_columns: [mapping.supplierSkuColumn, mapping.supplierVariantColumn].filter(Boolean),
        group_columns: [mapping.genericColumn, mapping.internetColumn, mapping.modelColumn, mapping.styleColumn].filter(Boolean),
        preserve_non_indexable_evidence: true,
      },
      price_rules: {
        cost: mapping.costRule,
        clienta: mapping.clientaRule,
        cost_required: true,
      },
    };
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
    const barcodeIdentities = new Map<string, Set<string>>();
    for (const raw of rows) {
      if (raw["__row_empty"] === true || this.nonEmptyRecordCount(raw) === 0) continue;
      const sku = this.textFromColumn(raw, mapping.primaryBarcodeColumn) || this.textFromColumn(raw, mapping.supplierSkuColumn) || this.textFromColumn(raw, mapping.supplierVariantColumn);
      if (!sku) continue;
      const key = normalizeIdentifierKey(sku);
      skuCounts.set(key, (skuCounts.get(key) || 0) + 1);
      const barcodes = [mapping.primaryBarcodeColumn, ...mapping.alternateBarcodeColumns]
        .map((column) => normalizeIdentifierKey(this.textFromColumn(raw, column)))
        .filter(Boolean);
      for (const barcode of barcodes) {
        const identity = normalizeIdentifierKey(
          this.textFromColumn(raw, mapping.supplierVariantColumn)
          || [this.textFromColumn(raw, mapping.modelColumn), this.textFromColumn(raw, mapping.colorColumn), this.textFromColumn(raw, mapping.sizeColumn)].filter(Boolean).join("|")
          || this.textFromColumn(raw, mapping.supplierSkuColumn)
          || barcode,
        );
        const identities = barcodeIdentities.get(barcode) || new Set<string>();
        identities.add(identity);
        barcodeIdentities.set(barcode, identities);
      }
    }

    const normalized = rows.map((raw, idx): PreviewRow => {
      const rowNumber = Number(raw["__row_number"] || idx + 2);
      const rowEmpty = raw["__row_empty"] === true || this.nonEmptyRecordCount(raw) === 0;
      const identifiers = buildIdentifiers(raw, mapping);
      const primaryBarcode = identifiers.find((identifier) => identifier.type === "barcode" && identifier.primary)?.value || null;
      const supplierSku = identifiers.find((identifier) => identifier.type === "supplier_sku")?.value || null;
      const supplierVariant = identifiers.find((identifier) => identifier.type === "supplier_variant")?.value || null;
      const sku = primaryBarcode || supplierSku || supplierVariant || "";
      const cklassFields = this.extractCklassFields(raw);
      const duplicate = sku ? (skuCounts.get(normalizeIdentifierKey(sku)) || 0) > 1 : false;
      const barcodeConflict = identifiers
        .filter((identifier) => identifier.type === "barcode" && identifier.indexable)
        .some((identifier) => (barcodeIdentities.get(identifier.normalized_value)?.size || 0) > 1);
      const cost = evaluatePriceRule(raw, mapping.costRule, null, "Costo");
      const clienta = evaluatePriceRule(raw, mapping.clientaRule, cost.value, "Precio clienta");
      const indexableIdentity = identifiers.some((identifier) => identifier.indexable && identifier.scope === "variant");
      const warnings = [
        ...identifiers.filter((identifier) => identifier.validation_issue).map((identifier) => `${identifier.value}: ${identifier.validation_issue}`),
        ...(duplicate ? ["Identidad repetida: se consolidará y se conservará esta ubicación"] : []),
        ...cost.warnings,
        ...clienta.warnings,
        ...(clienta.issue ? [clienta.issue] : []),
      ];
      const issue = rowEmpty
        ? "Fila sin datos"
        : !indexableIdentity
          ? "No hay un identificador exacto utilizable"
          : barcodeConflict
            ? "El barcode coincide con identidades diferentes"
            : cost.issue
              ? cost.issue
              : cost.value === null || cost.value <= 0
                ? "El costo obligatorio debe ser mayor a cero"
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
        price_cost_excel: cost.sourceValue,
        price_cost_discount_pct: mapping.costRule.mode === "formula" && mapping.costRule.percentOperation === "discount" && mapping.costRule.percentSource === "fixed" ? mapping.costRule.percentValue : null,
        price_cost: cost.value,
        price_clienta_markup_pct: mapping.clientaRule.mode === "formula" && mapping.clientaRule.percentOperation === "markup" && mapping.clientaRule.percentSource === "fixed" ? mapping.clientaRule.percentValue : null,
        price_clienta: clienta.value,
        primary_barcode: primaryBarcode,
        supplier_sku: supplierSku,
        identifiers,
        prices: { cost: cost.value ?? 0, clienta: clienta.value },
        original_row: this.originalRow(raw),
        valid: !issue,
        issue,
        warnings,
      };
    });

    const validCount = normalized.filter((row) => row.valid).length;
    return {
      // La UI sólo muestra la muestra y los contadores. Evitamos clonar y
      // conservar otras ~12 mil filas normalizadas además de rawRows/matrix.
      rows: [],
      sample: normalized.slice(0, 20),
      total: normalized.length,
      valid: validCount,
      missingSku: normalized.filter((row) => row.issue === "No hay un identificador exacto utilizable").length,
      duplicateSku: normalized.filter((row) => row.warnings.some((warning) => warning.startsWith("Identidad repetida"))).length,
      invalidValues: normalized.filter((row) => !row.valid).length,
      missingCost: normalized.filter((row) => row.issue?.startsWith("Costo:") || row.issue === "El costo obligatorio debe ser mayor a cero").length,
      identifierConflicts: normalized.filter((row) => row.issue === "El barcode coincide con identidades diferentes").length,
    };
  }

  private emptyMapping(): ImportMapping {
    return {
      skuColumn: "",
      primaryBarcodeColumn: "",
      alternateBarcodeColumns: [],
      supplierSkuColumn: "",
      supplierVariantColumn: "",
      genericColumn: "",
      internetColumn: "",
      modelColumn: "",
      styleColumn: "",
      bundleColumn: "",
      ocrAliasColumns: [],
      customIdentifierColumns: [],
      nameColumns: [],
      brandColumn: "",
      categoryColumn: "",
      colorColumn: "",
      sizeColumn: "",
      priceCostColumn: "",
      impulsProductIdColumn: "",
      priceCostDiscountPct: 0,
      priceClientaMarkupPct: 0,
      costRule: emptyPriceRule("column"),
      clientaRule: emptyPriceRule("cost"),
    };
  }

  private autodetectMapping(headers: string[]): ImportMapping {
    const primaryBarcode = this.guessHeader(headers, ["sku etiqueta", "codigo_barra", "codigo barra", "codigo de barra", "barcode", "ean", "gtin"]);
    const supplierSku = this.guessHeader(headers, ["sku nazan", "sku proveedor", "supplier sku"]);
    const supplierVariant = this.guessHeader(headers, ["variante", "variant"]);
    const sku = primaryBarcode || supplierSku || supplierVariant || this.guessHeader(headers, ["sku", "codigo", "clave", "cod", "id"]);
    const name = this.guessHeader(headers, ["nombre", "producto", "descripcion", "articulo", "modelo"]);
    const costColumn = this.guessHeader(headers, ["costo", "precio costo", "cost"]);
    const costRule = emptyPriceRule("column");
    costRule.sourceColumn = costColumn;
    const clientaRule = emptyPriceRule("cost");
    return {
      skuColumn: sku,
      primaryBarcodeColumn: primaryBarcode,
      alternateBarcodeColumns: headers.filter((header) => ["sku opc 2", "sku opc 3"].includes(this.normalizeText(header))),
      supplierSkuColumn: supplierSku || (!primaryBarcode ? sku : ""),
      supplierVariantColumn: supplierVariant,
      genericColumn: this.guessHeader(headers, ["generico", "genérico"]),
      internetColumn: this.guessHeader(headers, ["cod internet", "cód. internet", "codigo internet"]),
      modelColumn: this.guessHeader(headers, ["modelo"]),
      styleColumn: this.guessHeader(headers, ["estilo"]),
      bundleColumn: this.guessHeader(headers, ["comboid", "combo", "duo", "six"]),
      ocrAliasColumns: [],
      customIdentifierColumns: [],
      nameColumns: name ? [name] : headers.filter((header) => header !== sku).slice(0, 1),
      brandColumn: this.guessHeader(headers, ["marca", "brand", "fabricante"]),
      categoryColumn: this.guessHeader(headers, ["categoria", "departamento", "linea", "familia"]),
      colorColumn: this.guessHeader(headers, ["color", "tono"]),
      sizeColumn: this.guessHeader(headers, ["talla", "medida", "size"]),
      priceCostColumn: costColumn,
      impulsProductIdColumn: this.guessHeader(headers, ["generico", "genérico", "id generico", "id genérico", "productid", "product id"]),
      priceCostDiscountPct: 0,
      priceClientaMarkupPct: 0,
      costRule,
      clientaRule,
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

  private clampPercent(value: unknown): number {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Number(number.toFixed(2))));
  }

  private safeNonNegativeNumber(value: unknown): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.max(0, Number(number.toFixed(2))) : 0;
  }

  private originalRow(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__")));
  }

  private emptyPreview(): PreviewSummary {
    return {
      rows: [],
      sample: [],
      total: 0,
      valid: 0,
      missingSku: 0,
      duplicateSku: 0,
      invalidValues: 0,
      missingCost: 0,
      identifierConflicts: 0,
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
