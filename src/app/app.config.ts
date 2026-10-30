import { ApplicationConfig, LOCALE_ID, isDevMode, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { registerLocaleData } from "@angular/common";
import localeEsMx from "@angular/common/locales/es-MX";
import { provideServiceWorker } from "@angular/service-worker";

import { routes } from "./app.routes";
import { authInterceptor } from "./core/interceptors/auth.interceptor";
import { retryInterceptor } from "./core/interceptors/retry.interceptor";
import { errorLoggingInterceptor } from "./core/interceptors/error-logging.interceptor";
import { providePerfNavigationTracking } from "./core/perf-metrics.service";
import { provideRouteChunkPreload } from "./core/route-chunk-preload";
import { bootedOnLightweightPublicPath } from "./core/public-landing";

registerLocaleData(localeEsMx);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    { provide: LOCALE_ID, useValue: "es-MX" },
    provideRouter(routes),
    // Solo se suscribe al Router si las métricas de rendimiento están activas.
    providePerfNavigationTracking(),
    // Descarga el código de la ruta mientras se resuelven los guards (no lee datos).
    provideRouteChunkPreload(),
    provideHttpClient(
      withInterceptors([authInterceptor, retryInterceptor, errorLoggingInterceptor]),
    ),
    provideServiceWorker("ngsw-worker.js", {
      // La encuesta pública no registra el SW: evita descargar todo el panel en datos móviles.
      enabled: !isDevMode() && !bootedOnLightweightPublicPath(),
      registrationStrategy: "registerWhenStable:30000",
    }),
  ],
};
