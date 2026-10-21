import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { provideRouteChunkPreload } from "./route-chunk-preload";

@Component({ template: "<p>página</p>" })
class DummyPage {}

/** R5: el código de la ruta se descarga mientras los guards (red) siguen pendientes. */
describe("provideRouteChunkPreload (R5)", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function setup(withPreload: boolean) {
    let releaseGuard: (allow: boolean) => void = () => undefined;
    const guard = () => new Promise<boolean>((resolve) => (releaseGuard = resolve));
    const loadComponent = jasmine.createSpy("loadComponent").and.callFake(() => Promise.resolve(DummyPage));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: "main", canActivate: [guard], children: [{ path: "pedidos", loadComponent }] },
          { path: "", component: DummyPage },
        ]),
        ...(withPreload ? [provideRouteChunkPreload()] : []),
      ],
    });
    return { router: TestBed.inject(Router), loadComponent, release: (allow: boolean) => releaseGuard(allow) };
  }

  it("empieza la descarga del componente antes de que el guard responda", async () => {
    const { router, loadComponent, release } = setup(true);
    const navigation = router.navigateByUrl("/main/pedidos");
    await tick();
    expect(loadComponent).withContext("descarga en paralelo con el guard").toHaveBeenCalledTimes(1);
    release(true);
    expect(await navigation).toBeTrue();
    expect(router.url).toBe("/main/pedidos");
  });

  it("sin el inicializador, Angular solo descarga después del guard (comportamiento anterior)", async () => {
    const { router, loadComponent, release } = setup(false);
    const navigation = router.navigateByUrl("/main/pedidos");
    await tick();
    expect(loadComponent).not.toHaveBeenCalled();
    release(true);
    await navigation;
    expect(loadComponent).toHaveBeenCalledTimes(1);
  });

  it("si el guard rechaza, la ruta no se activa aunque el código ya se haya descargado", async () => {
    const { router, loadComponent, release } = setup(true);
    const navigation = router.navigateByUrl("/main/pedidos");
    await tick();
    release(false);
    expect(await navigation).toBeFalse();
    expect(router.url).not.toBe("/main/pedidos");
    expect(loadComponent).toHaveBeenCalledTimes(1);
  });

  it("un fallo al descargar en paralelo no rompe la navegación (el router reintenta)", async () => {
    const { router, loadComponent, release } = setup(true);
    loadComponent.and.returnValues(Promise.reject(new Error("offline")), Promise.resolve(DummyPage));
    const navigation = router.navigateByUrl("/main/pedidos");
    await tick();
    release(true);
    expect(await navigation).toBeTrue();
    expect(loadComponent).toHaveBeenCalledTimes(2);
  });
});
