# PWA y scanner de codigo de barras

## Instalar la PWA

- Android Chrome: abre la URL HTTPS de la app, inicia sesion, toca el menu del navegador y elige `Instalar app` o `Agregar a pantalla principal`.
- iPhone Safari: abre la URL HTTPS de la app, toca compartir y elige `Agregar a pantalla de inicio`.
- La PWA usa `display: standalone`, por lo que al abrirla desde el icono se ve como app instalada.

## Probar camara en Android

- Usa Chrome o la PWA instalada.
- Abre un pedido y toca el icono de camara junto a `Agregar producto`, o el boton `Escanear producto` en empaque.
- Acepta el permiso de camara.
- Apunta a un codigo EAN, UPC, Code 128 o QR.
- Si no hay permiso, revisa `Configuracion > Sitios > Camara` para la URL de la app.

## Probar camara en iPhone

- Usa Safari o la PWA instalada desde Safari.
- La camara solo funciona en HTTPS o desde la app instalada.
- Si el permiso fue negado, ve a `Configuracion > Safari > Camara` o al permiso del sitio.
- Mantener el telefono estable ayuda en codigos pequenos o con poco contraste.

## Limitaciones conocidas

- No se guardan video, imagenes ni frames de camara.
- No se mandan frames al backend; la lectura ocurre localmente en el navegador con ZXing.
- En iOS el rendimiento de lectura puede variar segun modelo, luz y version de Safari.
- La busqueda BM oficial por SKU requiere correr la migracion `firebase:migrate-normalized-listings-sku-index:apply`.
- Si Firestore pide indice, crear uno para `normalized_listings`: `business_id`, `workflow.status`, `variant_skus_normalized ARRAY`.
- El service worker cachea solo assets estaticos. No cachea Firebase, APIs privadas ni datos sensibles.

## Rollback

- Quitar `@angular/service-worker`, `@angular/pwa`, `@zxing/browser` y `@zxing/library` de `package.json` y reinstalar.
- Remover `provideServiceWorker` de `src/app/app.config.ts`.
- Remover `serviceWorker` de `angular.json`.
- Eliminar `ngsw-config.json`, `public/manifest.webmanifest` y `public/icons`.
- Remover `BarcodeScannerComponent`, `BarcodeProductLookupService` y las llamadas del scanner en pedido detalle.
- No aplicar o revertir la migracion del indice `variant_skus_normalized` si no se uso en produccion.
