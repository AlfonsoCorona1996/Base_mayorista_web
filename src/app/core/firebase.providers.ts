import { EnvironmentProviders, makeEnvironmentProviders } from "@angular/core";
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { environment } from "../../environments/environment";

// Tokens simples para inyección (sin AngularFire)
export const FIREBASE_APP = initializeApp(environment.firebase);
export const FIREBASE_AUTH = getAuth(FIREBASE_APP);
export const FIRESTORE = getFirestore(FIREBASE_APP);
export const STORAGE = getStorage(FIREBASE_APP);

export function provideFirebaseCore(): EnvironmentProviders {
  // No “proveemos” objetos como AngularFire; exportamos singletons arriba.
  // Esto solo asegura que el módulo se cargue al arrancar.
  return makeEnvironmentProviders([]);
}
