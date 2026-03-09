import { Injectable } from "@angular/core";
import { FIREBASE_AUTH } from "../core/firebase.providers";
import { RoleId, UserLoginType, buildUsernameAuthEmail } from "../core/rbac.constants";
import { environment } from "../../environments/environment";

export type AdminPermissionKey =
  | "dashboard"
  | "validacion"
  | "pedidos"
  | "catalogo"
  | "edicion_productos"
  | "categorias"
  | "proveedores"
  | "inventario"
  | "clientas"
  | "rutas"
  | "localidades"
  | "usuarios";

export type AdminPermissionsPayload = Record<AdminPermissionKey, boolean>;

export type CreateManagedUserInput = {
  displayName: string;
  username: string;
  loginType: UserLoginType;
  roleId: RoleId;
  email?: string;
  sendActivationEmail?: boolean;
  permissions: AdminPermissionsPayload;
};

export type CreateManagedUserResult = {
  uid: string;
  authEmail: string;
  temporaryPassword: string | null;
  activationEmailSent: boolean;
  invitePending: boolean;
  mustChangePassword: boolean;
};

export type UpdateManagedUserInput = {
  roleId: RoleId;
  isActive: boolean;
  permissions: AdminPermissionsPayload;
};

export type UpdateProfileInput = {
  uid: string;
  displayName: string;
  username: string;
  email?: string | null;
};

export type RegeneratePasswordResult = {
  temporaryPassword: string | null;
  resetSent: boolean;
};

export type CompleteFirstLoginResult = {
  uid: string;
  active: boolean;
  invite_pending: boolean;
  must_change_password: boolean;
  accepted_at: string | null;
};

export type ListManagedUserRow = {
  uid: string;
  email: string | null;
  username: string;
  display_name: string;
  role: RoleId;
  active: boolean;
  invite_pending: boolean;
  must_change_password: boolean;
  permissions: AdminPermissionsPayload;
  sections?: Record<string, boolean>;
  capabilities?: Record<string, boolean>;
  sectionOverrides?: Record<string, boolean>;
  capabilityOverrides?: Record<string, boolean>;
};

export type SessionBootstrapUser = {
  uid: string;
  email: string | null;
  username: string;
  displayName: string | null;
  roleId: string;
  isActive: boolean;
  invitePending: boolean;
  mustChangePassword: boolean;
  sections?: Record<string, boolean> | null;
  capabilities?: Record<string, boolean> | null;
};

@Injectable({ providedIn: "root" })
export class UserAdminApiService {
  private readonly baseUrl = environment.adminApiBaseUrl.replace(/\/+$/, "");

  async createManagedUser(input: CreateManagedUserInput): Promise<CreateManagedUserResult> {
    const email = (input.email || "").trim().toLowerCase();
    const loginMode = input.loginType === "username" ? "username_only" : "email";

    if (loginMode === "email" && !email) {
      throw new Error("Correo obligatorio para login_mode=email.");
    }

    const result = await this.request<{
      uid: string;
      email?: string;
      username?: string;
      temporary_password?: string | null;
      invitation_sent?: boolean;
      invite_pending?: boolean;
      must_change_password?: boolean;
    }>("/admin/users/invite", {
      method: "POST",
      body: JSON.stringify({
        email: loginMode === "email" ? email : undefined,
        display_name: input.displayName.trim(),
        username: input.username.trim().toLowerCase(),
        role: input.roleId,
        login_mode: loginMode,
        permissions: this.normalizePermissions(input.permissions, input.roleId),
      }),
    });

    const username = (result.username || input.username).trim().toLowerCase();
    const authEmail =
      (result.email || "").trim().toLowerCase() || (loginMode === "username_only" ? buildUsernameAuthEmail(username) : email);

    return {
      uid: result.uid,
      authEmail,
      temporaryPassword: result.temporary_password ?? null,
      activationEmailSent: Boolean(result.invitation_sent),
      invitePending: Boolean(result.invite_pending ?? true),
      mustChangePassword: Boolean(result.must_change_password ?? loginMode === "username_only"),
    };
  }

  async updateManagedUser(uid: string, input: UpdateManagedUserInput): Promise<void> {
    await this.request<void>("/admin/users/update-access", {
      method: "POST",
      body: JSON.stringify({
        uid,
        role: input.roleId,
        active: Boolean(input.isActive),
        permissions: this.normalizePermissions(input.permissions, input.roleId),
      }),
    });
  }

  async updateManagedUserProfile(input: UpdateProfileInput): Promise<void> {
    await this.request<void>("/admin/users/update-profile", {
      method: "POST",
      body: JSON.stringify({
        uid: input.uid,
        display_name: input.displayName.trim(),
        username: input.username.trim().toLowerCase(),
        email: input.email ? input.email.trim().toLowerCase() : null,
      }),
    });
  }

