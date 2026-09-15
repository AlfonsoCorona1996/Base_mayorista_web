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
 *
 * `experimentalAutoDetectLongPolling`: en redes de datos móviles el canal de
 * streaming normal de Firestore (WebChannel/gRPC) es justo el tipo de conexión
 * de larga duración que los proxies/NAT de los operadores suelen cortar tras
 * unos minutos de inactividad, sin que el navegador se entere limpiamente.
 * Con esto el SDK detecta esa situación y usa long-polling, que tolera mucho
 * mejor esos cortes en vez de quedarse con un canal "zombie".
 */
export const FIRESTORE = initializeFirestore(FIREBASE_APP, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
  experimentalAutoDetectLongPolling: true,
});

export const STORAGE = getStorage(FIREBASE_APP);

export function provideFirebaseCore(): EnvironmentProviders {
  return makeEnvironmentProviders([]);
}
