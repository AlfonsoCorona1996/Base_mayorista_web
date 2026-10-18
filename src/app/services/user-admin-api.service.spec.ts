import { provideHttpClient } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { buildRolePreset } from "../core/rbac.constants";
import { AdminPermissionsPayload, UserAdminApiService } from "./user-admin-api.service";

describe("UserAdminApiService: alta y primer acceso", () => {
  let service: UserAdminApiService;
  let request: jasmine.Spy;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    service = TestBed.inject(UserAdminApiService);
    request = spyOn(service as unknown as { request(path: string, init: RequestInit): Promise<unknown> }, "request");
  });

  it("conserva Jazmin y envia las membresias al backend sin iniciar otra sesion", async () => {
    request.and.resolveTo({ uid: "new-user", username: "Jazmin", temporary_password: "emulator-only", invite_pending: true, must_change_password: true });
    const preset = buildRolePreset("operativo");
    const membership = { bm: { businessId: "bm" as const, enabled: true, roleId: "operativo" as const, sections: preset.sections, capabilities: preset.capabilities } };
    const permissions = { pedidos: true, administracion: false, usuarios: false } as AdminPermissionsPayload;
    const result = await service.createManagedUser({ displayName: "Jazmin", username: "Jazmin", loginType: "username", roleId: "operativo", permissions, businessMemberships: membership });
    const payload = JSON.parse(request.calls.mostRecent().args[1].body as string) as Record<string, unknown>;
    expect(request.calls.mostRecent().args[0]).toBe("/admin/users/invite");
    expect(payload["username"]).toBe("Jazmin");
    expect(payload["login_mode"]).toBe("username_only");
    expect(payload["email"]).toBeUndefined();
    expect(payload["businessMemberships"]).toEqual(membership);
    expect(result.mustChangePassword).toBeTrue();
    expect(result.temporaryPassword).toBe("emulator-only");
  });

  it("el primer acceso requiere una password y solo envia ese dato al servidor", async () => {
    request.and.resolveTo({ uid: "new-user", isActive: true, invitePending: false, mustChangePassword: false });
    await service.completeFirstLogin("Nueva-password-de-prueba");
    expect(request).toHaveBeenCalledWith("/admin/users/complete-first-login", { method: "POST", body: JSON.stringify({ password: "Nueva-password-de-prueba" }) });
  });
});
