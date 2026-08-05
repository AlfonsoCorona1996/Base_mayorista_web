import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { lastValueFrom } from "rxjs";
import { FIREBASE_AUTH } from "../core/firebase.providers";
import {
  BusinessMembershipsMap,
  RoleId,
  UserLoginType,
  buildUsernameAuthEmail,
  normalizeRoleId,
} from "../core/rbac.constants";
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
  | "administracion"
  | "clientas"
  | "rutas"
  | "localidades"
  | "salidas"
  | "embarques"
  | "durango"
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
  businessMemberships?: BusinessMembershipsMap;
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
  permissions?: AdminPermissionsPayload;
  sections?: Record<string, boolean>;
  capabilities?: Record<string, boolean>;
  sectionOverrides?: Record<string, boolean>;
  capabilityOverrides?: Record<string, boolean>;
  businessMemberships?: BusinessMembershipsMap;
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
  displayName: string;
  roleId: RoleId;
  isActive: boolean;
  invitePending: boolean;
  mustChangePassword: boolean;
  sections: Record<string, boolean> | null;
  capabilities: Record<string, boolean> | null;
  sectionOverrides: Record<string, boolean> | null;
  capabilityOverrides: Record<string, boolean> | null;
  businessMemberships?: Record<string, unknown> | null;
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
  businessMemberships?: Record<string, unknown> | null;
};

type BackendSectionKey =
  | "dashboard"
  | "validacion"
  | "pedidos"
  | "catalogo"
  | "categorias"
  | "proveedores"
  | "inventario"
  | "administracion"
  | "clientes"
  | "rutas"
  | "localidades"
  | "salidas"
  | "embarques"
  | "durango"
  | "usuarios";

const BACKEND_SECTION_KEYS: BackendSectionKey[] = [
  "dashboard",
  "validacion",
  "pedidos",
  "catalogo",
  "categorias",
  "proveedores",
  "inventario",
  "administracion",
  "clientes",
  "rutas",
  "localidades",
  "salidas",
  "embarques",
  "durango",
  "usuarios",
];

@Injectable({ providedIn: "root" })
export class UserAdminApiService {
  private readonly baseUrl = environment.adminApiBaseUrl.replace(/\/+$/, "");
  private readonly http = inject(HttpClient);
  private readonly authStateReadyPromise = FIREBASE_AUTH.authStateReady().catch(() => undefined);

  /** AuthService.getAccessStatus() y UsersService.ensureFromAuth() piden esto
   * por separado en cada arranque de sesión; sin este caché compartido se
   * duplica la llamada de red en cada login/pestaña nueva. */
  private static readonly SESSION_BOOTSTRAP_TTL_MS = 60_000;
  private sessionBootstrapCache: { value: SessionBootstrapUser; at: number } | null = null;
  private sessionBootstrapPromise: Promise<SessionBootstrapUser> | null = null;

  invalidateSessionBootstrap(): void {
    this.sessionBootstrapCache = null;
    this.sessionBootstrapPromise = null;
  }

  // ── Métodos HTTP genéricos (usan el interceptor de auth automáticamente) ──
  get<T>(path: string) {
    return this.http.get<T>(`${this.baseUrl}${path}`);
  }
  post<T>(path: string, body: unknown) {
    return this.http.post<T>(`${this.baseUrl}${path}`, body);
  }
  put<T>(path: string, body: unknown) {
    return this.http.put<T>(`${this.baseUrl}${path}`, body);
  }
  delete<T>(path: string) {
    return this.http.delete<T>(`${this.baseUrl}${path}`);
  }

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
    const payload: Record<string, unknown> = {
      uid,
      roleId: input.roleId,
      isActive: Boolean(input.isActive),
    };

    if (input.permissions && Object.keys(input.permissions).length > 0) {
      payload["permissions"] = this.normalizePermissions(input.permissions, input.roleId);
    }
    if (input.sections && Object.keys(input.sections).length > 0) {
      payload["sections"] = this.normalizeSectionsForApi(input.sections, { includeAllKnown: false });
    }
    if (input.capabilities && Object.keys(input.capabilities).length > 0) {
      payload["capabilities"] = this.normalizeCapabilitiesForApi(input.capabilities);
    }
    if (input.sectionOverrides && Object.keys(input.sectionOverrides).length > 0) {
      payload["sectionOverrides"] = this.normalizeSectionsForApi(input.sectionOverrides, { includeAllKnown: false });
    }
    if (input.capabilityOverrides && Object.keys(input.capabilityOverrides).length > 0) {
      payload["capabilityOverrides"] = this.normalizeCapabilitiesForApi(input.capabilityOverrides);
    }
    if (input.businessMemberships && Object.keys(input.businessMemberships).length > 0) {
      payload["businessMemberships"] = input.businessMemberships;
    }

