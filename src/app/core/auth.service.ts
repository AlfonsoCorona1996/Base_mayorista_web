import { Injectable, signal, computed, inject } from "@angular/core";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { AccessService } from "./access.service";
import { AuditService } from "./audit.service";
import { environment } from "../../environments/environment";

export type SessionBootstrapStatus = "OK" | "INVITE_PENDING" | "NO_ACCESS";

@Injectable({ providedIn: "root" })
export class AuthService {
  user = signal<User | null>(null);
  isAuthenticated = computed(() => this.user() !== null);
  uid = computed(() => this.user()?.uid ?? null);

  private access = inject(AccessService);
  private audit = inject(AuditService);

  constructor() {
    onAuthStateChanged(FIREBASE_AUTH, (u) => {
      this.user.set(u);
    });
  }

  async login(email: string, password: string) {
    const cred = await signInWithEmailAndPassword(FIREBASE_AUTH, email, password);
    this.user.set(cred.user);
    await this.access.refreshProfile().catch(() => null);
    await this.audit.log("AUTH_LOGIN", { email }).catch(() => null);
    return cred.user;
  }

  async logout() {
    await this.audit.log("AUTH_LOGOUT").catch(() => null);
    await signOut(FIREBASE_AUTH);
    this.user.set(null);
    this.access.profile.set(null);
  }

  private adminApiBaseUrl(): string {
    const fromEnv = ((environment as { adminApiBaseUrl?: string }).adminApiBaseUrl || "").trim();
    const fromStorage = (typeof window !== "undefined" ? window.localStorage.getItem("adminApiBaseUrl") : "") || "";
    const fromWindow = (typeof window !== "undefined" ? (window as any).__ADMIN_API_BASE_URL__ : "") || "";
    const raw = (fromStorage || fromEnv || fromWindow || "").trim();
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
  }

  private buildAdminUrl(path: string): string {
    return `${this.adminApiBaseUrl()}${path}`;
  }

  async bootstrapSession(): Promise<SessionBootstrapStatus> {
    const u = FIREBASE_AUTH.currentUser ?? this.user();
    if (!u) return "NO_ACCESS";

    const token = await u.getIdToken(true);
    const response = await fetch(this.buildAdminUrl("/admin/users/session/bootstrap"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const raw = await response.text();
    let data: Record<string, any> = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    const status = String(data["status"] || "").trim().toUpperCase();

    if (response.ok) {
      await this.access.refreshProfile().catch(() => null);
      if (status === "OK" || status === "INVITE_PENDING" || status === "NO_ACCESS") {
        return status as SessionBootstrapStatus;
      }
      const profile = this.access.profile();
      if (profile?.active) return "OK";
      return "INVITE_PENDING";
    }

    if (status === "INVITE_PENDING") return "INVITE_PENDING";
    if (response.status === 401 || response.status === 403 || status === "NO_ACCESS") return "NO_ACCESS";
    return "NO_ACCESS";
  }

  async isAdmin(): Promise<boolean> {
    let u = FIREBASE_AUTH.currentUser ?? this.user();
    if (!u) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      u = FIREBASE_AUTH.currentUser ?? this.user();
    }
    if (!u) return false;

    const direct = await getDoc(doc(FIRESTORE, "admins", u.uid));
    if (!direct.exists()) return false;
    const data = direct.data();
    return data?.["active"] === true;
  }
}
