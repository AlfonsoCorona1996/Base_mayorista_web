export async function onRequest(context: any) {
  const url = new URL(context.request.url);

  // Si pide un archivo real (tiene extensión), deja que Pages lo sirva normal
  if (url.pathname.includes(".")) {
    return context.next();
  }

  // Intenta servir el archivo estático primero (por si existe)
  const res = await context.next();
  if (res.status !== 404) return res;

  // Si no existe (404), regresa index.html (SPA fallback)
  return context.env.ASSETS.fetch(new URL("/index.html", url));
}
