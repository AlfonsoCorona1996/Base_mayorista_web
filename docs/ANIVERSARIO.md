# Encuesta del primer aniversario (`/aniversario`)

Encuesta pública (sin login) para las clientas afiliadas, con registro del regalo de aniversario.
Se comparte por WhatsApp. Implementación: frontend Angular (este repo) + backend Express
(`Base Mayorista Backend/Base_Mayorista`).

## Cómo activar la campaña

1. **Backend**: desplegar `survey_definitions.js`, `survey_helpers.js`, `survey_routes.js` y los
   cambios de `server.js` y `session_authorization.js`. No requiere variables nuevas.
2. **Frontend**: `npm run build` y publicar `dist/admin-web/browser` en Cloudflare Pages como siempre.
   El build genera `aniversario.html` (ver abajo); no hace falta configurar nada en Cloudflare.
3. Comprobar:
   - `https://api.base-mayorista.com/api/surveys/aniversario-2026` responde `{"ok":true,"status":"active",...}`.
   - `https://www.base-mayorista.com/aniversario` abre la bienvenida.
   - La vista previa con el [depurador de Facebook](https://developers.facebook.com/tools/debug/)
     (WhatsApp usa los mismos metadatos Open Graph).
4. Compartir el enlace. Mensaje sugerido:

   > ¡Cumplimos un año y el regalo es para ti!
   > Responde nuestra encuesta de aniversario y registra tu regalo especial.
   > 6 preguntas. Aproximadamente 2 minutos.
   > https://www.base-mayorista.com/aniversario

Sin documento de configuración la campaña está **activa** y el regalo queda **pendiente de definir**.

## Configurar la promoción o cerrar la campaña

Documento opcional en Firestore: `survey_campaigns/aniversario-2026` (se edita desde la consola de
Firebase; el backend lo relee cada 60 s).

```json
{
  "status": "active",
  "closes_at": "2026-11-30T23:59:59-06:00",
  "reward": {
    "status": "active",
    "title": "Nombre del regalo",
    "description": "Detalle breve (opcional)",
    "redeem_instructions": "Cómo canjearlo (opcional)"
  }
}
```

- `status: "closed"` o una fecha `closes_at` vencida cierran la encuesta (la página lo informa).
- El regalo solo se muestra si `reward.status` es `"active"` **y** hay `title`. Si no, las clientas ven
  «Detalles por anunciar»: nunca se inventan montos ni condiciones.
- Cada registro guarda una copia del regalo vigente en ese momento (`reward_snapshot`).

## Arquitectura

| Pieza | Archivo |
| --- | --- |
| Ruta pública lazy | `src/app/app.routes.ts` → `features/public/anniversary-survey/anniversary-survey.ts` |
| Preguntas y opciones (versión 2) | `features/public/anniversary-survey/survey-definition.ts` |
| Modelo, validación y lectura segura del borrador | `survey-state.ts` |
| Guardado local | `survey-draft-storage.ts` |
| Llamadas al backend | `survey-api.service.ts` |
| Bienvenida estática (arranque rápido) | `welcome.static.html` |
| HTML con Open Graph | `scripts/generate-anniversary-page.mjs` (lo ejecuta `scripts/build.mjs`) |
| Arranque ligero (sin SW ni lectura de Firestore) | `src/app/core/public-landing.ts`, `app.ts`, `app.config.ts` |
| Resultados para Administración | `/main/administracion/encuesta-aniversario` (`features/administracion/encuesta-aniversario.page.*`) |
| Assets | `public/aniversario/` (`bm-logo.webp/.png`, `og-aniversario.jpg`) |

La encuesta no usa Firebase Auth ni Firestore desde el navegador: todo pasa por el backend.

### Por qué existe `aniversario.html`

La app es una SPA sin SSR y los bots de WhatsApp no ejecutan JavaScript. El build copia `index.html`
a `aniversario.html` con título, descripción, Open Graph, imagen y `canonical` propios. Cloudflare
Pages sirve `aniversario.html` para la URL `/aniversario` (coincidencia de ruta con archivo `.html`);
la app Angular arranca igual y resuelve la ruta.

Ese HTML también:

- Muestra la bienvenida real en HTML estático mientras descarga la app (LCP inmediato). Si la clienta
  toca «Comenzar encuesta» antes de que cargue, se recuerda y la app avanza sola. Si ya tenía un
  borrador avanzado, solo se ve el logo para no mostrar una bienvenida que va a cambiar.
- Precarga (`modulepreload`) el chunk de la encuesta para no esperarlo en cascada.
- No declara la fuente de iconos ni el manifest de la PWA administrativa.

El generador **falla el build** si cambia la estructura de `index.html` o si los textos de
`welcome.static.html` (marcados con `data-sync`) dejan de coincidir con `anniversary-survey.html`.
Si cambias un texto de la bienvenida, cámbialo en ambos archivos.

`public/_redirects` no se modificó. Se comprobó en producción (2026-10-29, solo lectura) que
Cloudflare sirve los archivos reales antes que la regla genérica (`/version.json` responde JSON) y que
aplica las URLs sin `.html` (`/index` redirige a `/`), así que `/aniversario` servirá
`aniversario.html` con su vista previa. Tras desplegar, confirmar con el depurador de Facebook.

## Guardado automático y recuperación

- Clave `localStorage`: `bm.survey.aniversario-2026`. Contiene `schema`, campaña, versión de preguntas,
  `participationId` aleatorio (UUID), paso actual, respuestas, textos de «Otro», comentario, nombre,
  estado del envío (`idle` / `pending` / `confirmed`), comprobante y fechas.
- Selecciones y cambios de paso se guardan al instante; los textos con 400 ms de retraso y se fuerzan
  al guardar en `visibilitychange` (oculta), `pagehide` y al cambiar de paso.
- Al reabrir el enlace en el mismo navegador retoma la pregunta y muestra «Retomamos tu encuesta donde
  la dejaste.» con la opción «Comenzar de nuevo» (pide confirmación). Nunca retoma más allá de una
  pregunta obligatoria vacía.
- Un borrador v1 sin enviar se respalda en `bm.survey.aniversario-2026.previous` y se reinicia con
  un aviso. Las respuestas antiguas no se reinterpretan como v2. Los comprobantes v1 se conservan.
- Un envío v1 pendiente se recupera como instantánea de solo lectura (`legacySubmission`) y se
  reintenta con su mismo identificador y versión. El backend mantiene la definición v1 para estos
  reintentos y navegadores que todavía tengan el bundle anterior en caché.
- Un borrador corrupto se descarta. Si `localStorage` está bloqueado la encuesta funciona en memoria
  y lo avisa en la bienvenida.
- El botón Atrás del navegador/Android recorre las preguntas (historial con `pushState`).
- Tras la confirmación del servidor el borrador se reemplaza por el comprobante (sin respuestas ni
  nombre, por si el celular es compartido). Reabrir el enlace muestra la confirmación; desde ahí otra
  persona puede empezar una encuesta nueva.
- Límites: no se recupera entre dispositivos ni entre el navegador interno de WhatsApp y el externo
  (almacenamientos distintos), ni si se borran los datos del sitio.

### Sin conexión e idempotencia

- Sin internet se muestra un aviso y se puede seguir contestando.
- Enviar sin conexión muestra: «Tus respuestas siguen guardadas en este celular. Cuando tengas
  conexión, podrás enviarlas.» Al volver la conexión se reintenta solo; también hay botón de reintento.
- `participation_id` es la clave de idempotencia: si el servidor guardó pero la respuesta se perdió, el
  reintento devuelve el mismo registro (`200`, `replayed: true`) sin duplicar.
- Solo se afirma el registro con la confirmación del servidor.

## Backend

### Endpoints

| Método y ruta | Acceso | Uso |
| --- | --- | --- |
| `GET /api/surveys/:campaignId` | público | Estado de la campaña y regalo |
| `POST /api/surveys/:campaignId/responses` | público | Registrar respuestas + regalo |
| `GET /api/admin/surveys/:campaignId/summary` | sesión con sección Administración | Resultados agregados |

Respuestas del `POST`: `201` registrado, `200` reintento de un registro existente, `400` validación
(`fields` con códigos), `409 CAMPAIGN_CLOSED`, `413` cuerpo demasiado grande, `429` límite (30 envíos
por IP cada 10 min, holgado por el CGNAT de los operadores móviles), `500` error. Todas con
`Cache-Control: no-store`.

El backend vuelve a validar todo: opciones conocidas, máximos v2 (2/2/1/3), con selección única en Facebook, «Otro» con 2–120 caracteres,
comentario ≤ 1000, nombre de 2–80 caracteres con letras, sin caracteres de control. Sin CAPTCHA.

### Datos (Firestore, solo escritura vía Admin SDK)

- `survey_responses/{campaign}__{participationId}`: `participation_id`, `campaign_id`,
  `questions_version`, `answers` (`satisfaction`, `strengths`, `improvements`, `new_products`,
  `facebook_interest` con `{ selected, other }`, `comment`) en v2; v1 conserva `sell_more`. Atajos `satisfaction`, `comment`, `has_comment`,
  `claim_id`, `status: "received"`, `payload_hash`, `client_started_at`, `received_at` (hora del
  servidor), `created_at`.
- `survey_reward_claims/{mismo id}`: `registered_name`, `registered_name_key` (normalizado para
  detectar repetidos), `status: "pending_validation"` (luego `validated` / `rejected` / `redeemed`),
  `customer_id: null`, `reward_status`, `reward_snapshot`, `redeemed_at`, fechas.
- `survey_campaigns/{campaignId}`: configuración opcional (arriba).

Las reglas de Firestore no se cambiaron: estas colecciones no tienen reglas de cliente, por lo que el
acceso desde el navegador está denegado. El nombre no prueba identidad: el regalo se valida contra las
clientas afiliadas antes de entregarlo (la vista de Administración marca nombres repetidos).

### Versiones y reportes

El cuestionario actual es **v2**. `facebook_interest` utiliza `very_interested`, `needs_information`,
`not_interested` u `other`. Es interés declarado, sin inscripción ni consentimiento para compartir datos.
Los registros históricos conservan `questions_version: 1` y no se modifican ni borran.

El resumen incluye `summary` (v2), `summaries_by_version` (v1/v2 por separado) y
`unversioned_responses` (conteo de registros excluidos por versión ausente o desconocida).
Cada agregado filtra respuestas y sus regalos antes de calcular totales, promedios, rankings y comentarios.
El panel permite elegir versión; Facebook aparece primero entre las secciones de opciones de v2.
No se requieren migraciones, índices, nuevas colecciones ni cambios de reglas de Firestore.

Para publicar v2, actualizar **primero el backend** y después el frontend. El backend actualizado
acepta v1 y v2, pero el backend anterior rechazaría envíos v2. No se ha desplegado esta actualización.

Ver auditoría, archivos y comprobaciones del cambio en [ANIVERSARIO_V2.md](ANIVERSARIO_V2.md).

## Logo BM

Originales en `brand/` (no se publican): `bm-logo-completo.png` (bolsas + «BASE MAYORISTA») y
`bm-logo-icono.png` (bolsas con «BM»). La paleta de la encuesta sale de sus colores: carbón `#1d1d1f`,
naranja `#ffb11d → #ff8615 → #eb500b` y magenta `#e21363 / #d50e5f`.

Uso: logo completo en la bienvenida y la confirmación, ícono en el encabezado de las preguntas, en el
favicon y el ícono de inicio de `aniversario.html` (el panel conserva sus íconos) y en la imagen de
WhatsApp.

Para sustituirlo: reemplazar los PNG de `brand/` (fondo blanco, 1024 px o más) y ejecutar
`python scripts/generate-anniversary-assets.py` (requiere Pillow y numpy). Regenera
`public/aniversario/` (logo e ícono con fondo transparente, favicon, ícono de iOS e imagen Open Graph).
Si cambian los colores, ajustar los tokens al inicio de `anniversary-survey.css` y los valores
equivalentes en `welcome.static.html`.

## Resultados de validación (2026-10-28)

Todo se ejecutó contra el build de producción; el backend de pruebas usó el **emulador** de Firestore
(nunca producción). Las llamadas a `api.base-mayorista.com` se redirigieron al backend local.

| Prueba | Resultado |
| --- | --- |
| Unit tests frontend (Karma) | 493/495. Los 2 fallos son previos y ajenos: `AppVersionService` espera la versión 2.2.3 y `package.json` está en 2.3.0. Los 32 tests nuevos pasan. |
| Unit tests backend (`npm test`) | 132/132 (16 nuevos: validación, configuración, resumen y permiso de la ruta admin). |
| E2E Chrome (móvil emulado) | 61/61 con el logo nuevo |
| E2E WebKit (motor de Safari) | Con el logo nuevo: 60 flujos funcionales OK; el barrido de viewports se interrumpió porque WebKit se cerró con la máquina saturada. Con el diseño anterior pasó 61/61. |
| Build de producción | OK. El aviso de presupuesto inicial (825 kB) ya existía (822 kB antes de este cambio). |

El E2E cubre: acceso sin login, selección única y múltiple, límites, «Otro» (aparece, se exige, se
limpia), regresar y modificar, pregunta opcional, nombre obligatorio, envío y confirmación, cerrar en
la pregunta 2, recargar en la 4, cerrar mientras se escribe en «Otro», pestaña oculta (simulada) y
página congelada, pérdida y recuperación de conexión con envío automático, error 500 y reintento,
respuesta perdida sin duplicado, borrador corrupto o de otra versión, almacenamiento bloqueado,
campaña cerrada y regalo configurado, botón Atrás, teclado, bienvenida estática con toque temprano, y
9 viewports (320×568, 360×640, 375×667, 390×844, 412×915, 360×800, 768×1024, 1024×768 y 1440×900)
sin overflow horizontal, textos recortados, controles menores de 44 px ni inputs menores de 16 px.

Rendimiento con el logo nuevo (carga en frío, 360×640, Chrome headless, mediana de 5 corridas,
2026-10-29):

| Perfil | LCP | CLS | INP (toques) | Teclado (retraso + proceso) | Transferido |
| --- | --- | --- | --- | --- | --- |
| Slow 4G + CPU 4× | 0.56 s | 0 | 176 ms | 13 ms | 312 KB |
| Fast 3G + CPU 6× | 1.23 s | 0 | 272 ms | 15 ms | 312 KB |

- Antes de optimizar: LCP 3.6 s / 6.5 s e INP 360 / 480 ms con los mismos perfiles.
- La interacción más lenta es el primer toque («Comenzar encuesta»). Con CPU 6× **no cumple** la meta
  de 200 ms.
- La app queda interactiva a los ~2.9 s (4×) y ~4.9 s (6×). Mientras tanto, la bienvenida estática ya
  se ve y registra el toque.
- La bienvenida estática debe quedar idéntica a la de Angular (mismo ancho, espaciado y
  `box-sizing`): si difieren, el LCP vuelve a esperar a Angular y aparece CLS.
- El repo vive en OneDrive y la sincronización consume CPU tras cada build: mide con OneDrive en
  pausa o repite varias corridas.
- En headless la presentación de frames tras teclear se reporta con retraso artificial (~1.4 s). Por
  eso el teclado se midió como retraso + procesamiento y aparte con *long animation frames*.
- No se midió en dispositivos físicos ni dentro del navegador de WhatsApp. Conviene probar en un
  Android de gama baja real antes del envío masivo.
