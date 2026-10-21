import { provideHttpClient } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from "@angular/router";
import { SessionBootstrapUser, UserAdminApiService } from "../services/user-admin-api.service";
import { adminGuard } from "./admin.guard";
import { AccessStatus, AuthService } from "./auth.service";

/**
 * Pruebas de caracterización: la instrumentación de FIX 01 solo mide. Las decisiones
 * del guard y el caché/deduplicación del bootstrap de sesión deben seguir iguales.
 */
describe("FIX 01 - la instrumentación no cambia autenticación", () => {
  describe("adminGuard", () => {
    let status: AccessStatus;

    beforeEach(() => {
      status = { uid: "u1", roleId: "admin", isActive: true, invitePending: false, mustChangePassword: false };
      TestBed.configureTestingModule({
        providers: [provideRouter([]), { provide: AuthService, useValue: { getAccessStatus: async () => status } }],
      });
    });

    async function decide(): Promise<string | boolean> {
      const state = { url: "/main/pedidos" } as RouterStateSnapshot;
      const result = await TestBed.runInInjectionContext(() => adminGuard({} as ActivatedRouteSnapshot, state));
      if (result instanceof UrlTree) return TestBed.inject(Router).serializeUrl(result);
      return result as boolean;
    }

    it("permite el acceso a una sesión activa", async () => {
      expect(await decide()).toBeTrue();
    });

    it("redirige a login sin sesión", async () => {
      status = { ...status, uid: null };
      expect(await decide()).toBe("/login?returnUrl=%2Fmain%2Fpedidos&reason=UNAUTHENTICATED");
    });

    it("redirige a activación si hay invitación o cambio de contraseña pendiente", async () => {
      status = { ...status, invitePending: true };
      expect(await decide()).toBe("/activate-account");
      status = { ...status, invitePending: false, mustChangePassword: true };
      expect(await decide()).toBe("/activate-account");
    });

    it("redirige a login a una cuenta inactiva", async () => {
      status = { ...status, isActive: false };
      expect(await decide()).toBe("/login?returnUrl=%2Fmain%2Fpedidos&reason=INACTIVE_USER");
    });

    it("propaga los errores igual que antes", async () => {
      TestBed.overrideProvider(AuthService, { useValue: { getAccessStatus: async () => { throw new Error("red"); } } });
      await expectAsync(decide()).toBeRejectedWithError("red");
    });
  });

  describe("UserAdminApiService.getSessionBootstrap", () => {
    const user: SessionBootstrapUser = {
      gender: null,
      uid: "u1", email: null, username: "u1", displayName: null, roleId: "admin", isActive: true,
      invitePending: false, mustChangePassword: false, sections: null, capabilities: null, businessMemberships: null,
    };
    let service: UserAdminApiService;
    let fetch: jasmine.Spy;

    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [provideHttpClient()] });
      service = TestBed.inject(UserAdminApiService);
      spyOn(console, "info");
      // Se simula solo la petición HTTP: caché, promesa compartida y proyección son las reales.
      fetch = spyOn(service as unknown as { request(path: string, init: RequestInit): Promise<unknown> }, "request");
    });

    it("comparte la petición en curso y reutiliza el caché de 60 s", async () => {
      fetch.and.resolveTo({ user });
      const [a, b] = await Promise.all([service.getSessionBootstrap(), service.getSessionBootstrap()]);
      const c = await service.getSessionBootstrap();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("/admin/users/session/bootstrap", { method: "GET" });
      expect(a).toEqual(user);
      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    it("propaga el error a todos los que esperaban y el siguiente intento vuelve a pedir", async () => {
      fetch.and.rejectWith(new Error("503"));
      const results = await Promise.allSettled([service.getSessionBootstrap(), service.getSessionBootstrap()]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      fetch.and.resolveTo({ user });
      expect(await service.getSessionBootstrap()).toEqual(user);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
