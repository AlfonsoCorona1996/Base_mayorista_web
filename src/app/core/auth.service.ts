import { Injectable, signal, computed } from "@angular/core";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

@Injectable({ providedIn: "root" })
export class AuthService {
  // Estado reactivo con signals
  user = signal<User | null>(null);
  
  // Computed: si el usuario está autenticado
  isAuthenticated = computed(() => this.user() !== null);
  
  // Computed: UID del usuario (o null)
  uid = computed(() => this.user()?.uid ?? null);

  constructor() {
    // Escuchar cambios en el estado de autenticación
    onAuthStateChanged(FIREBASE_AUTH, (u) => {
      this.user.set(u);
    });
  }

  async login(email: string, password: string) {
    const cred = await signInWithEmailAndPassword(FIREBASE_AUTH, email, password);
    this.user.set(cred.user);
    return cred.user;
  }

  async logout() {
    await signOut(FIREBASE_AUTH);
    this.user.set(null);
  }

  async isAdmin(): Promise<boolean> {
    // Evita condiciones de carrera justo después del login:
    // a veces currentUser tarda unos ms en reflejarse.
    let u = FIREBASE_AUTH.currentUser ?? this.user();
    if (!u) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      u = FIREBASE_AUTH.currentUser ?? this.user();
    }
    if (!u) return false;

    const snap = await getDoc(doc(FIRESTORE, "admins", u.uid));
    if (!snap.exists()) return false;

    const data = snap.data();
    return data?.['active'] === true;
  }
}
