import { Injectable, computed, effect, inject, signal } from "@angular/core";
import { onAuthStateChanged } from "firebase/auth";
import { FIREBASE_AUTH } from "./firebase.providers";
import {
  CapabilityKey,
  RoleDoc,
  RoleId,
  SectionKey,
  SectionsMap,
  UserDoc,
  buildCapabilitiesMap,
  buildRolePreset,
  buildSectionsMap,
} from "./rbac.constants";
import { RolesService } from "../services/roles.service";
import { UsersService } from "../services/users.service";
import { ImpersonationService } from "./impersonation.service";
import { environment } from "../../environments/environment";

@Injectable({ providedIn: "root" })
export class AuthzService {
  private roles = inject(RolesService);
  private users = inject(UsersService);
  private impersonation = inject(ImpersonationService);
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private impersonationLoadSeq = 0;
  private authStateReadyPromise = FIREBASE_AUTH.authStateReady().catch(() => undefined);

  currentUserSig = signal<UserDoc | null>(null);
  roleSig = signal<RoleDoc | null>(null);
  loadingSig = signal(false);
  readySig = signal(false);
  impersonatedRoleSig = signal<RoleDoc | null>(null);

  realIsSuperAdminSig = computed(() => this.currentUserSig()?.roleId === "super_admin");

  isImpersonatingSig = computed(() => this.realIsSuperAdminSig() && this.impersonation.snapshotSig() !== null);

  effectiveUserSig = computed<UserDoc | null>(() => {
    const current = this.currentUserSig();
    if (!current) return null;
    const snapshot = this.impersonation.snapshotSig();
    if (!snapshot || !this.realIsSuperAdminSig()) return current;
    return {
      ...current,
      uid: snapshot.uid,
      displayName: snapshot.displayName,
      roleId: snapshot.roleId,
      isActive: snapshot.isActive,
      invitePending: snapshot.invitePending,
      email: snapshot.email,
      authEmail: snapshot.authEmail,
      username: snapshot.username,
      loginType: snapshot.loginType,
      sections: { ...snapshot.sections },
      capabilities: { ...snapshot.capabilities },
      sectionOverrides: { ...snapshot.sectionOverrides },
      capabilityOverrides: { ...snapshot.capabilityOverrides },
    };
  });

  effectiveRoleSig = computed<RoleDoc | null>(() => {
    if (!this.isImpersonatingSig()) return this.roleSig();
    return this.impersonatedRoleSig();
  });

  sectionsSig = computed<SectionsMap>(() => {
    const user = this.effectiveUserSig();
    if (!user) return buildSectionsMap(false);
    return user.roleId === "super_admin" ? buildSectionsMap(true) : { ...user.sections };
  });

  capabilitiesSig = computed(() => {
    const user = this.effectiveUserSig();
    if (!user) return buildCapabilitiesMap(false);
    return user.roleId === "super_admin" ? buildCapabilitiesMap(true) : { ...user.capabilities };
  });

  constructor() {
    onAuthStateChanged(FIREBASE_AUTH, (authUser) => {
      this.lastRefreshAt = 0;
      this.readySig.set(false);
      this.currentUserSig.set(null);
      this.roleSig.set(null);
      this.impersonatedRoleSig.set(null);
      if (!authUser) this.impersonation.stop();
      this.refresh({ force: true }).catch(() => null);
    });

    effect(
      () => {
        const snapshot = this.impersonation.snapshotSig();
        const canImpersonate = this.realIsSuperAdminSig();
        if (!snapshot || !canImpersonate) {
          this.impersonatedRoleSig.set(null);
          if (snapshot && !canImpersonate) this.impersonation.stop();
          return;
        }
        const seq = ++this.impersonationLoadSeq;
        this.roles
          .getRole(snapshot.roleId)
          .then((role) => {
            if (seq === this.impersonationLoadSeq) this.impersonatedRoleSig.set(role);
          })
          .catch(() => {
            if (seq === this.impersonationLoadSeq) this.impersonatedRoleSig.set(buildRolePreset(snapshot.roleId));
          });
      },
      { allowSignalWrites: true },
    );

    this.refresh({ force: true }).catch(() => null);
  }

  async refresh(opts?: { force?: boolean }): Promise<void> {
    const force = Boolean(opts?.force);
    const now = Date.now();
    const current = FIREBASE_AUTH.currentUser;
    const cachedUser = this.currentUserSig();
    const cacheValid =
      this.readySig() &&
      !force &&
      now - this.lastRefreshAt < 60_000 &&
      ((current && cachedUser && current.uid === cachedUser.uid) || (!current && !cachedUser));

    if (cacheValid) return;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<void> {
    this.loadingSig.set(true);
    try {
      await this.authStateReadyPromise;
      await this.roles.ensureDefaultsSeeded();
      const current = FIREBASE_AUTH.currentUser;
      if (!current) {
        this.currentUserSig.set(null);
        this.roleSig.set(null);
        this.impersonation.stop();
        this.readySig.set(true);
        this.lastRefreshAt = Date.now();
        return;
      }

      const userDoc = await this.users.ensureFromAuth(current);
      this.currentUserSig.set(userDoc);
      if (!environment.production) {
        console.info("[AUTHZ][USER_DOC]", {
          uid: userDoc.uid,
          roleId: userDoc.roleId,
          isActive: userDoc.isActive,
          mustChangePassword: userDoc.mustChangePassword,
          sections: userDoc.sections,
          capabilities: userDoc.capabilities,
          sectionOverrides: userDoc.sectionOverrides,
          capabilityOverrides: userDoc.capabilityOverrides,
        });
      }

      const roleId = (userDoc.roleId || "operativo") as RoleId;
      const roleDoc = await this.roles.getRole(roleId).catch(() => buildRolePreset(roleId));
      this.roleSig.set(roleDoc);
      this.readySig.set(true);
      this.lastRefreshAt = Date.now();
    } finally {
      this.loadingSig.set(false);
    }
  }

  isRealSuperAdmin(): boolean {
    return this.realIsSuperAdminSig();
  }

  isSuperAdmin(): boolean {
    return this.effectiveUserSig()?.roleId === "super_admin";
  }

  canSection(key: string): boolean {
    const user = this.effectiveUserSig();
    if (!user || !user.isActive || user.invitePending || user.mustChangePassword) return false;
    return Boolean(this.sectionsSig()[key as SectionKey]);
  }

  canCap(key: string): boolean {
    const user = this.effectiveUserSig();
    if (!user || !user.isActive || user.invitePending || user.mustChangePassword) return false;
    return Boolean(this.capabilitiesSig()[key as CapabilityKey]);
  }

  assertCap(key: string): boolean {
    if (this.canCap(key)) return true;
    throw new Error(`Permiso requerido: ${key}`);
  }
}
