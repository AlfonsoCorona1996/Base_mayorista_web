import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection, LOCALE_ID } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { registerLocaleData } from "@angular/common";
import localeEsMx from "@angular/common/locales/es-MX";

import { routes } from "./app.routes";
import { authInterceptor } from "./core/interceptors/auth.interceptor";
import { retryInterceptor } from "./core/interceptors/retry.interceptor";
import { errorLoggingInterceptor } from "./core/interceptors/error-logging.interceptor";

registerLocaleData(localeEsMx);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    { provide: LOCALE_ID, useValue: "es-MX" },
    provideRouter(routes),
    provideHttpClient(
      withInterceptors([authInterceptor, retryInterceptor, errorLoggingInterceptor]),
    ),
  ],
};
