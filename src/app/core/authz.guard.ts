import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AuthzService } from "./authz.service";

export const authzGuard: CanActivateFn = async (route, state) => {
  const authz = inject(AuthzService);
  const router = inject(Router);

  await authz.refresh();
  let current = authz.currentUserSig();
  if (!current?.isActive) {
    await authz.refresh({ force: true });
    current = authz.currentUserSig();
  }
  if (!current?.isActive) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url, reason: "INACTIVE_USER" },
    });
  }
  const requiredSection = route.data?.["section"] as string | undefined;
  const requiredCapability = route.data?.["capability"] as string | undefined;

  if (requiredSection && !authz.canSection(requiredSection)) {
    await authz.refresh({ force: true });
  }
  if (requiredSection && !authz.canSection(requiredSection)) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url, reason: "NO_SECTION_PERMISSION", section: requiredSection },
    });
  }

  if (requiredCapability && !authz.canCap(requiredCapability)) {
    await authz.refresh({ force: true });
  }
  if (requiredCapability && !authz.canCap(requiredCapability)) {
    return router.createUrlTree(["/login"], {
      queryParams: { returnUrl: state.url, reason: "NO_CAPABILITY_PERMISSION", capability: requiredCapability },
    });
  }

  return true;
};
