# Iconos PWA

## Fuente oficial

Los iconos se generan desde `public/Icono BM.png`.

## iPhone / Safari

Safari usa principalmente:

- `public/icons/apple-touch-icon-180x180.png`
- Fallback: `public/icons/icon-152x152.png`
- Fallback adicional para deteccion automatica: `public/apple-touch-icon.png`

`src/index.html` declara explicitamente el `apple-touch-icon` de 180x180 para "Agregar a pantalla de inicio".

## Android / Chrome

Android usa `public/manifest.webmanifest`.

- Iconos normales: `public/icons/icon-*.png` con `purpose: "any"`.
- Iconos adaptables: `public/icons/icon-maskable-192x192.png` y `public/icons/icon-maskable-512x512.png` con `purpose: "maskable"`.

## Navegador

Los favicons del navegador son:

- `public/favicon.ico`
- `public/icons/favicon-32x32.png`
- `public/icons/favicon-16x16.png`

## Reemplazar el icono en el futuro

1. Reemplaza `public/Icono BM.png` por el nuevo icono oficial.
2. Regenera los PNG/ICO desde esa imagen base.
3. Ejecuta `npm run build`.
4. Verifica que `dist/admin-web/browser/icons/` incluya los iconos nuevos.

## Si iPhone sigue mostrando el icono viejo

iOS cachea fuerte los iconos de apps web. Para forzar refresco:

1. Borra la app web de la pantalla de inicio.
2. En Safari, abre la app y recarga la pagina.
3. Si sigue igual, ve a Ajustes > Safari > Borrar historial y datos de sitios web.
4. Vuelve a abrir la app en Safari y usa "Agregar a pantalla de inicio" otra vez.

En iPhone, el cambio de icono normalmente requiere quitar y volver a agregar la app web.
