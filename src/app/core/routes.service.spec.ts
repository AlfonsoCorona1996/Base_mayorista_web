import { TestBed } from "@angular/core/testing";
import { RoutesService } from "./routes.service";

/** R5: Pedidos pide las rutas desde el resolver y desde la página; se lee una sola vez. */
describe("RoutesService.loadFromFirestore (R5)", () => {
  let service: RoutesService;
  let fetchRoutes: jasmine.Spy<() => Promise<void>>;

  beforeEach(() => {
    service = TestBed.inject(RoutesService);
    fetchRoutes = spyOn(service as unknown as { fetchRoutes(): Promise<void> }, "fetchRoutes");
  });

  it("comparte la lectura en curso y vuelve a leer cuando termina", async () => {
    let release: () => void = () => undefined;
    fetchRoutes.and.callFake(() => new Promise<void>((resolve) => (release = resolve)));
    const first = service.loadFromFirestore();
    const second = service.loadFromFirestore();
    expect(fetchRoutes).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    fetchRoutes.and.resolveTo();
    await service.loadFromFirestore();
    expect(fetchRoutes).withContext("una visita posterior vuelve a leer").toHaveBeenCalledTimes(2);
  });

  it("un fallo se entrega a todos los que esperaban y no deja la lectura bloqueada", async () => {
    fetchRoutes.and.rejectWith(new Error("unavailable"));
    const results = await Promise.allSettled([service.loadFromFirestore(), service.loadFromFirestore()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    fetchRoutes.and.resolveTo();
    await service.loadFromFirestore();
    expect(fetchRoutes).toHaveBeenCalledTimes(2);
  });
});
