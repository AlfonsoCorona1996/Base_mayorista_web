import { Injectable } from "@angular/core";
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
  private _user: User | null = null;

  constructor() {
    onAuthStateChanged(FIREBASE_AUTH, (u) => (this._user = u));
  }

  get user() {
    return this._user;
  }

  async login(email: string, password: string) {
    const cred = await signInWithEmailAndPassword(FIREBASE_AUTH, email, password);
    this._user = cred.user;
    return cred.user;
  }

  async logout() {
    await signOut(FIREBASE_AUTH);
    this._user = null;
  }

async isAdmin(): Promise<boolean> {
  const u = FIREBASE_AUTH.currentUser;
  if (!u) return false;

  const snap = await getDoc(doc(FIRESTORE, "admins", u.uid));
  if (!snap.exists()) return false;

  const data = snap.data();
  return data?.['active'] === true;
}
}
