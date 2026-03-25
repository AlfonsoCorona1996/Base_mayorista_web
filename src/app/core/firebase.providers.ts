import { EnvironmentProviders, makeEnvironmentProviders } from "@angular/core";
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { environment } from "../../environments/environment";

export const FIREBASE_APP = initializeApp(environment.firebase);
export const FIREBASE_AUTH = getAuth(FIREBASE_APP);

/**
 * Firestore con caché persistente en IndexedDB y soporte multi-tab.
 * Permite que la app funcione offline y reduce lecturas redundantes entre pestañas.
 */
export const FIRESTORE = initializeFirestore(FIREBASE_APP, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

export const STORAGE = getStorage(FIREBASE_APP);

export function provideFirebaseCore(): EnvironmentProviders {
  return makeEnvironmentProviders([]);
}
