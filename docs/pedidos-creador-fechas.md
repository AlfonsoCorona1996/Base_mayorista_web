# Pedidos: creador y fecha de actualización

## Cambios

- El rango de la tabla (Hoy, 7 días, 30 días y fechas manuales) compara `updated_at` en la zona local del navegador. Conserva la caché por objeto del pedido y los demás filtros.
- “Creado por” muestra inicial, nombre y color según el género explícito: mujer rosa, hombre azul, sin especificar neutro. La flecha permanece en la última columna.
- Los nuevos pedidos guardan `created_by: { uid, name, gender }` en la escritura existente. El dato representa al creador en el momento de la creación; no consulta perfiles desde las filas ni modifica pedidos históricos.
- Los pedidos sin creador muestran “Sin registro”.
- El perfil admite `gender: "male" | "female" | null`, con selector al crear y editar usuarios.
- En móvil pequeño las fechas se apilan; los controles tienen fuente de 16 px y los atajos tienen un mínimo táctil de 44 px.

## Carga

No se agregaron dependencias, listeners, solicitudes de usuarios por fila ni solicitudes en el arranque de Pedidos. Se conservan warmup, cachés, carga diferida, OnPush y virtualización. El género viaja en las respuestas de usuarios y sesión existentes; el creador aumenta ligeramente el tamaño del documento del pedido.

La actualización puntual de género de Alfonso Corona, Jazmin y Andrea se ejecutó y verificó en Firebase con `scripts/set-user-genders.cjs`. No se deduce el género por nombre durante el uso de la aplicación. El script verifica coincidencias únicas y conserva respaldo local antes de escribir.

## Backend

Se modificaron en el repositorio hermano `Base Mayorista Backend/Base_Mayorista`:

- `admin_users_routes.js`: validación, guardado, listado y bootstrap del género.
- `schemas/authz/bootstrap.response.schema.json`: campo opcional en la respuesta.

Estos cambios están en el código local, sin desplegar. El frontend de desarrollo usa `https://api.base-mayorista.com`, por lo que la API debe publicar estos cambios para devolver género en sesiones y guardar modificaciones desde Usuarios. Después debe refrescarse la sesión; no se añadió una consulta de respaldo que encarezca el arranque.

## Verificación

- Build de producción correcto; avisos de presupuestos/CommonJS.
- Frontend: 444 pruebas correctas de 446. Las dos fallidas son de `AppVersionService`: esperan `/version.json?v=2.2.3`, frente a la versión actual `2.3.0`. No se modificaron esos archivos.
- Backend: 115/115 pruebas correctas; validación adicional de género válido, inválido, nulo, omitido y UID obligatorio.
- Pedidos: Chromium y WebKit en 1440×900, 1024×768, 768×1024, 390×844 y 360×800. Se verificaron desbordamientos, fechas sin superposición, nombres largos, orden de columnas, estados de carga/vacío/error, teclado y mínimo táctil de fechas. WebKit emulado no sustituye una prueba en iPhone físico.
- Con 200 pedidos simulados, la tabla siguió renderizando solo las filas cercanas al viewport. Cambiar filtros no inició nuevas lecturas de clientas.
- Usuarios: creación y edición del selector de género verificadas en Chromium en los mismos cinco tamaños, sin desbordamiento de página ni de campos.
- Evidencia local reproducible y capturas en `tmp/pedidos-creator/` (no versionado).
