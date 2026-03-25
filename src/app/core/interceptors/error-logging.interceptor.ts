import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { catchError, throwError } from "rxjs";
import { environment } from "../../../environments/environment";

/**
 * Registra todos los errores HTTP en la consola (solo en desarrollo).
 * Punto central para integrar en el futuro un servicio de monitoreo (Sentry, etc.).
 */
export const errorLoggingInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req).pipe(
    catchError((error) => {
      if (!environment.production && error instanceof HttpErrorResponse) {
        console.error(`[HTTP] ${req.method} ${req.url} → ${error.status}`, error.message);
      }
      return throwError(() => error);
    }),
  );
};
