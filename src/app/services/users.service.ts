import { Injectable, inject } from "@angular/core";
import { User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { FIREBASE_AUTH, FIRESTORE } from "../core/firebase.providers";
import {
  CAPABILITY_KEYS,
  SECTION_KEYS,
  CapabilitiesMap,
  CapabilityOverridesMap,
  RoleId,
  SectionsMap,
  SectionOverridesMap,
  UserDoc,
  UserLoginType,
  buildRolePreset,
  buildUsernameAuthEmail,
  isUsernameAuthEmail,
  normalizeCapabilitiesMap,
  normalizeCapabilityOverridesMap,
  normalizeRoleId,
  normalizeSectionsMap,
  normalizeSectionOverridesMap,
  normalizeUsername,
} from "../core/rbac.constants";
import { SessionBootstrapUser, UserAdminApiService } from "./user-admin-api.service";

export type SaveUserInput = Pick<
  UserDoc,
  | "uid"
  | "email"
  | "authEmail"
  | "username"
  | "loginType"
  | "displayName"
  | "roleId"
  | "isActive"
  | "mustChangePassword"
  | "sections"
  | "capabilities"
  | "sectionOverrides"
  | "capabilityOverrides"
>;

@Injectable({ providedIn: "root" })
export class UsersService {
  private userAdminApi = inject(UserAdminApiService);

  async ensureFromAuth(user: User): Promise<UserDoc> {
    const uid = user.uid;
    const userRef = doc(FIRESTORE, "users", uid);
    const snap = await getDoc(userRef);
    const authEmail = (user.email || "").trim().toLowerCase();
    const bootstrap = await this.userAdminApi.getSessionBootstrap().catch(() => null);

    if (snap.exists()) {
      const data = snap.data() as Record<string, any>;
      const legacy = await getDoc(doc(FIRESTORE, "admins", uid));
      const legacyData = legacy.exists() ? (legacy.data() as Record<string, any>) : null;
      const normalized = this.normalizeUserDoc(uid, data, user, bootstrap);
      const legacyRole = legacyData ? normalizeRoleId(legacyData["role"]) : null;
      const resolvedRole = legacyRole === "super_admin" ? "super_admin" : normalized.roleId;
      const resolvedActive = Boolean(bootstrap?.isActive ?? normalized.isActive ?? legacyData?.["active"] ?? true);
      const resolvedMustChangePassword = Boolean(bootstrap?.mustChangePassword ?? normalized.mustChangePassword ?? false);
      return {
        ...normalized,
        roleId: resolvedRole,
        isActive: resolvedActive,
        mustChangePassword: resolvedMustChangePassword,
      };
    }

    const legacy = await getDoc(doc(FIRESTORE, "admins", uid));
    const roleId = normalizeRoleId(bootstrap?.roleId || (legacy.exists() ? legacy.data()?.["role"] : "operativo"));
    const displayName =
      (
        bootstrap?.displayName ||
        legacy.data()?.["display_name"] ||
        legacy.data()?.["name"] ||
        user.displayName ||
        user.email ||
        "Usuario"
      ).toString();
    const username = normalizeUsername(user.displayName || user.email?.split("@")[0] || uid.slice(0, 10));
    const loginType: UserLoginType = isUsernameAuthEmail(authEmail) ? "username" : "email";
    const defaultSections = this.resolveSectionsMap({}, roleId, {}, bootstrap?.sections || null);
    const defaultCapabilities = this.resolveCapabilitiesMap({}, roleId, {}, bootstrap?.capabilities || null);
    const payload = {
      uid,
      email: loginType === "email" ? authEmail : "",
      authEmail: authEmail || buildUsernameAuthEmail(username),
      username,
      loginType,
      displayName,
      roleId,
      isActive: Boolean(bootstrap?.isActive ?? (legacy.exists() ? legacy.data()?.["active"] ?? true : true)),
      active: Boolean(bootstrap?.isActive ?? (legacy.exists() ? legacy.data()?.["active"] ?? true : true)),
      mustChangePassword: Boolean(bootstrap?.mustChangePassword ?? false),
      must_change_password: Boolean(bootstrap?.mustChangePassword ?? false),
      sections: defaultSections,
      capabilities: defaultCapabilities,
      sectionOverrides: {} as SectionOverridesMap,
      capabilityOverrides: {} as CapabilityOverridesMap,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    return {
      uid,
      email: payload.email,
      authEmail: payload.authEmail,
      username: payload.username,
      loginType: payload.loginType,
      displayName: payload.displayName,
      roleId,
      isActive: payload.isActive,
      mustChangePassword: payload.mustChangePassword,
      sections: payload.sections,
      capabilities: payload.capabilities,
      sectionOverrides: payload.sectionOverrides,
      capabilityOverrides: payload.capabilityOverrides,
      createdAt: null,
      updatedAt: null,
    };
  }

  async listUsers(): Promise<UserDoc[]> {
    const snap = await getDocs(collection(FIRESTORE, "users"));
    return snap.docs
      .map((entry) => this.normalizeUserDoc(entry.id, entry.data() as Record<string, any>))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async saveUser(input: SaveUserInput): Promise<void> {
    const username = normalizeUsername(input.username);
    const loginType: UserLoginType = input.loginType === "username" ? "username" : "email";
    const payload = {
      uid: input.uid,
      email: loginType === "email" ? (input.email || "").trim().toLowerCase() : "",
      authEmail:
        (input.authEmail || "").trim().toLowerCase() ||
        (loginType === "username" ? buildUsernameAuthEmail(username) : (input.email || "").trim().toLowerCase()),
      username,
      loginType,
      displayName: (input.displayName || "").trim() || "Usuario",
      roleId: normalizeRoleId(input.roleId),
      isActive: Boolean(input.isActive),
      active: Boolean(input.isActive),
      mustChangePassword: Boolean(input.mustChangePassword),
      must_change_password: Boolean(input.mustChangePassword),
      sections: normalizeSectionsMap(input.sections),
      capabilities: normalizeCapabilitiesMap(input.capabilities),
      sectionOverrides: normalizeSectionOverridesMap(input.sectionOverrides),
      capabilityOverrides: normalizeCapabilityOverridesMap(input.capabilityOverrides),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(FIRESTORE, "users", input.uid), payload, { merge: true });
  }

  async setRole(uid: string, roleId: RoleId): Promise<void> {
    await updateDoc(doc(FIRESTORE, "users", uid), {
      roleId: normalizeRoleId(roleId),
      updatedAt: serverTimestamp(),
    });
  }

  async setActive(uid: string, isActive: boolean): Promise<void> {
    await updateDoc(doc(FIRESTORE, "users", uid), {
      isActive: Boolean(isActive),
      active: Boolean(isActive),
      updatedAt: serverTimestamp(),
    });
  }

  async setMustChangePassword(uid: string, mustChangePassword: boolean): Promise<void> {
    await updateDoc(doc(FIRESTORE, "users", uid), {
      mustChangePassword: Boolean(mustChangePassword),
      must_change_password: Boolean(mustChangePassword),
      updatedAt: serverTimestamp(),
    });
  }

  async completeFirstAccess(uid: string): Promise<void> {
    await updateDoc(doc(FIRESTORE, "users", uid), {
      isActive: true,
      active: true,
      mustChangePassword: false,
      must_change_password: false,
      updatedAt: serverTimestamp(),
    });
  }

  async currentUserDoc(): Promise<UserDoc | null> {
    const current = FIREBASE_AUTH.currentUser;
    if (!current) return null;
    return this.ensureFromAuth(current);
  }

  private normalizeUserDoc(
    uid: string,
    data: Record<string, any>,
    authUser?: User | null,
    bootstrap?: SessionBootstrapUser | null,
  ): UserDoc {
    const authEmail = (data["authEmail"] || authUser?.email || data["email"] || "").toString().trim().toLowerCase();
    const loginType = this.normalizeLoginType(data["loginType"], authEmail);
    const roleId = normalizeRoleId(bootstrap?.roleId || data["roleId"]);
    const sectionOverrides = normalizeSectionOverridesMap(data["sectionOverrides"] || null);
    const capabilityOverrides = normalizeCapabilityOverridesMap(data["capabilityOverrides"] || null);
    const sections = this.resolveSectionsMap(data, roleId, sectionOverrides, bootstrap?.sections || null);
    const capabilities = this.resolveCapabilitiesMap(data, roleId, capabilityOverrides, bootstrap?.capabilities || null);
    const username =
      normalizeUsername(data["username"]) ||
      (isUsernameAuthEmail(authEmail) ? normalizeUsername(authEmail.split("@")[0]) : normalizeUsername(data["email"]?.split("@")[0]));
    return {
      uid,
      email: loginType === "email" ? (data["email"] || authUser?.email || "").toString().trim().toLowerCase() : "",
      authEmail: authEmail || (loginType === "username" ? buildUsernameAuthEmail(username) : ""),
      username,
      loginType,
      displayName: (bootstrap?.displayName || data["displayName"] || authUser?.displayName || data["email"] || "Usuario").toString(),
      roleId,
      isActive: Boolean(bootstrap?.isActive ?? data["isActive"] ?? data["active"] ?? true),
      mustChangePassword: Boolean(bootstrap?.mustChangePassword ?? data["mustChangePassword"] ?? data["must_change_password"] ?? false),
      sections,
      capabilities,
      sectionOverrides,
      capabilityOverrides,
      createdAt: data["createdAt"] ?? null,
      updatedAt: data["updatedAt"] ?? null,
    };
  }

  private resolveSectionsMap(
    data: Record<string, any>,
    roleId: RoleId,
    sectionOverrides: SectionOverridesMap,
    bootstrapSections?: Record<string, boolean> | null,
  ): SectionsMap {
    const fromBootstrap = this.normalizeSectionMapFromAny(bootstrapSections || null);
    if (fromBootstrap) return fromBootstrap;

    const fromDataSections = this.normalizeSectionMapFromAny(data["sections"]);
    if (fromDataSections) return fromDataSections;

    const permissionsSections = this.mapLegacyPermissionsToSections(data["permissions"]);
    if (permissionsSections) {
      return permissionsSections;
    }

    const base = { ...buildRolePreset(roleId).sections };
    for (const [key, value] of Object.entries(sectionOverrides)) {
      if (typeof value === "boolean") {
        base[key as keyof SectionsMap] = value as never;
      }
    }
    return normalizeSectionsMap(base);
  }

  private resolveCapabilitiesMap(
    data: Record<string, any>,
    roleId: RoleId,
    capabilityOverrides: CapabilityOverridesMap,
    bootstrapCapabilities?: Record<string, boolean> | null,
  ): CapabilitiesMap {
    const fromBootstrap = this.normalizeCapabilityMapFromAny(bootstrapCapabilities || null);
    if (fromBootstrap) return fromBootstrap;

    const fromDataCapabilities = this.normalizeCapabilityMapFromAny(data["capabilities"]);
    if (fromDataCapabilities) return fromDataCapabilities;

    const base = { ...buildRolePreset(roleId).capabilities };
    for (const [key, value] of Object.entries(capabilityOverrides)) {
      if (typeof value === "boolean") {
        base[key as keyof CapabilitiesMap] = value as never;
      }
    }
    return normalizeCapabilitiesMap(base);
  }

  private mapLegacyPermissionsToSections(raw: unknown): SectionsMap | null {
    if (!raw || typeof raw !== "object") return null;
    const permissions = raw as Record<string, unknown>;
    return normalizeSectionsMap({
      "sections.dashboard": permissions["dashboard"],
      "sections.validacion": permissions["validacion"],
      "sections.pedidos": permissions["pedidos"],
      "sections.catalogo": Boolean(permissions["catalogo"] ?? permissions["edicion_productos"]),
      "sections.categorias": permissions["categorias"],
      "sections.proveedores": permissions["proveedores"],
      "sections.inventario": permissions["inventario"],
      "sections.clientes": permissions["clientas"] ?? permissions["clientes"],
      "sections.rutas": permissions["rutas"],
      "sections.localidades": permissions["localidades"],
      "sections.salidas": permissions["salidas"],
      "sections.usuarios": permissions["usuarios"],
    });
  }

  private normalizeSectionMapFromAny(raw: unknown): SectionsMap | null {
    if (!raw || typeof raw !== "object") return null;
    const map = raw as Record<string, unknown>;
    const hasCanonical = SECTION_KEYS.some((key) => key in map);
    if (hasCanonical) return normalizeSectionsMap(map);

    const hasShort =
      "dashboard" in map ||
      "validacion" in map ||
      "pedidos" in map ||
      "catalogo" in map ||
      "categorias" in map ||
      "proveedores" in map ||
      "inventario" in map ||
      "clientes" in map ||
      "rutas" in map ||
      "localidades" in map ||
      "salidas" in map ||
      "usuarios" in map;
    if (!hasShort) return null;

    return normalizeSectionsMap({
      "sections.dashboard": map["dashboard"],
      "sections.validacion": map["validacion"],
      "sections.pedidos": map["pedidos"],
      "sections.catalogo": map["catalogo"],
      "sections.categorias": map["categorias"],
      "sections.proveedores": map["proveedores"],
      "sections.inventario": map["inventario"],
      "sections.clientes": map["clientes"],
      "sections.rutas": map["rutas"],
      "sections.localidades": map["localidades"],
      "sections.salidas": map["salidas"],
      "sections.usuarios": map["usuarios"],
    });
  }

  private normalizeCapabilityMapFromAny(raw: unknown): CapabilitiesMap | null {
    if (!raw || typeof raw !== "object") return null;
    const map = raw as Record<string, unknown>;
    const hasCanonical = CAPABILITY_KEYS.some((key) => key in map);
    if (!hasCanonical) return null;
    return normalizeCapabilitiesMap(map);
  }

  private normalizeLoginType(raw: unknown, authEmail: string): UserLoginType {
    if (raw === "email" || raw === "username") return raw;
    return isUsernameAuthEmail(authEmail) ? "username" : "email";
  }
}
