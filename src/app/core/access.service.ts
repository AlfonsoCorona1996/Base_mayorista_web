import { Injectable, computed, signal } from "@angular/core";
import { doc, getDoc } from "firebase/firestore";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";

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
  | "usuarios";

export type AppRole = "super_admin" | "admin" | "administrativo" | "repartidor";

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
  "usuarios",
];

export const ADMINISTRATIVO_PERMISSIONS: AppPermission[] = [
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
];

export const REPARTIDOR_PERMISSIONS: AppPermission[] = ["dashboard", "pedidos", "clientas", "rutas", "localidades"];

export function buildEmptyPermissions(): PermissionMap {
  return {
    dashboard: false,
    validacion: false,
    pedidos: false,
    catalogo: false,
    edicion_productos: false,
    categorias: false,
    proveedores: false,
    inventario: false,
    clientas: false,
    rutas: false,
    localidades: false,
    usuarios: false,
  };
}

export function buildDefaultPermissions(): PermissionMap {
  const base = buildEmptyPermissions();
  for (const permission of ALL_PERMISSIONS) base[permission] = true;
  return base;
}

export function normalizeRole(value: unknown): AppRole {
  if (value === "super_admin" || value === "admin" || value === "administrativo" || value === "repartidor") {
    return value;
  }
  if (typeof value === "string") {
    const low = value.trim().toLowerCase();
    if (low === "super admin") return "super_admin";
    if (low === "administrativos") return "administrativo";
    if (low === "repartidores") return "repartidor";
  }
  return "admin";
}

export function buildPermissionsForRole(role: AppRole, custom?: Partial<PermissionMap> | null): PermissionMap {
  let result = buildEmptyPermissions();
  if (role === "super_admin" || role === "admin") {
    result = buildDefaultPermissions();
  } else if (role === "repartidor") {
    for (const key of REPARTIDOR_PERMISSIONS) result[key] = true;
  } else {
    for (const key of ADMINISTRATIVO_PERMISSIONS) result[key] = true;
  }

  if (custom) {
    for (const key of ALL_PERMISSIONS) result[key] = Boolean(custom[key]);
  }

  if (role !== "super_admin") {
    result.usuarios = Boolean(custom?.usuarios ?? false);
  }
  return result;
}

@Injectable({ providedIn: "root" })
export class AccessService {
  profile = signal<AdminProfile | null>(null);
  loading = signal(false);

  isSuperAdmin = computed(() => this.profile()?.role === "super_admin");

  displayName = computed(() => {
    const profile = this.profile();
    return profile?.displayName || profile?.username || profile?.email || "Usuario";
  });

  async refreshProfile(): Promise<AdminProfile | null> {
    const user = FIREBASE_AUTH.currentUser;
    if (!user) {
      this.profile.set(null);
      return null;
    }
    this.loading.set(true);
    try {
      const snap = await getDoc(doc(FIRESTORE, "admins", user.uid));
      if (!snap.exists()) {
        this.profile.set(null);
        return null;
      }
      const data = snap.data() as Record<string, any>;
      const role = normalizeRole(data["role"]);
      const incoming = (data["permissions"] ?? null) as Record<string, any> | null;
      const profile: AdminProfile = {
        uid: user.uid,
        email: user.email,
        username: (data["username"] || null) as string | null,
        displayName: (data["display_name"] || data["name"] || null) as string | null,
        active: data["active"] === true,
        role,
        permissions: buildPermissionsForRole(role, incoming),
      };
      this.profile.set(profile);
      return profile;
    } finally {
      this.loading.set(false);
    }
  }

  can(permission: AppPermission): boolean {
    const profile = this.profile();
    if (!profile || !profile.active) return false;
    if (profile.role === "super_admin") return true;
    return Boolean(profile.permissions[permission]);
  }

  canViewUsers(): boolean {
    return this.canManageUsers() || this.can("usuarios");
  }

  canManageUsers(): boolean {
    return this.profile()?.role === "super_admin";
  }

  firstAllowedRoute(): string {
    const map: Array<{ permission: AppPermission; route: string }> = [
      { permission: "dashboard", route: "/main/dashboard" },
      { permission: "validacion", route: "/main/validacion" },
      { permission: "pedidos", route: "/main/pedidos" },
      { permission: "catalogo", route: "/main/catalogo" },
      { permission: "inventario", route: "/main/inventario" },
      { permission: "clientas", route: "/main/clientas" },
      { permission: "rutas", route: "/main/rutas" },
      { permission: "localidades", route: "/main/localidades" },
      { permission: "usuarios", route: "/main/usuarios" },
    ];
    for (const row of map) {
      if (this.can(row.permission)) return row.route;
    }
    return "/login";
  }
}
