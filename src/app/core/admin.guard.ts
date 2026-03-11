import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AuthService } from "./auth.service";

export const adminGuard: CanActivateFn = async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const status = await auth.getAccessStatus();
  if (!status.uid) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url, reason: "UNAUTHENTICATED" },
    });
  }

  if (status.mustChangePassword || status.invitePending) {
    return router.createUrlTree(["/activate-account"]);
  }

  if (!status.isActive) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url, reason: "INACTIVE_USER" },
    });
  }

  return true;
};
