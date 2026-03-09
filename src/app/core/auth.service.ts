import { Injectable, computed, inject, signal } from "@angular/core";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { buildUsernameAuthEmail } from "./rbac.constants";
import { UserAdminApiService } from "../services/user-admin-api.service";

export type AccessStatus = {
  uid: string | null;
  roleId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
};

@Injectable({ providedIn: "root" })
export class AuthService {
  private userAdminApi = inject(UserAdminApiService);
  user = signal<User | null>(null);
  isAuthenticated = computed(() => this.user() !== null);
  uid = computed(() => this.user()?.uid ?? null);

  private accessCheckCache: { uid: string; value: AccessStatus; at: number } | null = null;
  private accessCheckPromise: Promise<AccessStatus> | null = null;

  constructor() {
    onAuthStateChanged(FIREBASE_AUTH, (u) => {
      this.user.set(u);
      this.accessCheckCache = null;
      this.accessCheckPromise = null;
    });
  }

  async login(identifier: string, password: string) {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    const cred = await signInWithEmailAndPassword(FIREBASE_AUTH, normalizedIdentifier, password);
    this.user.set(cred.user);
    return cred.user;
  }

  async logout() {
    await signOut(FIREBASE_AUTH);
    this.user.set(null);
    this.accessCheckCache = null;
    this.accessCheckPromise = null;
  }

  async getAccessStatus(): Promise<AccessStatus> {
    let u = FIREBASE_AUTH.currentUser ?? this.user();
    if (!u) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      u = FIREBASE_AUTH.currentUser ?? this.user();
    }
    if (!u) {
      return { uid: null, roleId: null, isActive: false, mustChangePassword: false };
    }

    const cached = this.accessCheckCache;
    if (cached && cached.uid === u.uid && Date.now() - cached.at < 60_000) {
      return cached.value;
    }
    if (this.accessCheckPromise) return this.accessCheckPromise;

    this.accessCheckPromise = (async () => {
      try {
        const boot = await this.userAdminApi.getSessionBootstrap();
        const value: AccessStatus = {
          uid: boot.uid || u.uid,
          roleId: boot.roleId || null,
          isActive: Boolean(boot.isActive),
          mustChangePassword: Boolean(boot.mustChangePassword),
        };
        this.accessCheckCache = { uid: u.uid, value, at: Date.now() };
        return value;
      } catch {
        // Fallback while backend endpoint is unavailable in local or older environments.
      }

      const userSnap = await getDoc(doc(FIRESTORE, "users", u.uid));
      if (userSnap.exists()) {
        const data = userSnap.data() as Record<string, any>;
        const value: AccessStatus = {
          uid: u.uid,
          roleId: typeof data["roleId"] === "string" ? data["roleId"] : null,
          isActive: Boolean(data["isActive"] ?? true),
          mustChangePassword: Boolean(data["mustChangePassword"] ?? false),
        };
        this.accessCheckCache = { uid: u.uid, value, at: Date.now() };
        return value;
      }

      const legacySnap = await getDoc(doc(FIRESTORE, "admins", u.uid));
      if (!legacySnap.exists()) {
        const value: AccessStatus = { uid: u.uid, roleId: null, isActive: false, mustChangePassword: false };
        this.accessCheckCache = { uid: u.uid, value, at: Date.now() };
        return value;
      }
      const legacy = legacySnap.data() as Record<string, any>;
      const value: AccessStatus = {
        uid: u.uid,
        roleId: typeof legacy["role"] === "string" ? legacy["role"] : null,
        isActive: legacy["active"] === true,
        mustChangePassword: false,
      };
      this.accessCheckCache = { uid: u.uid, value, at: Date.now() };
      return value;
    })();

    try {
      return await this.accessCheckPromise;
    } finally {
      this.accessCheckPromise = null;
    }
  }

  async isAdmin(): Promise<boolean> {
    const status = await this.getAccessStatus();
    return Boolean(status.uid && status.isActive);
  }

  invalidateAccessCache() {
    this.accessCheckCache = null;
    this.accessCheckPromise = null;
  }

  private normalizeIdentifier(value: string): string {
    const input = value.trim().toLowerCase();
    if (!input) return input;
    if (input.includes("@")) return input;
    return buildUsernameAuthEmail(input);
  }
}
