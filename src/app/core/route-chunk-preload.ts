import { EnvironmentInjector, EnvironmentProviders, inject, provideEnvironmentInitializer, runInInjectionContext } from "@angular/core";
import { ActivatedRouteSnapshot, Router, RoutesRecognized } from "@angular/router";
import { isObservable } from "rxjs";

/**
 * Angular descarga el código de una ruta `loadComponent` solo después de resolver todos sus
 * guards. En /main/pedidos eso es Auth, el bootstrap de sesión (red) y el permiso; con caché fría
 * el chunk de Pedidos esperaba a esa cadena. Este inicializador empieza la descarga en cuanto la
 * URL se reconoce, en paralelo con los guards.
 *
 * Solo adelanta código público del bundle: los guards siguen decidiendo el acceso, no se crea
 * ningún componente y no se lee ningún dato. Si el guard redirige, la descarga se desperdicia.
 */
export function provideRouteChunkPreload(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    const injector = inject(EnvironmentInjector);
    inject(Router).events.subscribe((event) => {
      if (event instanceof RoutesRecognized) preloadRouteChunks(event.state.root, injector);
    });
  });
}

/** Inicia la carga de cada `loadComponent` de la ruta reconocida. Devuelve cuántas inició. */
export function preloadRouteChunks(root: ActivatedRouteSnapshot, injector: EnvironmentInjector): number {
  let started = 0;
  const visit = (node: ActivatedRouteSnapshot): void => {
    const load = node.routeConfig?.loadComponent;
    if (load) {
      started += 1;
      try {
        // El router vuelve a llamar a loadComponent después de los guards; el módulo ya está en
        // la caché de import() y no se descarga dos veces.
        const result = runInInjectionContext(injector, () => load());
        if (isObservable(result)) result.subscribe({ error: () => undefined });
        else if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // Si falla aquí, el router lo intentará de nuevo y mostrará su propio error.
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return started;
}