    if (!environment.production) {
      console.info("[AUTHZ][UPDATE_ACCESS][PAYLOAD]", payload);
    }

    await this.request<void>("/admin/users/update-access", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async updateManagedUserProfile(input: UpdateProfileInput): Promise<void> {
    const payload = {
      uid: input.uid,
      display_name: input.displayName.trim(),
      username: input.username.trim().toLowerCase(),
      email: input.email ? input.email.trim().toLowerCase() : null,
    };
    if (!environment.production) {
      console.info("[AUTHZ][UPDATE_PROFILE][PAYLOAD]", payload);
    }
    await this.request<void>("/admin/users/update-profile", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async listManagedUsers(): Promise<ListManagedUserRow[]> {
    const result = await this.request<{ users: unknown[] }>("/admin/users/list", {
      method: "GET",
    });
    if (!Array.isArray(result.users)) return [];
    return result.users
      .map((entry) => this.normalizeManagedUserRow(entry))
      .filter((entry): entry is ListManagedUserRow => entry !== null);
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
    const cached = this.sessionBootstrapCache;
    if (cached && Date.now() - cached.at < UserAdminApiService.SESSION_BOOTSTRAP_TTL_MS) {
      return cached.value;
    }
    if (this.sessionBootstrapPromise) return this.sessionBootstrapPromise;
    this.sessionBootstrapPromise = this.fetchSessionBootstrap();
    try {
      return await this.sessionBootstrapPromise;
    } finally {
      this.sessionBootstrapPromise = null;
    }
  }

  private async fetchSessionBootstrap(): Promise<SessionBootstrapUser> {
    const result = await this.request<{
      user: {
        uid: string;
        email: string | null;
        username: string;
        displayName?: string | null;
        roleId: string;
        isActive: boolean;
        invitePending: boolean;
        mustChangePassword: boolean;
        sections?: Record<string, boolean> | null;
        capabilities?: Record<string, boolean> | null;
        businessMemberships?: Record<string, unknown> | null;
      };
    }>("/admin/users/session/bootstrap", {
      method: "GET",
    });
    const bootstrap: SessionBootstrapUser = {
      uid: result.user.uid,
      email: result.user.email,
      username: result.user.username,
      displayName: result.user.displayName || null,
      roleId: result.user.roleId || "",
      isActive: Boolean(result.user.isActive),
      invitePending: Boolean(result.user.invitePending),
      mustChangePassword: Boolean(result.user.mustChangePassword),
      sections: (result.user.sections || null) as Record<string, boolean> | null,
      capabilities: (result.user.capabilities || null) as Record<string, boolean> | null,
      businessMemberships: (result.user.businessMemberships || null) as Record<string, unknown> | null,
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

    this.sessionBootstrapCache = { value: bootstrap, at: Date.now() };
    return bootstrap;
  }

  private normalizePermissions(input: AdminPermissionsPayload, roleId: RoleId): AdminPermissionsPayload {
    const rawInput = input as Record<string, unknown>;
    return {
      dashboard: Boolean(rawInput["dashboard"]),
      validacion: Boolean(rawInput["validacion"]),
      pedidos: Boolean(rawInput["pedidos"]),
      catalogo: Boolean(rawInput["catalogo"]),
      edicion_productos: Boolean(rawInput["edicion_productos"] ?? rawInput["catalogo"]),
      categorias: Boolean(rawInput["categorias"]),
      proveedores: Boolean(rawInput["proveedores"]),
      inventario: Boolean(rawInput["inventario"]),
      administracion: Boolean(rawInput["administracion"]),
      clientas: Boolean(rawInput["clientas"] ?? rawInput["clientes"]),
      rutas: Boolean(rawInput["rutas"]),
      localidades: Boolean(rawInput["localidades"]),
      salidas: Boolean(rawInput["salidas"]),
      embarques: Boolean(rawInput["embarques"]),
      durango: Boolean(rawInput["durango"]),
      usuarios: roleId === "super_admin" ? Boolean(rawInput["usuarios"]) : false,
    };
  }

  private normalizeSectionsForApi(
    input: Record<string, unknown>,
    options: { includeAllKnown: boolean },
  ): Partial<Record<BackendSectionKey, boolean>> {
    const out: Partial<Record<BackendSectionKey, boolean>> = {};
    if (options.includeAllKnown) {
      for (const key of BACKEND_SECTION_KEYS) out[key] = false;
    }

    for (const [rawKey, rawValue] of Object.entries(input || {})) {
      if (typeof rawValue !== "boolean") continue;
      const normalizedKey = rawKey.startsWith("sections.") ? rawKey.slice("sections.".length) : rawKey;
      if (!this.isBackendSectionKey(normalizedKey)) continue;
      out[normalizedKey] = rawValue;
    }
    return out;
  }

  private normalizeCapabilitiesForApi(input: Record<string, unknown>): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [rawKey, rawValue] of Object.entries(input || {})) {
      if (typeof rawValue !== "boolean") continue;
      if (!rawKey.startsWith("cap.")) continue;
      out[rawKey] = rawValue;
    }
    return out;
  }

  private isBackendSectionKey(value: string): value is BackendSectionKey {
    return BACKEND_SECTION_KEYS.includes(value as BackendSectionKey);
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    await this.authStateReadyPromise;
    if (!FIREBASE_AUTH.currentUser) {
      throw new Error("Sesion no valida para operaciones administrativas.");
    }

    const method = (init.method || "GET").toUpperCase();
    const url = `${this.baseUrl}${path}`;

    const obs =
      method === "GET"
        ? this.http.get(url, { responseType: "text", observe: "response" })
        : this.http.post(url, init.body, { responseType: "text", observe: "response" });

    try {
      const response = await lastValueFrom(obs);
      const text = response.body ?? "";

      let parsed = {} as { ok?: boolean } & T;
      if (text) {
        try {
          parsed = JSON.parse(text) as { ok?: boolean } & T;
        } catch {
          parsed = {} as { ok?: boolean } & T;
        }
      }

      if ("ok" in parsed && parsed.ok === false) {
        const message = this.extractErrorMessage(response.status, text);
        const error = new Error(message) as Error & { status?: number; path?: string };
        error.status = response.status;
        error.path = path;
        throw error;
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        const text = typeof err.error === "string" ? err.error : "";
        const message = this.extractErrorMessage(err.status, text);
        const apiError = new Error(message) as Error & { status?: number; path?: string };
        apiError.status = err.status;
        apiError.path = path;
        throw apiError;
      }
      throw err;
    }
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

  private normalizeManagedUserRow(raw: unknown): ListManagedUserRow | null {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const uid = this.normalizeNonEmptyString(row["uid"]);
    if (!uid) return null;

    const username = this.normalizeNonEmptyString(row["username"]) || uid;
    const displayName = this.normalizeNonEmptyString(row["displayName"]) || username;
    const roleId = normalizeRoleId(row["roleId"]);
    const email = this.normalizeNullableEmail(row["email"]);

    return {
      uid,
      email,
      username,
      displayName,
      roleId,
      isActive: Boolean(row["isActive"] ?? true),
      invitePending: Boolean(row["invitePending"] ?? false),
      mustChangePassword: Boolean(row["mustChangePassword"] ?? false),
      sections: this.normalizeBooleanRecord(row["sections"]),
      capabilities: this.normalizeBooleanRecord(row["capabilities"]),
      sectionOverrides: this.normalizeBooleanRecord(row["sectionOverrides"]),
      capabilityOverrides: this.normalizeBooleanRecord(row["capabilityOverrides"]),
      businessMemberships: this.normalizeUnknownRecord(row["businessMemberships"]),
    };
  }

  private normalizeNullableEmail(raw: unknown): string | null {
    const value = this.normalizeNonEmptyString(raw);
    if (!value) return null;
    return value.toLowerCase();
  }

  private normalizeNonEmptyString(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    return value.length ? value : null;
  }

  private normalizeBooleanRecord(raw: unknown): Record<string, boolean> | null {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  }

  private normalizeUnknownRecord(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object") return null;
    return raw as Record<string, unknown>;
  }
}
