import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AuthService } from "./auth.service";

export const adminGuard: CanActivateFn = async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const ok = await auth.isAdmin();
  if (!ok) {
    // 🔑 DEEP LINKING: Guardar la URL de destino
    console.log('🔗 Usuario no autenticado, guardando returnUrl:', state.url);
    return router.createUrlTree(['/login'], { 
      queryParams: { returnUrl: state.url } 
    });
  }
  return true;
};
