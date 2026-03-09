import { Injectable, computed, inject } from "@angular/core";
import { AuthzService } from "./authz.service";

export type AppPermission =
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
  | "salidas"
  | "usuarios";

export type AppRole = "super_admin" | "admin" | "operativo" | "administrativo" | "repartidor";
export type PermissionMap = Record<AppPermission, boolean>;

export interface AdminProfile {
  uid: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  active: boolean;
  role: AppRole;
  permissions: PermissionMap;
}

export const ALL_PERMISSIONS: AppPermission[] = [
  "dashboard",
  "validacion",
  "pedidos",
  "catalogo",
  "edicion_productos",
  "categorias",
  "proveedores",
  "inventario",
  "clientas",
  "rutas",
  "localidades",
  "salidas",
  "usuarios",
];

const SECTION_BY_PERMISSION: Record<AppPermission, string> = {
  dashboard: "sections.dashboard",
  validacion: "sections.validacion",
  pedidos: "sections.pedidos",
  catalogo: "sections.catalogo",
  edicion_productos: "sections.catalogo",
  categorias: "sections.categorias",
  proveedores: "sections.proveedores",
  inventario: "sections.inventario",
  clientas: "sections.clientes",
  rutas: "sections.rutas",
  localidades: "sections.localidades",
  salidas: "sections.salidas",
  usuarios: "sections.usuarios",
};

export function buildEmptyPermissions(): PermissionMap {
  const out = {} as PermissionMap;
  for (const key of ALL_PERMISSIONS) out[key] = false;
  return out;
}

export function buildDefaultPermissions(): PermissionMap {
  const out = buildEmptyPermissions();
  for (const key of ALL_PERMISSIONS) out[key] = true;
  return out;
}

export function normalizeRole(value: unknown): AppRole {
  if (value === "super_admin" || value === "admin" || value === "operativo" || value === "repartidor") return value;
  if (value === "administrativo") return "operativo";
  return "operativo";
}

export function buildPermissionsForRole(role: AppRole, custom?: Partial<PermissionMap> | null): PermissionMap {
  const out = buildEmptyPermissions();
  if (role === "super_admin" || role === "admin") {
    for (const key of ALL_PERMISSIONS) out[key] = true;
  } else if (role === "repartidor") {
    out.pedidos = true;
    out.salidas = true;
  } else {
    out.pedidos = true;
    out.proveedores = true;
    out.validacion = true;
    out.clientas = true;
    out.inventario = true;
    out.salidas = true;
  }
  if (custom) {
    for (const key of ALL_PERMISSIONS) out[key] = Boolean(custom[key]);
  }
  if (role !== "super_admin") {
    out.usuarios = Boolean(custom?.usuarios ?? out.usuarios);
  }
  return out;
}

@Injectable({ providedIn: "root" })
export class AccessService {
  private authz = inject(AuthzService);

  profile = computed<AdminProfile | null>(() => {
    const user = this.authz.effectiveUserSig();
    const realUser = this.authz.currentUserSig();
    if (!user) return null;
    const role = normalizeRole(user.roleId);
    return {
      uid: user.uid,
      email: user.email,
      username: user.username || null,
      displayName: user.displayName,
      active: Boolean(realUser?.isActive ?? user.isActive),
      role,
      permissions: this.buildPermissionMapForCurrentRole(),
    };
  });

  loading = computed(() => this.authz.loadingSig());

  isSuperAdmin = computed(() => this.authz.isSuperAdmin());

  displayName = computed(() => {
    const profile = this.profile();
    return profile?.displayName || profile?.username || profile?.email || "Usuario";
  });

  async refreshProfile(): Promise<AdminProfile | null> {
    await this.authz.refresh();
    return this.profile();
  }

  can(permission: AppPermission): boolean {
    return this.authz.canSection(SECTION_BY_PERMISSION[permission]);
  }

  canViewUsers(): boolean {
    return this.can("usuarios") || this.authz.canCap("cap.users.view");
  }

  canManageUsers(): boolean {
    return this.authz.isSuperAdmin() || this.authz.canCap("cap.users.edit");
  }

  firstAllowedRoute(): string {
    const map: Array<{ permission: AppPermission; route: string }> = [
      { permission: "dashboard", route: "/main/dashboard" },
      { permission: "pedidos", route: "/main/pedidos" },
      { permission: "salidas", route: "/main/salidas" },
      { permission: "validacion", route: "/main/validacion" },
      { permission: "inventario", route: "/main/inventario" },
      { permission: "clientas", route: "/main/clientas" },
      { permission: "rutas", route: "/main/rutas" },
      { permission: "localidades", route: "/main/localidades" },
      { permission: "catalogo", route: "/main/catalogo" },
      { permission: "usuarios", route: "/main/usuarios" },
    ];
    for (const row of map) {
      if (this.can(row.permission)) return row.route;
    }
    return "/login";
  }

  private buildPermissionMapForCurrentRole(): PermissionMap {
    const out = buildEmptyPermissions();
    for (const key of ALL_PERMISSIONS) {
      out[key] = this.can(key);
    }
    return out;
  }
}
