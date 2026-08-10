import { TestBed } from "@angular/core/testing";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { BusinessScopeService } from "./business-scope.service";
import { CatalogImportJob, CatalogImportJobsService } from "./catalog-import-jobs.service";

function rawJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    job_id: "job_1",
    business_id: "catalogo",
    file_name: "catalogo.xlsx",
    status: "uploaded",
    total_rows: 0,
    valid_rows: 0,
    processed_rows: 0,
    ...overrides,
  };
}

describe("CatalogImportJobsService", () => {
  let service: CatalogImportJobsService;

  beforeEach(() => {
    const api = jasmine.createSpyObj<UserAdminApiService>("UserAdminApiService", ["get", "post", "put", "delete"]);
    TestBed.configureTestingModule({
      providers: [
        CatalogImportJobsService,
        { provide: UserAdminApiService, useValue: api },
        { provide: BusinessScopeService, useValue: { availableBusinessIds: () => ["catalogo"] } },
      ],
    });
    service = TestBed.inject(CatalogImportJobsService);
  });

  describe("jobFromRaw / percent calculation", () => {
    it("acepta el estado queued_validation en vez de degradarlo a queued", () => {
      const job = service.jobFromRaw(rawJob({ status: "queued_validation" }));
      expect(job?.status).toBe("queued_validation");
    });

    it("cae a queued si el backend manda un estado desconocido", () => {
      const job = service.jobFromRaw(rawJob({ status: "algo_nuevo_no_soportado" }));
      expect(job?.status).toBe("queued");
    });

    it("calcula el porcentaje sobre valid_rows cuando hay filas validas", () => {
      const job = service.jobFromRaw(rawJob({ status: "committing", valid_rows: 200, processed_rows: 50 }));
      expect(job?.percent).toBe(25);
    });

    it("usa total_rows como base si aun no hay valid_rows (antes de terminar de validar)", () => {
      const job = service.jobFromRaw(rawJob({ status: "parsing", total_rows: 100, valid_rows: 0, processed_rows: 10 }));
      expect(job?.percent).toBe(10);
    });

    it("siempre reporta 100% para un job completado, sin importar processed_rows", () => {
      const job = service.jobFromRaw(rawJob({ status: "completed", valid_rows: 10, processed_rows: 3 }));
      expect(job?.percent).toBe(100);
    });

    it("regresa null para un payload vacio", () => {
      expect(service.jobFromRaw(null)).toBeNull();
      expect(service.jobFromRaw(undefined)).toBeNull();
    });
  });

  describe("activeJobs / latestActiveJob / completedJobs", () => {
    function setJobs(statuses: CatalogImportJob["status"][]): void {
      service.jobs.set(statuses.map((status, index) => service.jobFromRaw(rawJob({ job_id: `job_${index}`, status }))!));
    }

    it("excluye completed, failed y needs_mapping de los activos", () => {
      setJobs(["completed", "failed", "needs_mapping", "uploaded", "queued_validation", "parsing", "validated", "queued", "committing", "running"]);
      const activeStatuses = service.activeJobs().map((job) => job.status);
      expect(activeStatuses).not.toContain("completed");
      expect(activeStatuses).not.toContain("failed");
      expect(activeStatuses).not.toContain("needs_mapping");
      expect(activeStatuses.length).toBe(7);
    });

    it("incluye validated como activo (esperando confirmar el commit)", () => {
      setJobs(["validated"]);
      expect(service.activeJobs().length).toBe(1);
      expect(service.latestActiveJob()?.status).toBe("validated");
    });

    it("completedJobs solo trae los que terminaron", () => {
      setJobs(["completed", "failed", "validated"]);
      expect(service.completedJobs().length).toBe(1);
      expect(service.completedJobs()[0].status).toBe("completed");
    });
  });

  describe("dismissToast / visibleToastJob", () => {
    it("oculta el toast solo para el job cerrado, no para importaciones nuevas", () => {
      const jobA = service.jobFromRaw(rawJob({ job_id: "job_a", status: "parsing" }))!;
      service.jobs.set([jobA]);
      expect(service.visibleToastJob()?.job_id).toBe("job_a");

      service.dismissToast("job_a");
      expect(service.visibleToastJob()).toBeNull();

      const jobB = service.jobFromRaw(rawJob({ job_id: "job_b", status: "committing" }))!;
      service.jobs.set([jobB]);
      expect(service.visibleToastJob()?.job_id).toBe("job_b");
    });
  });

  describe("jobStatusLabel — lenguaje humano, sin jerga de programador", () => {
    const JARGON_WORDS = ["job", "lease", "commit", "worker", "backend", "query", "firebase", "mapeo"];

    it("etiqueta cada fase del pipeline de forma distinta y sin tecnicismos", () => {
      const label = (status: CatalogImportJob["status"]) => service.jobStatusLabel(service.jobFromRaw(rawJob({ status }))!);
      const allStatuses: CatalogImportJob["status"][] = [
        "uploaded", "queued_validation", "parsing", "needs_mapping", "validated",
        "queued", "committing", "running", "completed", "failed",
      ];
      const labels = allStatuses.map(label);
      // Cada fase visible al usuario debe tener su propio texto (nada de reciclar "En proceso" para todo).
      expect(new Set(labels).size).toBeGreaterThanOrEqual(allStatuses.length - 2);
      for (const text of labels) {
        for (const jargon of JARGON_WORDS) {
          expect(text.toLowerCase()).not.toContain(jargon);
        }
      }
      expect(label("queued_validation")).toBe("En espera de revisión");
      expect(label("parsing")).toBe("Revisando tu archivo...");
      expect(label("needs_mapping")).toBe("No encontramos filas válidas — revisa el archivo");
      expect(label("validated")).toBe("Listo para aplicar");
      expect(label("queued")).toBe("En espera para aplicarse");
      expect(label("committing")).toBe("Aplicando los cambios...");
      expect(label("completed")).toBe("Completada");
      expect(label("failed")).toBe("No se pudo completar");
    });
  });

  describe("isStale — detecta cuando un job dejó de avanzar", () => {
    function timestampMinutesAgo(minutes: number) {
      const ms = Date.now() - minutes * 60_000;
      return { toMillis: () => ms };
    }

    it("marca atorado un job activo sin ningún cambio en varios minutos", () => {
      const job = service.jobFromRaw(rawJob({ status: "committing", updated_at: timestampMinutesAgo(5) }))!;
      expect(service.isStale(job)).toBe(true);
      expect(service.jobStatusLabel(job)).toBe("Parece atorado — sin avance hace varios minutos");
      expect(service.jobStatusClass(job)).toBe("danger");
    });

    it("no marca atorado un job activo con un cambio reciente", () => {
      const job = service.jobFromRaw(rawJob({ status: "committing", updated_at: timestampMinutesAgo(0.5) }))!;
      expect(service.isStale(job)).toBe(false);
    });

    it("no marca atorado un job ya terminado, sin importar hace cuánto se actualizó", () => {
      const job = service.jobFromRaw(rawJob({ status: "completed", updated_at: timestampMinutesAgo(120) }))!;
      expect(service.isStale(job)).toBe(false);
    });

    it("no marca atorado un job sin ninguna marca de tiempo todavía", () => {
      const job = service.jobFromRaw(rawJob({ status: "committing" }))!;
      expect(service.isStale(job)).toBe(false);
    });
  });
});
