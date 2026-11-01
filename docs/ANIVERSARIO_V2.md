# Encuesta de aniversario: actualización estratégica v2

Implementada el 31 de octubre de 2026. Campaña `aniversario-2026`, URL pública `/aniversario`,
`SURVEY_QUESTIONS_VERSION = 2` y `questions_version: 2` en backend. Sin despliegue a producción.

## Auditoría y alcance

La encuesta existente utiliza un componente Angular standalone y una configuración centralizada de
seis preguntas en `survey-definition.ts`. Se reutilizaron el renderizador, formularios nativos,
validación de Otro, historial, guardado local, API, registro del regalo y comprobante. No se
reconstruyeron componentes ni se instalaron dependencias.

La ruta no requiere autenticación. El navegador llama al backend Express; no escribe directamente
en Firestore. El backend está en el repositorio vecino `Base Mayorista Backend/Base_Mayorista` y
mantiene su propia definición y validación. Ya existía un panel administrativo de resultados.

Se conservan el logo BM en `public/aniversario/`, sus originales en `brand/`, la paleta, escala de
satisfacción y demás patrones de interfaz. No se cambiaron autenticación, pedidos, clientas,
promociones, reglas de Firestore ni condiciones del regalo.

## Contenido y comportamiento

| Pregunta | Campo | Tipo y límite |
| --- | --- | --- |
| Experiencia actual | `satisfaction` | Escala neutral 1–5 |
| Fortalezas que conservar | `strengths` | Múltiple, hasta 2 |
| Herramientas que aportan valor | `improvements` | Múltiple, hasta 2 |
| Interés en iniciativa Facebook | `facebook_interest` | Única, exactamente 1 |
| Catálogo del segundo año | `new_products` | Múltiple, hasta 3 |
| Propuesta para el segundo año | `comment` | Opcional, sin mínimo, máximo existente de 1000 |

La bienvenida y la pantalla de registro usan los textos solicitados. La bienvenida estática de
arranque rápido se actualizó junto con la plantilla Angular; el build comprueba su sincronización.
El bloque de Facebook presenta una propuesta en preparación y aclara que responder no implica
inscripción ni autorización para compartir datos. No hay promesas de clientas o beneficios.

Otro cuenta dentro del límite, exige 2–120 caracteres, conserva su texto al navegar y se limpia
al desmarcarlo. En Facebook se renderizan radios nativos y cambiar de opción reemplaza la selección,
sin deshabilitar las demás respuestas. El backend vuelve a validar todas estas restricciones.

## Persistencia y compatibilidad

Se mantiene `bm.survey.aniversario-2026`, el guardado inmediato de selecciones y pasos, debounce de
400 ms en textos, guardado en `pagehide`/`visibilitychange`, tolerancia a red y reintentos con el mismo
`participation_id`. No cambia la versión del contenedor local (`schema: 1`); las preguntas se
distinguen por `questionsVersion`.

- **Borrador v2:** retoma paso, opciones, Otro, comentario y nombre pendiente.
- **Borrador v1 sin enviar:** se respalda en la clave `.previous`, comienza vacío en v2 y muestra un
  aviso. Si el navegador impide escribir el respaldo, se conserva el funcionamiento en memoria.
- **Envío v1 pendiente:** se conserva una instantánea `legacySubmission` con respuestas originales,
  nombre e identificador. Solo se ofrece reintentar ese envío; los campos quedan en lectura y no se
  permite volver a reinterpretar sus respuestas en las preguntas nuevas. También sobrevive a nuevas
  reaperturas. El backend mantiene la definición v1 para validarlo y responder idempotentemente.
- **Comprobante v1 confirmado:** sigue mostrando el registro y regalo originales al reabrir.
- **Datos corruptos o versiones desconocidas:** se descartan de forma defensiva, sin atribuirlos a v2.

No se borraron ni reescribieron datos históricos. Los navegadores que todavía ejecuten v1 pueden
enviar su esquema antiguo; sus respuestas quedan explícitamente como v1.

## Backend, Firestore y reportes

Se conservan los endpoints y la transacción que crea `survey_responses` y `survey_reward_claims`.
Los registros v2 sustituyen `answers.sell_more` por `answers.facebook_interest`, con la misma forma
`{ selected, other }`. Los IDs de interés son `very_interested`, `needs_information`,
`not_interested` y `other`. El regalo sigue pendiente de definición salvo configuración real del backend.

