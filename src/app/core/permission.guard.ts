import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AccessService, AppPermission } from "./access.service";

export const permissionGuard: CanActivateFn = async (route, state) => {
  const access = inject(AccessService);
  const router = inject(Router);

  const permission = route.data?.["permission"] as AppPermission | undefined;
  if (!permission) return true;

  const profile = await access.refreshProfile();
  if (!profile?.active) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url, reason: "INACTIVE_USER" },
    });
  }

  if (access.can(permission)) return true;
  return router.createUrlTree(["/login"], {
    queryParams: { returnUrl: state.url, reason: "NO_ROUTE_PERMISSION", permission },
  });
};
