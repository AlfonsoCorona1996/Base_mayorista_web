import { HttpInterceptorFn } from "@angular/common/http";
import { from, switchMap } from "rxjs";
import { FIREBASE_AUTH } from "../firebase.providers";

/**
 * Inyecta automáticamente el token Firebase en cada petición HTTP.
 * Para métodos no-GET fuerza refresh del token para evitar tokens expirados en escrituras.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const currentUser = FIREBASE_AUTH.currentUser;
  if (!currentUser) return next(req);

  const forceRefresh = req.method !== "GET";

  return from(currentUser.getIdToken(forceRefresh)).pipe(
    switchMap((token) =>
      next(
        req.clone({
          setHeaders: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        }),
      ),
    ),
  );
};