El resumen administrativo devuelve `summary` de v2, `summaries_by_version` para v1/v2 y el conteo
`unversioned_responses`. Cada resumen filtra primero las respuestas de esa versión y sus registros
de regalo; no mezcla totales, promedios, distribuciones, comentarios ni nombres repetidos.
Los registros sin versión reconocida se excluyen y se informa su conteo.

El panel conserva su diseño y añade un selector de versión, nuevos títulos y el desglose de
Facebook al principio de las opciones. Las etiquetas históricas siguen siendo las de v1.
Se mantienen búsqueda, estados vacíos, error con reintento, participaciones y regalos por validar.
No se necesitan colecciones nuevas, migraciones ni cambios de índices o reglas.

## Archivos modificados

Frontend, en `src/app/features/public/anniversary-survey/`:

- `survey-definition.ts`: preguntas, opciones, tipos y versión.
- `survey-state.ts`: validación, payload, lectura segura y compatibilidad v1.
- `survey-draft-storage.ts`: respaldo de borradores incompatibles.
- `anniversary-survey.ts`: selección única, recuperación y reintentos v1.
- `anniversary-survey.html`, `anniversary-survey.css`: textos y bloque informativo compacto.
- `welcome.static.html`: bienvenida de arranque sincronizada.
- `survey-state.spec.ts`, `survey-draft-storage.spec.ts`, `anniversary-survey.spec.ts`: pruebas.

Panel, en `src/app/features/administracion/`:

- `encuesta-aniversario.page.ts`, `.html`, `.css`, `.spec.ts`: selección de versión y reportes.

Backend, en el repositorio vecino:

- `survey_definitions.js`: definición v2 y conservación de v1.
- `survey_helpers.js`: validación de selección única y agregados aislados por versión.
- `survey_routes.js`: selección del esquema recibido y reportes por versión.
- `survey_helpers.test.js`: pruebas de v2 y aislamiento histórico.

Documentación: `docs/ANIVERSARIO.md` y este archivo.

## Validación ejecutada

- Pruebas focalizadas finales de encuesta, persistencia y panel: **40/40** aprobadas con ChromeHeadless.
- Suite completa del frontend: **503/505** aprobadas. Los dos fallos son los previamente documentados
  de `AppVersionService`, que esperan `/version.json?v=2.2.3` cuando el proyecto es 2.3.0.
- Suite completa del backend: **158/158** aprobadas, incluyendo validación y resúmenes de ambas versiones.
- Build de producción: completado, incluyendo la generación y sincronización de `aniversario.html`.
  Persisten avisos existentes de presupuesto inicial y dependencias CommonJS.
- No existe script de lint configurado. `git diff --check` revisado en ambos repositorios.
- Chrome contra el build de producción y **rutas reales del backend**, conectadas exclusivamente al
  emulador Firestore `127.0.0.1:8187`, proyecto `demo-bm-anniversary-v2`: escritura y lectura de
  respuestas/regalos, validación del esquema, separación de reportes v1/v2, reenvío sin duplicados.
- Flujo completo en **1440×900, 1024×768, 768×1024, 390×844, 360×800 y 320×568**: seis preguntas,
  límites 2/2/3, Otro obligatorio y limpieza, retroceso, comentario opcional, nombre largo, registro
  y comprobante. Verificación de overflow, tamaño táctil, tipografía de inputs y acceso a acciones
  mediante scroll sin superposiciones.
- Cierre de pestaña en pregunta 4, reapertura y recarga tras escribir Otro; reinicio informado de v1,
  respaldo local, envío v1 pendiente tras dos reaperturas, comprobante persistente y reconexión con
  envío automático. Navegación por teclado y texto ampliado al 200 %.
- Panel administrativo renderizado con sus componentes reales y resultados del emulador en los cinco
  tamaños exigidos: versiones v1/v2, textos y nombres largos, búsqueda sin resultados y ausencia de
  overflow horizontal.

Scripts, logs, resultados del emulador y capturas locales: `tmp/anniversary-v2/` (ignorado por Git).
El servidor del harness monta la ruta administrativa únicamente para pruebas locales; no altera la
autorización de la aplicación. No se enviaron respuestas de prueba a producción.

## Pendientes y límites

Publicar requiere autorización: desplegar primero el backend compatible con ambas versiones y luego
el frontend. El beneficio concreto sigue pendiente de definición comercial. No se probó en un
teléfono físico, navegador integrado de WhatsApp ni WebKit en esta actualización, ni se hicieron
nuevas mediciones de rendimiento. Los dos fallos globales de versión quedan fuera de este cambio.
