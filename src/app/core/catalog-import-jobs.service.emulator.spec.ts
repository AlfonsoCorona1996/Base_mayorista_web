import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, createUserWithEmailAndPassword } from "firebase/auth";
import { connectFirestoreEmulator, doc, serverTimestamp, setDoc } from "firebase/firestore";

import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { BusinessScopeService } from "./business-scope.service";
import { CatalogImportJobsService } from "./catalog-import-jobs.service";

/**
 * Prueba de integracion contra el emulador local de Firebase (Firestore + Auth).
 * NO corre en `npm test` normal (angular.json excluye **\/*.emulator.spec.ts):
 * solo se ejecuta explicitamente con los emuladores levantados, ej.:
 *   npx firebase --config firebase.emulator-test.json emulators:start --project demo-test --only firestore,auth
 *   npx ng test --include="**\/catalog-import-jobs.service.emulator.spec.ts" --exclude=""
 * (--exclude="" es necesario: angular.json excluye *.emulator.spec.ts por
 * defecto y --include por sí solo no lo revierte).
 *
 * Cubre que CatalogImportJobsService.watch() (listener en vivo de Firestore,
 * no HTTP al backend) refleja correctamente los nuevos estados de la cola de
 * importacion (queued_validation, validated como "activo", etc.) apenas
 * cambia el documento — es la pieza que alimenta el toast global y el panel
 * de cola en el wizard.
 */
let emulatorsConnected = false;

function connectEmulatorsOnce(): void {
  if (emulatorsConnected) return;
  connectFirestoreEmulator(FIRESTORE, "127.0.0.1", 8080);
  connectAuthEmulator(FIREBASE_AUTH, "http://127.0.0.1:9099", { disableWarnings: true });
  emulatorsConnected = true;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: se agotó el tiempo de espera");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("CatalogImportJobsService.watch() — listener en vivo (emulador)", () => {
  beforeAll(async () => {
    connectEmulatorsOnce();
    // Solo necesitamos un usuario autenticado para que las reglas de Firestore
    // (request.auth != null) permitan leer/escribir en el emulador — nada
    // de esto pasa por el backend Express real, así que no hace falta el
    // bootstrap completo de AuthzService/UsersService (que sí llama al API).
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: BusinessScopeService, useValue: { availableBusinessIds: () => ["catalogo", "bm"] } },
      ],
    });

    const email = `test-import-jobs-${Date.now()}@example.com`;
    await createUserWithEmailAndPassword(FIREBASE_AUTH, email, "Test1234!");
  });

  it("refleja en vivo un job que pasa de queued_validation a validated (activo, esperando confirmar)", async () => {
    const service = TestBed.inject(CatalogImportJobsService);
    service.watch();

    const jobId = `test_job_${Date.now()}`;
    await setDoc(doc(FIRESTORE, "catalog_import_jobs", jobId), {
      job_id: jobId,
      business_id: "catalogo",
      supplier_id: "impuls",
      supplier_name: "Impuls",
      file_name: "catalogo.xlsx",
      status: "queued_validation",
      total_rows: 100,
      valid_rows: 0,
      processed_rows: 0,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    await waitFor(() => service.jobs().some((job) => job.job_id === jobId));
    let job = service.jobs().find((j) => j.job_id === jobId);
    expect(job?.status).toBe("queued_validation");
    expect(service.activeJobs().some((j) => j.job_id === jobId)).toBe(true);
    expect(service.jobStatusLabel(job!)).toBe("En espera de revisión");

    // El worker de verdad haría esto en el backend; aquí simulamos el resultado
    // final de la validación para confirmar que el listener del frontend lo capta.
    await setDoc(
      doc(FIRESTORE, "catalog_import_jobs", jobId),
      { status: "validated", valid_rows: 90, processed_rows: 0, updated_at: serverTimestamp() },
      { merge: true },
    );

    await waitFor(() => service.jobs().find((j) => j.job_id === jobId)?.status === "validated");
    job = service.jobs().find((j) => j.job_id === jobId);
    expect(job?.status).toBe("validated");
    // "validated" cuenta como activo (esperando que el usuario confirme el commit),
    // esto es justo lo que hace que el toast global no desaparezca entre validar y confirmar.
    expect(service.activeJobs().some((j) => j.job_id === jobId)).toBe(true);
    expect(service.visibleToastJob()?.job_id).toBe(jobId);

    service.dismissToast(jobId);
    expect(service.visibleToastJob()).toBeNull();

    await setDoc(
      doc(FIRESTORE, "catalog_import_jobs", jobId),
      { status: "completed", processed_rows: 90, updated_at: serverTimestamp() },
      { merge: true },
    );
    await waitFor(() => service.jobs().find((j) => j.job_id === jobId)?.status === "completed");
    expect(service.activeJobs().some((j) => j.job_id === jobId)).toBe(false);
    expect(service.completedJobs().some((j) => j.job_id === jobId)).toBe(true);

    service.stop();
  });
});
