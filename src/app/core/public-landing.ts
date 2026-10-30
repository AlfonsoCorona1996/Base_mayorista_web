/**
 * Páginas públicas pensadas para abrirse desde WhatsApp en teléfonos modestos
 * (por ahora, la encuesta de aniversario). Al entrar directo a ellas la app
 * omite trabajo de arranque que solo sirve al panel administrativo: la lectura
 * de prueba de Firestore, el reinicio de su conexión y el service worker, que
 * precarga todos los JS de la administración.
 */
const LIGHTWEIGHT_PUBLIC_PATHS = ["/aniversario"];

export function isLightweightPublicPath(pathname: string): boolean {
  const path = pathname.toLowerCase().replace(/\/+$/, "");
  return LIGHTWEIGHT_PUBLIC_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function bootedOnLightweightPublicPath(): boolean {
  return typeof location !== "undefined" && isLightweightPublicPath(location.pathname);
}
