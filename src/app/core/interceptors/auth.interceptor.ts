import { HttpInterceptorFn } from "@angular/common/http";
import { from, switchMap } from "rxjs";
import { FIREBASE_AUTH } from "../firebase.providers";

/**
 * Inyecta automáticamente el token Firebase en cada petición HTTP.
 * Firebase renueva por sí mismo los tokens expirados o próximos a expirar. No
 * forzamos una renovación en cada escritura porque eso agrega una llamada de
 * red a Firebase Auth antes de cada petición al backend.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const currentUser = FIREBASE_AUTH.currentUser;
  if (!currentUser) return next(req);

  const isMultipart = typeof FormData !== "undefined" && req.body instanceof FormData;

  return from(currentUser.getIdToken()).pipe(
    switchMap((token) =>
      next(
        req.clone({
          setHeaders: {
            // El navegador debe generar el boundary de multipart/form-data.
            ...(!isMultipart ? { "Content-Type": "application/json" } : {}),
            Authorization: `Bearer ${token}`,
          },
        }),
      ),
    ),
  );
};
