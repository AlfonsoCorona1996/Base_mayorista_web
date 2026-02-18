import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AccessService, AppPermission } from "./access.service";
import { AuthService } from "./auth.service";

export const permissionGuard: CanActivateFn = async (route, state) => {
  const auth = inject(AuthService);
  const access = inject(AccessService);
  const router = inject(Router);

  const permission = route.data?.["permission"] as AppPermission | undefined;
  if (!permission) return true;

  const ok = await auth.isAdmin();
  if (!ok) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url },
    });
  }

  await access.refreshProfile();
  if (access.can(permission)) return true;
  return router.createUrlTree([access.firstAllowedRoute()]);
};
