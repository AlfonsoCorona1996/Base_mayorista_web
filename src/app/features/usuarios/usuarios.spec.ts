import { TestBed } from "@angular/core/testing";
import { AuthzService } from "../../core/authz.service";
import { ImpersonationService } from "../../core/impersonation.service";
import { RolesService } from "../../services/roles.service";
import { UserAdminApiService } from "../../services/user-admin-api.service";
import UsuariosPage from "./usuarios";

describe("UsuariosPage: creacion", () => {
  let page: UsuariosPage;
  let create: jasmine.Spy;
  let permitted: boolean;
  beforeEach(async () => {
    permitted = true;
    create = jasmine.createSpy("createManagedUser").and.resolveTo({ uid: "new-user", temporaryPassword: "solo-prueba" });
    spyOn(UsuariosPage.prototype as unknown as { loadStoredBusinessMemberships(): Promise<Record<string, unknown>> }, "loadStoredBusinessMemberships").and.resolveTo({});
    TestBed.configureTestingModule({ providers: [
      { provide: AuthzService, useValue: { refresh: async () => undefined, isRealSuperAdmin: () => permitted, isImpersonatingSig: () => false, currentUserSig: () => ({ uid: "admin" }), canSection: () => permitted, canCap: () => permitted } },
      { provide: RolesService, useValue: { ensureDefaultsSeeded: async () => undefined, listRoles: async () => [] } },
      { provide: UserAdminApiService, useValue: { listManagedUsers: async () => [], createManagedUser: create } },
      { provide: ImpersonationService, useValue: {} },
    ] });
    page = TestBed.runInInjectionContext(() => new UsuariosPage());
    await page.reload();
    page.newDisplayName.set("Jazmin");
    page.newUsername.set("Jazmin");
    page.newLoginType.set("username");
  });

  it("crea Jazmin con rol operativo, conserva password temporal y confirma el alta", async () => {
    await page.createUser();
    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.calls.mostRecent().args[0];
    expect(payload.username).toBe("Jazmin");
    expect(payload.roleId).toBe("operativo");
    expect(payload.permissions.administracion).toBeFalse();
    expect(payload.permissions.usuarios).toBeFalse();
    expect(payload.businessMemberships.bm.enabled).toBeTrue();
    expect(page.tempPasswordOut()?.password).toBe("solo-prueba");
    expect(page.success()).toBe("Usuario creado.");
  });

  it("rechaza caracteres invalidos sin transformarlos silenciosamente", async () => {
    page.newUsername.set("Jaz min");
    await page.createUser();
    expect(create).not.toHaveBeenCalled();
    expect(page.error()).toContain("3 y 64");
  });

  it("rechaza otro envio mientras hay una creacion pendiente", async () => {
    page.saving.set(true);
    await page.createUser();
    expect(create).not.toHaveBeenCalled();
  });

  it("un usuario sin permisos no invoca el alta", async () => {
    permitted = false;
    await page.createUser();
    expect(create).not.toHaveBeenCalled();
  });
});
