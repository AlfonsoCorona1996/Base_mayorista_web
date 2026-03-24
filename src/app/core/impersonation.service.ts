import { Injectable, signal } from "@angular/core";
import {
  CapabilityOverridesMap,
  RoleId,
  SectionOverridesMap,
  UserDoc,
  normalizeCapabilitiesMap,
  normalizeSectionsMap,
} from "./rbac.constants";

export type ImpersonationSnapshot = {
  uid: string;
  displayName: string;
  roleId: RoleId;
  isActive: boolean;
  invitePending: boolean;
  email: string;
  authEmail: string;
  username: string;
  loginType: UserDoc["loginType"];
  sections: UserDoc["sections"];
  capabilities: UserDoc["capabilities"];
  sectionOverrides: SectionOverridesMap;
  capabilityOverrides: CapabilityOverridesMap;
};

const STORAGE_KEY = "bm.users.impersonation";

@Injectable({ providedIn: "root" })
export class ImpersonationService {
  private snapshotState = signal<ImpersonationSnapshot | null>(this.load());
  readonly snapshotSig = this.snapshotState.asReadonly();

  startFromUser(user: UserDoc) {
    if (user.roleId === "super_admin") return;
    const snapshot: ImpersonationSnapshot = {
      uid: user.uid,
      displayName: user.displayName,
      roleId: user.roleId,
      isActive: user.isActive,
      invitePending: user.invitePending,
      email: user.email,
      authEmail: user.authEmail,
      username: user.username,
      loginType: user.loginType,
      sections: { ...user.sections },
      capabilities: { ...user.capabilities },
      sectionOverrides: { ...user.sectionOverrides },
      capabilityOverrides: { ...user.capabilityOverrides },
    };
    this.snapshotState.set(snapshot);
    this.persist(snapshot);
  }

  stop() {
    this.snapshotState.set(null);
    this.clearPersisted();
  }

  isActive(): boolean {
    return this.snapshotState() !== null;
  }

  private load(): ImpersonationSnapshot | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ImpersonationSnapshot>;
      if (!parsed || typeof parsed !== "object" || typeof parsed.uid !== "string" || typeof parsed.roleId !== "string") return null;
      if (
        parsed.roleId !== "super_admin" &&
        parsed.roleId !== "admin" &&
        parsed.roleId !== "administrativo" &&
        parsed.roleId !== "operativo" &&
        parsed.roleId !== "repartidor"
      ) {
        return null;
      }
      return {
        uid: parsed.uid,
        displayName: String(parsed.displayName || "Usuario"),
        roleId: parsed.roleId,
        isActive: Boolean(parsed.isActive ?? true),
        invitePending: Boolean(parsed.invitePending ?? false),
        email: String(parsed.email || ""),
        authEmail: String(parsed.authEmail || ""),
        username: String(parsed.username || ""),
        loginType: parsed.loginType === "username" ? "username" : "email",
        sections: normalizeSectionsMap((parsed.sections as Record<string, unknown>) || null),
        capabilities: normalizeCapabilitiesMap((parsed.capabilities as Record<string, unknown>) || null),
        sectionOverrides: typeof parsed.sectionOverrides === "object" && parsed.sectionOverrides ? parsed.sectionOverrides : {},
        capabilityOverrides:
          typeof parsed.capabilityOverrides === "object" && parsed.capabilityOverrides ? parsed.capabilityOverrides : {},
      };
    } catch {
      return null;
    }
  }

  private persist(snapshot: ImpersonationSnapshot) {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }

  private clearPersisted() {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(STORAGE_KEY);
  }
}
