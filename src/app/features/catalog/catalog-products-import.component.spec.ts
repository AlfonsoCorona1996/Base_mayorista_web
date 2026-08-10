import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { CatalogProductsService } from "../../core/catalog-products.service";
import { CatalogImportJob, CatalogImportJobsService } from "../../core/catalog-import-jobs.service";
import { Supplier, SuppliersService } from "../../core/suppliers.service";
import { ApiError } from "../../services/user-admin-api.service";
import { CatalogProductsImportComponent } from "./catalog-products-import.component";

const SUPPLIER: Supplier = {
  supplier_id: "impuls",
  business_id: "catalogo",
  display_name: "Impuls",
  active: true,
} as Supplier;

function existingJob(): CatalogImportJob {
  return {
    job_id: "job_existing",
    business_id: "catalogo",
    file_name: "otro.xlsx",
    status: "parsing",
    supplier_id: "impuls",
    supplier_name: "Impuls",
  } as CatalogImportJob;
}

describe("CatalogProductsImportComponent — duplicados de importación", () => {
  let component: CatalogProductsImportComponent;
  let importJobs: jasmine.SpyObj<CatalogImportJobsService>;

  beforeEach(() => {
    const catalogProducts = jasmine.createSpyObj<CatalogProductsService>(
      "CatalogProductsService",
      ["stopWatchingPage", "watchCatalogPage", "loadMoreCatalogPage", "getMetrics"],
      { catalogoPageProducts: signal([]), pageState: signal({ rows: [], loading: false, error: null, hasMore: false }) },
    );
    const suppliers = jasmine.createSpyObj<SuppliersService>("SuppliersService", ["getActiveByBusiness", "loadFromFirestore"]);
    suppliers.getActiveByBusiness.and.returnValue([SUPPLIER]);
    suppliers.loadFromFirestore.and.returnValue(Promise.resolve());

    importJobs = jasmine.createSpyObj<CatalogImportJobsService>(
      "CatalogImportJobsService",
      ["watch", "createJob", "uploadSourceFile", "saveJobProfile", "validate", "commit", "jobFromRaw", "jobStatusLabel", "jobStatusClass"],
      { jobs: signal([]) },
    );

    TestBed.configureTestingModule({
      providers: [
        CatalogProductsImportComponent,
        { provide: CatalogProductsService, useValue: catalogProducts },
        { provide: SuppliersService, useValue: suppliers },
        { provide: CatalogImportJobsService, useValue: importJobs },
      ],
    });
    component = TestBed.inject(CatalogProductsImportComponent);

    // Satisface canImport(): proveedor elegido, un mapeo minimo valido, preview con filas validas y un archivo "seleccionado".
    component.selectedSupplierId.set(SUPPLIER.supplier_id);
    component.fileName.set("catalogo.xlsx");
    component.mapping.update((current) => ({
      ...current,
      primaryBarcodeColumn: "SKU",
      costRule: { ...current.costRule, sourceColumn: "COSTO" },
    }));
    (component as unknown as { previewState: { update: (fn: (p: unknown) => unknown) => void } }).previewState.update(
      (preview: any) => ({ ...preview, valid: 3, total: 3, identifierConflicts: 0, invalidValues: 0 }),
    );
    (component as unknown as { selectedSourceFile: File | null }).selectedSourceFile = new File(["x"], "catalogo.xlsx");
  });

  it("cuando createJob() rechaza con DUPLICATE_ACTIVE_IMPORT, muestra el aviso y salta al job existente en la cola", async () => {
    const duplicate = new ApiError(
      "Ya hay una importación en curso para Impuls; ábrela en la cola en vez de crear otra",
      "DUPLICATE_ACTIVE_IMPORT",
      409,
      { existing_job: { job_id: "job_existing" } },
    );
    importJobs.createJob.and.returnValue(Promise.reject(duplicate));
    importJobs.jobFromRaw.and.returnValue(existingJob());

    await component.importValidRows();

    expect(component.error()).toBe(duplicate.message);
    expect(component.duplicateActiveJob()?.job_id).toBe("job_existing");
    expect(component.selectedJobId()).toBe("job_existing");
    expect(component.consoleTab()).toBe("imports");
    expect(component.importing()).toBe(false);
    // No debió avanzar a subir archivo ni a validar: el job nunca se creó de verdad.
    expect(importJobs.uploadSourceFile).not.toHaveBeenCalled();
    expect(importJobs.validate).not.toHaveBeenCalled();
  });

  it("con un error normal (no duplicado) solo muestra el mensaje, sin tocar la cola", async () => {
    importJobs.createJob.and.returnValue(Promise.reject(new Error("Fallo de red")));

    await component.importValidRows();

    expect(component.error()).toBe("Fallo de red");
    expect(component.duplicateActiveJob()).toBeNull();
  });

  it("un job creado y validado con éxito no dispara el commit automáticamente (la validación ahora es asíncrona)", async () => {
    const createdJob = { job_id: "job_new", supplier_id: "impuls" } as CatalogImportJob;
    importJobs.createJob.and.returnValue(Promise.resolve(createdJob));
    importJobs.uploadSourceFile.and.returnValue(Promise.resolve(createdJob));
    importJobs.saveJobProfile.and.returnValue(Promise.resolve(createdJob));
    importJobs.validate.and.returnValue(Promise.resolve({ ok: true, job: { ...createdJob, status: "queued_validation" } } as any));

    await component.importValidRows();

    expect(importJobs.validate).toHaveBeenCalledWith("job_new");
    expect(importJobs.commit).not.toHaveBeenCalled();
    expect(component.success()).toContain("en cola");
  });
});
