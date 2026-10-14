import { inject } from "@angular/core";
import { CanActivateFn, Router } from "@angular/router";
import { AuthService } from "./auth.service";
import { PerfMetricsService, firebaseErrorCode } from "./perf-metrics.service";

export const adminGuard: CanActivateFn = async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const perf = inject(PerfMetricsService);
  const startedAt = perf.now();

  try {
    const decision = await evaluateAccess();
    perf.record("auth_guard_ms", startedAt, { result: "success", outcome: decision === true ? "allow" : "redirect" });
    return decision;
  } catch (error) {
    perf.record("auth_guard_ms", startedAt, { result: "error", error_code: firebaseErrorCode(error) });
    throw error;
  }

  async function evaluateAccess() {
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
  }
};
