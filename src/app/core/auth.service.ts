import { Injectable, signal, computed, inject } from "@angular/core";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { AccessService, buildPermissionsForRole, normalizeRole } from "./access.service";
import { AuditService } from "./audit.service";

const SUPER_ADMIN_EMAIL_ALLOWLIST = new Set(["alfonso.corona1996@gmail.com"]);

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

  async isAdmin(): Promise<boolean> {
    let u = FIREBASE_AUTH.currentUser ?? this.user();
    if (!u) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      u = FIREBASE_AUTH.currentUser ?? this.user();
    }
    if (!u) return false;

    const normalizedEmail = (u.email || "").trim().toLowerCase();

    // Bootstrap explícito por allowlist de email (owner principal del sistema).
    if (normalizedEmail && SUPER_ADMIN_EMAIL_ALLOWLIST.has(normalizedEmail)) {
      await setDoc(
        doc(FIRESTORE, "admins", u.uid),
        {
          uid: u.uid,
          email: normalizedEmail,
          active: true,
          role: "super_admin",
          username: normalizedEmail.split("@")[0],
          display_name: u.displayName || normalizedEmail.split("@")[0],
          permissions: buildPermissionsForRole("super_admin"),
          updated_at: serverTimestamp(),
        },
        { merge: true },
      );
      await this.audit.log("SUPER_ADMIN_ALLOWLIST_BOOTSTRAP", { uid: u.uid, email: normalizedEmail }).catch(() => null);
      return true;
    }

    const direct = await getDoc(doc(FIRESTORE, "admins", u.uid));
    if (direct.exists()) {
      const data = direct.data();
      return data?.["active"] === true;
    }

    if (normalizedEmail) {
      const byEmail = await getDocs(query(collection(FIRESTORE, "admins"), where("email", "==", normalizedEmail), limit(1)));
      if (!byEmail.empty) {
        const source = byEmail.docs[0].data() as Record<string, any>;
        const role = normalizeRole(source["role"]);
        await setDoc(
          doc(FIRESTORE, "admins", u.uid),
          {
            uid: u.uid,
            email: normalizedEmail,
            active: source["active"] !== false,
            role,
            username: source["username"] || normalizedEmail.split("@")[0],
            display_name: source["display_name"] || source["name"] || u.displayName || normalizedEmail.split("@")[0],
            permissions: buildPermissionsForRole(role, source["permissions"] ?? null),
            created_at: source["created_at"] || serverTimestamp(),
            updated_at: serverTimestamp(),
          },
          { merge: true },
        );
        return source["active"] !== false;
      }
    }

    const anyAdmin = await getDocs(query(collection(FIRESTORE, "admins"), limit(1)));
    if (anyAdmin.empty) {
      await setDoc(doc(FIRESTORE, "admins", u.uid), {
        uid: u.uid,
        email: normalizedEmail || u.email || null,
        active: true,
        role: "super_admin",
        username: normalizedEmail ? normalizedEmail.split("@")[0] : u.uid,
        display_name: u.displayName || (normalizedEmail ? normalizedEmail.split("@")[0] : "Super Admin"),
        permissions: buildPermissionsForRole("super_admin"),
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });
      await this.audit.log("SUPER_ADMIN_BOOTSTRAP", { uid: u.uid, email: normalizedEmail || null }).catch(() => null);
      return true;
    }

    const existingSuperAdmin = await getDocs(
      query(collection(FIRESTORE, "admins"), where("role", "==", "super_admin"), where("active", "==", true), limit(1)),
    );
    if (existingSuperAdmin.empty) {
      await setDoc(
        doc(FIRESTORE, "admins", u.uid),
        {
          uid: u.uid,
          email: normalizedEmail || u.email || null,
          active: true,
          role: "super_admin",
          username: normalizedEmail ? normalizedEmail.split("@")[0] : u.uid,
          display_name: u.displayName || (normalizedEmail ? normalizedEmail.split("@")[0] : "Super Admin"),
          permissions: buildPermissionsForRole("super_admin"),
          updated_at: serverTimestamp(),
        },
        { merge: true },
      );
      await this.audit.log("SUPER_ADMIN_RECOVERY", { uid: u.uid, email: normalizedEmail || null }).catch(() => null);
      return true;
    }

    return false;
  }
}
