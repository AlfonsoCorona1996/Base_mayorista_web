import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { retry, throwError, timer } from "rxjs";

/**
 * Reintenta automáticamente peticiones fallidas por errores de servidor (5xx) o red.
 * No reintenta errores de cliente (4xx) para no enmascarar problemas de datos o permisos.
 * Usa backoff lineal: 800ms en el 1er reintento, 1600ms en el 2do.
 *
 * Solo aplica a GET/HEAD: son idempotentes por definición. Un POST/PUT/DELETE que
 * tarda en responder (p.ej. un 504 de Nginx en una importación grande) puede seguir
 * corriendo en el servidor aunque el cliente ya haya "fallado"; reintentarlo a ciegas
 * duplica el efecto (dos validaciones, dos pedidos, etc.) en vez de recuperarse del error.
 */
export const retryInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next(req);
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
