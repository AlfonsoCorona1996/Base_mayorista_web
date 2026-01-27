import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AuthService } from "./auth.service";

export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const ok = await auth.isAdmin();
  if (!ok) {
    return router.parseUrl("/login");
  }
  return true;
};
