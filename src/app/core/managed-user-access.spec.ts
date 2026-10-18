import { TestBed } from "@angular/core/testing";
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from "@angular/router";
import { routes } from "../app.routes";
import { adminGuard } from "./admin.guard";
import { authzGuard } from "./authz.guard";
import { AuthzService } from "./authz.service";
import { buildRolePreset } from "./rbac.constants";

describe("Acceso operativo a ventas", () => {
  const preset = buildRolePreset("operativo");
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), {
      provide: AuthzService, useValue: {
        refresh: async () => undefined,
        currentUserSig: () => ({ isActive: true }),
        canSection: (section: string) => preset.sections[section as keyof typeof preset.sections] === true,
        canCap: () => false,
      },
    }] });
  });

  it("el padre comprueba primer acceso en cada navegacion hija", () => {
    const main = routes.find((route) => route.path === "main");
    expect(main?.canActivate).toContain(adminGuard);
    expect(main?.canActivateChild).toContain(adminGuard);
  });

  for (const section of ["sections.usuarios", "sections.administracion"]) {
    it(`deniega URL manual de ${section}`, async () => {
      const result = await TestBed.runInInjectionContext(() => authzGuard(
        { data: { section } } as unknown as ActivatedRouteSnapshot,
        { url: `/main/${section.split(".")[1]}` } as RouterStateSnapshot,
      ));
      expect(result instanceof UrlTree).toBeTrue();
      expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toContain("NO_SECTION_PERMISSION");
    });
  }

  it("permite la seccion pedidos y el rol no incluye usuarios ni finanzas", async () => {
    const result = await TestBed.runInInjectionContext(() => authzGuard(
      { data: { section: "sections.pedidos" } } as unknown as ActivatedRouteSnapshot,
      { url: "/main/pedidos" } as RouterStateSnapshot,
    ));
    expect(result).toBeTrue();
    expect(preset.sections["sections.administracion"]).toBeFalse();
    expect(preset.sections["sections.usuarios"]).toBeFalse();
    for (const [key, enabled] of Object.entries(preset.capabilities)) {
      if (/^cap\.(users|roles|finance)\./.test(key)) expect(enabled).toBeFalse();
    }
  });
});
