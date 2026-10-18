# Diagnóstico y corrección de Usuarios — 18 de octubre de 2026

Trabajo local en los repositorios frontend y `Base Mayorista Backend/Base_Mayorista`. No se ejecutaron commit, push, deploy, migraciones ni operaciones con cuentas o datos reales. Las modificaciones de Pedidos que ya existían al comenzar quedaron fuera de este trabajo.

## Causa raíz y evidencia

Las líneas «antes» corresponden al HEAD local inspeccionado, antes de estas correcciones.

| Hallazgo | Evidencia antes | Corrección / ubicación actual |
| --- | --- | --- |
| Se perdía el username exacto: `Jazmin` se enviaba y almacenaba como `jazmin`. El normalizador del formulario también eliminaba caracteres sin informar. | `usuarios.ts:572`, `user-admin-api.service.ts:233`; backend `admin_users_routes.js:817,1405` | [Validación explícita y conservación del texto](../src/app/features/usuarios/usuarios.ts#L558); [payload](../src/app/services/user-admin-api.service.ts#L212). Backend conserva `username` y añade `usernameNormalized`. |
| El frontend omitía `businessMemberships` en el alta y después escribía el perfil directamente en Firestore. Si esa segunda operación fallaba, la cuenta de Auth ya existía y la interfaz informaba error. | `user-admin-api.service.ts:230`, `usuarios.ts:584,962` | Las membresías se envían en el mismo endpoint y se persisten con Admin SDK. Se eliminó la escritura posterior desde el componente, también en la edición de membresías. |
| Una reserva inicial con `uid=null` podía ser compartida por dos altas concurrentes. La asociación final al UID ocultaba errores con `.catch(() => null)` y la liberación no comprobaba propietario. | Backend `admin_users_routes.js:1254,2084,2107` | Backend `admin_users_routes.js:1249`: propietario aleatorio por intento, transferencia de propiedad comprobada, unicidad transaccional y liberación condicionada. Se comprueban también usernames históricos sin índice y con distintas mayúsculas, sin migrarlos. |
| El endpoint de primer acceso activaba la cuenta sin cambiar ni verificar la contraseña. Bastaba llamarlo directamente; la comprobación del navegador podía evitarse. | Backend `admin_users_routes.js:1810,1897` | Backend `admin_users_routes.js:1791,1878,1889`: exige contraseña de 8–128 caracteres y autenticación reciente; cambia la contraseña con Admin SDK antes de activar el perfil. Solo actúa sobre el UID autenticado. |
| Completar el primer acceso dejaba al usuario sin permisos: el endpoint leía los campos antiguos `permissions`, pero `upsertProfileDocs` y los claims ya los eliminaban. El fallback era un mapa vacío que reemplazaba las secciones válidas. | Backend `admin_users_routes.js:1909,1462`; reproducido en emuladores | Backend `admin_users_routes.js:1904` reutiliza `resolveProfilePermissions(before, claims)`. Conserva las secciones y capacidades actuales. También se elimina el alias antiguo `invite_pending` al persistir su campo canónico. |
| Era posible crear el propio documento `users/{uid}` con un rol arbitrario. También se permitía quitar `mustChangePassword` sin demostrar un cambio real. Cualquier usuario activo podía listar todos los perfiles. | `firestore.rules:99,100,114` | [Reglas de perfiles](../firestore.rules#L104): únicamente Admin SDK escribe perfiles; listado reservado al superadministrador, lectura individual propia permitida. |
| Las reglas solo comprobaban `isActive`, usaban `userDoc().exists()` y leían claves `sections.*`, mientras el backend persiste secciones cortas (`pedidos`, etc.). | `firestore.rules:13,38`; backend `upsertProfileDocs` | [Estado operativo](../firestore.rules#L12) usa `exists(path)` y bloquea cambios de contraseña/invitaciones pendientes. [Secciones](../firestore.rules#L40) acepta ambos formatos con denegación por defecto. Se probaron las reglas reales, no las permisivas de `firestore.emulator-test.rules`. |
| Algunos endpoints administrativos solo verificaban un token. `requireSuperAdmin` aceptaba claims antiguos aunque el perfil actual ya estuviera desactivado. | Backend `wa_bot_routing_routes.js:39`, `market_insights_routes.js:29`, `admin_users_routes.js:1555` | `session_authorization.js` comprueba el perfil actual para toda la API privada; exige Administración para configuración del bot, políticas/sincronización de plantillas y análisis de mercado. Normaliza mayúsculas y barra final de la URL. `requireSuperAdmin` exige el perfil actual habilitado y sin pendientes. |
| La comprobación de primer acceso del padre `/main` no se volvía a ejecutar al navegar entre hijos. | `app.routes.ts:28` | [canActivateChild](../src/app/app.routes.ts#L29) mantiene el bloqueo en cada navegación hija. |
| Un nombre largo ensanchaba la lista en móvil; el overflow global lo ocultaba. | Estilos de Usuarios, reproducido en el arnés visual | Columnas con mínimo cero y nombres que permiten saltos de línea. Se reforzó la prueba para medir también los límites reales de los componentes. |

## Cómo funciona la autenticación real

- `AuthService.login()` transforma el identificador de username a minúsculas y usa `buildUsernameAuthEmail()`, ya existente en `rbac.constants.ts:261`. El dominio técnico existente es `users.base-mayorista.local`. No se añadió un esquema de autenticación ni se solicita inventar un correo para Jazmin.
- Se conserva el username visible/almacenado `Jazmin`; el identificador técnico y el índice de unicidad usan `jazmin`. El login sigue sin distinguir mayúsculas.
- El alta usa `POST /admin/users/invite` y **Admin SDK en backend**. No hay `createUserWithEmailAndPassword` en el flujo productivo de creación. No se encontró sustitución directa de la sesión del administrador; no fue necesaria una instancia secundaria de Auth.
- La arquitectura existente reserva la gestión de usuarios a `super_admin`. No se amplió el rol `admin` para crear usuarios.
- El rol existente para Jazmin es `operativo`. Su configuración predeterminada permite secciones operativas como Pedidos, Validación, Clientas, Inventario, Proveedores, Salidas y Embarques. Para las altas nuevas, el backend excluye Administración, Usuarios y capacidades de gestión/finanzas, y evita roles superiores en sus membresías aunque el preset enviado estuviera personalizado. No se crea otro rol ni se modifican cuentas existentes.
- La contraseña temporal la genera el backend, se devuelve con `Cache-Control: no-store` y se muestra en memoria en la interfaz. No se escribe en Firestore ni en auditoría. La activación cambia la contraseña en el servidor, vuelve a autenticar a la usuaria y dirige a la primera ruta autorizada.
- El uso de Admin SDK para cambiar contraseñas sin iniciar una sesión de usuario en el servidor está documentado por [Firebase](https://firebase.google.com/docs/auth/admin/manage-users).

## Archivos modificados

Frontend:

- `firestore.rules`, `firebase.users-test.json`.
- `src/app/app.routes.ts`.
- `src/app/services/user-admin-api.service.ts`, `src/app/services/users.service.ts`.
- `src/app/features/usuarios/usuarios.ts`, `usuarios.html`, `usuarios.css`.
- `src/app/features/auth/activate-account/activate-account.ts`, `activate-account.html`, `activate-account.css`.
- `src/app/core/managed-user-access.spec.ts`.
- `src/app/services/user-admin-api.service.spec.ts`.
- `src/app/features/usuarios/usuarios.spec.ts`.
- `scripts/test-managed-users.emulator.mjs` y este informe.

Backend:

- `admin_users_routes.js`.
- `server.js`.
- `session_authorization.js` (nuevo).

`firebase_admin.js` quedó restaurado: las pruebas inicializan el proyecto demo antes de importar el backend y no necesitan leer la clave de servicio real.

## Validación

| Comprobación | Resultado |
| --- | --- |
| Auth + Firestore reales de emulador con reglas del repositorio | **PASS**, 12 grupos; detalle debajo |
| Pruebas Angular focalizadas: autenticación, login, guards, alta y contrato del endpoint | **PASS**, 23/23 en la ejecución final |
| Suite Angular completa | **FAIL**, 402 PASS y 2 FAIL preexistentes en `app-version.service.spec.ts:23,47`: esperan `2.2.3`, el proyecto declara `2.3.0`. No se modificaron. |
| Suite backend (`node --test`, equivalente a `npm test`) | **PASS**, 92/92 |
| Sintaxis backend (`node --check` en los tres archivos) | **PASS** |
| Build de producción (`npm.cmd run build`) | **PASS** en la ejecución final; advertencias existentes de dependencias CommonJS |
| Lint | No hay comando/herramienta configurados en ninguno de los dos repositorios |
| Diff | Sin errores de whitespace; sin cambios propios en Pedidos |
| Usuarios y activación a 1440×900, 1024×768, 768×1024, 390×844 y 360×800 | **PASS** con componentes reales y servicios simulados: alta, mensajes, validación, navegación tras activación, foco, controles del alta de al menos 44 px y nombres largos. Se comprobaron límites de componentes además del ancho del documento. |

Los 12 grupos de integración incluyen:

1. Crear exactamente `Jazmin` una vez; rechazar `jazmin`/`JAZMIN`; carreras de altas con un único ganador.
2. Conservar mayúsculas, enlazar el mismo UID entre Auth/Firestore y no persistir contraseñas.
3. Iniciar sesión con la temporal; bloquear API y Firestore también con `isActive=true` y `mustChangePassword=true`.
4. Denegar activación sin contraseña, con contraseña insuficiente o para otro UID.
5. Cambiar realmente la contraseña antes de activar el perfil.
6. Conservar permisos de ventas; permitir escritura operativa de prueba y denegar Usuarios, cambio de rol, creación de usuarios, roles, cuentas financieras, configuración del bot y análisis de mercado. Denegar también variantes de URL con mayúsculas y barra final.
7. Rechazar la contraseña temporal después del cambio.
8. Denegar autoprovisión/escalada a una cuenta Auth sin perfil gestionado.
9. Conservar UID, token, contraseña y acceso del administrador; rechazar sus claims obsoletos si se desactiva su perfil de prueba.
10. Rechazar colisiones con un perfil histórico sin índice; comprobar auditoría sin contraseñas.
11. Inyectar un fallo al asignar claims y comprobar que se compensan Auth, perfil y reserva, sin cuenta huérfana.
12. Denegar Administración, Usuarios, capacidades financieras y roles superiores dentro de las membresías de un alta operativa, incluso con un preset personalizado enviado por el administrador.

La navegación manual a Usuarios y Administración se comprueba con los guards reales en Angular. Las operaciones HTTP y las reglas se prueban contra emuladores. El arnés visual no se conecta a Firebase ni a la API remota. No equivale a una prueba del despliegue productivo o del shell completo de `/main`.

Los logs y capturas locales están en `tmp/usuarios-debug/` (carpeta ignorada por Git).

## Cómo repetir la integración sin producción

Desde la raíz del frontend, en una terminal:

```powershell
firebase emulators:start --config firebase.users-test.json --project demo-usuarios-debug --only "auth,firestore"
```

En otra terminal, también desde el frontend:

```powershell
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9199"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8180"
$env:GCLOUD_PROJECT = "demo-usuarios-debug"
$env:GOOGLE_CLOUD_UNIVERSE_DOMAIN = "googleapis.com"
$env:USERS_BACKEND_DIR = "C:\Users\pepe_\OneDrive\Documentos\Base Mayorista Backend\Base_Mayorista"
node scripts/test-managed-users.emulator.mjs
```

El script rechaza proyectos que no comiencen con `demo-` y hosts que no sean `127.0.0.1`. Limpia únicamente los datos de ese proyecto en los emuladores indicados; no debe compartirse ese proyecto demo con otra sesión de pruebas simultánea. No ejecutar dos copias a la vez.

Para pruebas Angular en este equipo, donde el wrapper PowerShell de npm descartó argumentos:

```powershell
$env:CHROME_BIN = "C:/Program Files/Google/Chrome/Application/chrome.exe"
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless
npm.cmd run build
```

## Instrucciones para crear a Jazmin

Estas instrucciones se aplican **cuando el frontend, backend y reglas corregidos estén en el entorno que se vaya a utilizar**. Este trabajo no los publicó. `environment.ts` y `environment.production.ts` siguen apuntando a la API remota existente, por lo que iniciar `ng serve` por sí solo no crea un entorno de pruebas aislado.

1. Iniciar sesión con la cuenta existente de **Super admin**, sin estar en «vista en modo usuario».
2. Abrir `/main/usuarios` → pestaña **Usuarios** → **Crear usuario**.
3. Introducir **Nombre:** `Jazmin`; **Usuario:** `Jazmin`, respetando ese texto exacto.
4. Elegir **Tipo de acceso:** `Solo usuario`. No introducir un correo.
5. Elegir **Rol:** `Operativo`; dejar únicamente **BM** en **Negocios**. El backend excluye Administración y Usuarios de esta alta operativa; no seleccionar otro rol ni conceder permisos de gestión.
6. Pulsar **Crear usuario** una sola vez. Copiar la contraseña temporal mostrada antes de cerrar/recargar la pantalla y entregarla por el canal privado habitual. No pegarla en documentos, incidencias ni logs.
7. Conservar la sesión del administrador. En otro perfil de navegador o ventana privada, Jazmin entra con **Usuario:** `Jazmin` y la contraseña temporal.
8. Debe aparecer `/activate-account`. Escribir y confirmar la contraseña personal de 8–128 caracteres y pulsar **Activar usuario**. Si han pasado más de cinco minutos desde el login, volver a iniciarlo y repetir el cambio.
9. Tras la activación debe entrar a la primera sección autorizada, normalmente `/main/pedidos`. No debe ver Administración ni Usuarios; escribir `/main/usuarios` o `/main/administracion` manualmente debe ser rechazado. La contraseña temporal anterior deja de funcionar.

Si `Jazmin` ya existe, el flujo devuelve conflicto; no actualiza la cuenta existente ni regenera su contraseña automáticamente.

## Limitaciones y condiciones pendientes

- No se inspeccionaron ni cambiaron cuentas, roles efectivos, reglas desplegadas o credenciales reales. La configuración productiva actual no está verificada y no queda protegida por modificar solo archivos locales.
- Se necesita publicar coordinadamente el backend, frontend y reglas para aplicar estas garantías en producción. El endpoint de primer acceso ahora recibe `{ password }`: el backend corregido debe estar disponible antes de usar el frontend nuevo. No se realizó ese despliegue.
- No se inspeccionó la configuración real de roles. Las altas nuevas de `operativo` excluyen Administración/Usuarios y las capacidades de gestión/finanzas del payload y las membresías. No se alteró ningún rol real; las demás funciones operativas dependen de los permisos de ventas configurados.
- Las pruebas de permisos de ventas comprueban proyección de permisos, guards y operaciones de prueba; no ejecutan todos los procesos comerciales, integraciones WhatsApp ni operaciones con datos reales.
- Firebase Auth y Firestore no comparten una transacción. El alta compensa fallos y se probó esa compensación. Ante una interrupción de proceso o fallo simultáneo de compensación puede quedar una reserva retenida; se prefiere bloquear un segundo alta a sobreescribir una cuenta. Eso requiere revisión administrativa explícita, sin limpieza automática de usuarios existentes.
- La compatibilidad con usernames históricos sin índice usa una lectura de la colección de usuarios dentro de la reserva. Evita una migración invasiva; su costo crece con la cantidad de cuentas.
- No hay garantía sobre persistencia externa de cuerpos HTTP por infraestructura ajena al repositorio. El código revisado no registra ni persiste las contraseñas; no se verificó la configuración de proxies/observabilidad de producción.
