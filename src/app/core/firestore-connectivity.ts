import { disableNetwork, enableNetwork } from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";

const RESUME_MIN_INTERVAL_MS = 15_000;

let lastResumeAt = 0;
let resumeInFlight: Promise<void> | null = null;

/**
 * Fuerza un ciclo disableNetwork/enableNetwork sobre Firestore.
 *
 * En mobile, el canal de tiempo real puede quedar "zombie" tras un corte de
 * NAT/proxy del operador o al suspender la pestaña en segundo plano (pantalla
 * bloqueada, cambio de app). El SDK trae su propia lógica de reconexión, pero
 * no siempre la dispara rápido por sí solo en esos escenarios. Este empujón
 * fuerza a Firestore a renegociar la conexión en vez de esperar a su watchdog
 * interno.
 */
function resumeFirestoreConnection(): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

  const now = Date.now();
  if (now - lastResumeAt < RESUME_MIN_INTERVAL_MS) return;
  if (resumeInFlight) return;
  lastResumeAt = now;

  resumeInFlight = disableNetwork(FIRESTORE)
    .then(() => enableNetwork(FIRESTORE))
    .catch((error) => {
      console.warn("No se pudo reiniciar la conexión de Firestore:", error);
    })
    .finally(() => {
      resumeInFlight = null;
    });
}

/**
 * Engancha los listeners globales que disparan `resumeFirestoreConnection`.
 * Debe llamarse una sola vez, al arrancar la app (ver `App` en app.ts).
 */
export function initFirestoreConnectivityResume(): void {
  if (typeof window === "undefined") return;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumeFirestoreConnection();
  });
  window.addEventListener("online", resumeFirestoreConnection);
  window.addEventListener("focus", resumeFirestoreConnection);
}