  async listManagedUsers(): Promise<ListManagedUserRow[]> {
    const result = await this.request<{ users: ListManagedUserRow[] }>("/admin/users/list", {
      method: "GET",
    });
    return Array.isArray(result.users) ? result.users : [];
  }

  async resendActivationEmail(uid: string): Promise<void> {
    await this.request<void>("/admin/users/resend-invite", {
      method: "POST",
      body: JSON.stringify({ uid }),
    });
  }

  async regenerateTemporaryPassword(uid: string): Promise<RegeneratePasswordResult> {
    const result = await this.request<{ reset_sent?: boolean; temporary_password?: string | null }>("/admin/users/force-reset-password", {
      method: "POST",
      body: JSON.stringify({ uid }),
    });
    return {
      temporaryPassword: result.temporary_password ?? null,
      resetSent: Boolean(result.reset_sent ?? true),
    };
  }

  async completeFirstLogin(uid?: string): Promise<CompleteFirstLoginResult> {
    return this.request<CompleteFirstLoginResult>("/admin/users/complete-first-login", {
      method: "POST",
      body: JSON.stringify(uid ? { uid } : {}),
    });
  }

  async getSessionBootstrap(): Promise<SessionBootstrapUser> {
    const result = await this.request<{
      user: {
        uid: string;
        email: string | null;
        username: string;
        display_name?: string | null;
        role?: string;
        roleId?: string;
        active?: boolean;
        isActive?: boolean;
        invite_pending?: boolean;
        invitePending?: boolean;
        must_change_password?: boolean;
        mustChangePassword?: boolean;
        sections?: Record<string, boolean> | null;
        capabilities?: Record<string, boolean> | null;
      };
    }>("/admin/users/session/bootstrap", {
      method: "GET",
    });
    const bootstrap: SessionBootstrapUser = {
      uid: result.user.uid,
      email: result.user.email,
      username: result.user.username,
      displayName: (result.user.display_name || null) as string | null,
      roleId: (result.user.roleId || result.user.role || "") as string,
      isActive: Boolean(result.user.isActive ?? result.user.active),
      invitePending: Boolean(result.user.invitePending ?? result.user.invite_pending),
      mustChangePassword: Boolean(result.user.mustChangePassword ?? result.user.must_change_password),
      sections: (result.user.sections || null) as Record<string, boolean> | null,
      capabilities: (result.user.capabilities || null) as Record<string, boolean> | null,
    };

    if (!environment.production) {
      console.info("[AUTHZ][BOOTSTRAP]", {
        uid: bootstrap.uid,
        roleId: bootstrap.roleId,
        isActive: bootstrap.isActive,
        mustChangePassword: bootstrap.mustChangePassword,
        invitePending: bootstrap.invitePending,
        sections: bootstrap.sections,
        capabilities: bootstrap.capabilities,
      });
    }

    return bootstrap;
  }

  private normalizePermissions(input: AdminPermissionsPayload, roleId: RoleId): AdminPermissionsPayload {
    return {
      dashboard: Boolean(input.dashboard),
      validacion: Boolean(input.validacion),
      pedidos: Boolean(input.pedidos),
      catalogo: Boolean(input.catalogo),
      edicion_productos: Boolean(input.edicion_productos),
      categorias: Boolean(input.categorias),
      proveedores: Boolean(input.proveedores),
      inventario: Boolean(input.inventario),
      clientas: Boolean(input.clientas),
      rutas: Boolean(input.rutas),
      localidades: Boolean(input.localidades),
      usuarios: roleId === "super_admin" ? Boolean(input.usuarios) : false,
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const current = FIREBASE_AUTH.currentUser;
    if (!current) throw new Error("Sesion no valida para operaciones administrativas.");
    const token = await current.getIdToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as { ok?: boolean } & T) : ({} as { ok?: boolean } & T);

    if (!response.ok || ("ok" in parsed && parsed.ok === false)) {
      const message = this.extractErrorMessage(response.status, text);
      throw new Error(message);
    }

    return parsed as T;
  }

  private extractErrorMessage(status: number, text: string): string {
    const fallback = `Operacion no disponible (${status}).`;
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as {
        message?: string;
        error?: string | { code?: string; message?: string };
        status?: string;
      };
      if (typeof parsed.error === "object" && parsed.error) {
        return parsed.error.message || parsed.error.code || parsed.message || fallback;
      }
      if (typeof parsed.error === "string") return parsed.error;
      return parsed.message || parsed.status || fallback;
    } catch {
      return text;
    }
  }
}
