import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { retry, throwError, timer } from "rxjs";

/**
 * Reintenta automáticamente peticiones fallidas por errores de servidor (5xx) o red.
 * No reintenta errores de cliente (4xx) para no enmascarar problemas de datos o permisos.
 * Usa backoff lineal: 800ms en el 1er reintento, 1600ms en el 2do.
 */
export const retryInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req).pipe(
    retry({
      count: 2,
      delay: (error, attempt) => {
        if (error instanceof HttpErrorResponse && error.status >= 400 && error.status < 500) {
          return throwError(() => error);
        }
        return timer(attempt * 800);
      },
    }),
  );
};
