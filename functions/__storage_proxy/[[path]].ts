export async function onRequest(context: any) {
  const incoming = new URL(context.request.url);
  const proxiedPath = incoming.pathname.replace(/^\/__storage_proxy/, "");
  const target = new URL(`https://firebasestorage.googleapis.com${proxiedPath}${incoming.search}`);

  const upstream = await fetch(target.toString(), {
    method: "GET",
    headers: {
      accept: context.request.headers.get("accept") || "*/*",
    },
  });

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", headers.get("Cache-Control") || "public, max-age=3600");
  headers.set("Access-Control-Allow-Origin", incoming.origin);
  headers.set("Vary", "Origin");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
