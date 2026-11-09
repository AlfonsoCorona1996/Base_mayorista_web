# Utilidades, pagos a socios y compromisos

Complementa `PROFIT_AUDIT.md`. La política de utilidad y reparto no cambia.

## Consulta y lectura de saldos

- La cuenta de cada socio muestra su participación acumulada, lo ya recibido
  mediante retiros identificados y lo pendiente de pagar. Un exceso de retiros
  conserva el saldo a compensar. La cobranza pendiente de clientas se informa
  por separado y no se resta dos veces.
- Movimientos utiliza una tabla ordenable por fecha, importe, categoría y
  beneficiario. Permite combinar periodo, destino, categoría, beneficiario,
  cuenta, importes y búsqueda; incluye accesos a sueldos, paquetería y socios.
- La fecha representa cuándo ocurrió el movimiento, no el mes de utilidad al
  que se atribuye un retiro. Los registros sin fecha se identifican expresamente.
- Los sueldos capturados históricamente como retiros siguen visibles como
  registros por revisar: no se reclasifican automáticamente. Los retiros nuevos
  se capturan para un socio; los gastos operativos se capturan como egresos.
- Exportar resultados filtrados incluye todas las páginas de la consulta.
  El CSV y PDF del reporte completo conservan el alcance del periodo, separado
  de los filtros de detalle. Los beneficiarios se conservan en ambas salidas.
- Desde 1024 px, movimientos y compromisos conservan columnas; debajo se
  reorganiza cada fila con sus etiquetas, sin ocultar datos. El historial
  mensual mantiene su desplazamiento horizontal contenido.

## Compromisos del mes

Un compromiso es una previsión, no un egreso ni una transferencia bancaria.
Se puede registrar una sola vez, mensualmente o en quincenas del 15 y último
día del mes. El importe es por vencimiento. Un vencimiento mensual del día 31
se ajusta al último día de meses cortos sin cambiar el día de meses posteriores.

Cada vencimiento informa previsto, pagado, pendiente y estado (pendiente,
parcial, pagado o cancelado), además de si está vencido. Los pagos se acumulan
por vencimiento aunque se hayan registrado en otro mes. Se admiten importes
estimados, pagos parciales y diferencias sobre lo previsto.

Registrar pago reutiliza el egreso y la transacción contable existentes; su
identificador se conserva al reintentar. Vincular un egreso existente asigna
su importe completo a un vencimiento sin volver a descontarlo del banco.
Quitar vínculo conserva el egreso. Las vinculaciones exigen la misma categoría,
negocio y ruta, y no permiten asignar el mismo egreso a dos vencimientos.
Los periodos cerrados siguen protegidos por el servicio financiero.

Editar permite cambiar solo ese vencimiento o ese y los siguientes. La segunda
opción reemplaza también los ajustes futuros, como explica el formulario.
Cancelar conserva los pagos registrados y excluye el saldo del pendiente.
Se puede reactivar. El calendario y el alcance de una serie existente no se
modifican; para otro calendario se cancela la serie futura y se crea otra.

La proyección resta compromisos pendientes a la utilidad registrada del mes.
Es una estimación; no modifica el saldo histórico de socios ni representa
efectivo disponible.

## Persistencia y publicación

`finance_commitments` almacena una serie por documento, con negocio, ruta,
fechas, frecuencia, revisiones de condiciones y excepciones por vencimiento.
Un contador `revision` detecta ediciones concurrentes. Se reutilizan los permisos
de consulta, creación y edición de movimientos. No hay eliminación física.

Los egresos agregan campos opcionales `recipient`, `commitment_id` y
`commitment_due_date`. No se requiere migrar registros anteriores. Los
formularios existentes conservan los vínculos al editar un egreso.

Publicar requiere desplegar **también `firestore.rules`**, antes de habilitar la
nueva interfaz. Las reglas incorporan la colección y permiten las lecturas de
documentos inexistentes necesarias para crear egresos o retiros y comprobar un periodo
abierto. Los helpers financieros evitan repetir la comprobación de usuario
activo en cada permiso y respetan el límite de expresiones por transacción.
Los guardas de negocio siguen validando el usuario activo y su pertenencia.
Las pruebas no escribieron datos de producción. El 9 de noviembre de 2026,
tras la autorización de publicación, se desplegaron las reglas en
`base-mayorista` con `firebase deploy --only firestore:rules`.
Ruleset publicado: `72a3f7c7-173f-409f-b252-533acdb7985a`.

## Referencias de UX

Se adoptó la separación entre previsión, vencimiento y pago, junto con consulta
tabular por estado. Son patrones documentados en:

- [QuickBooks: transacciones recurrentes](https://quickbooks.intuit.com/learn-support/en-uk/help-article/recurring-transactions/create-recurring-transactions-quickbooks-online/L3WoKX2R8_GB_en_GB): plantillas programadas, recordatorios y uso manual.
- [Xero: cuentas pendientes](https://central.xero.com/0/article/View-unpaid-bills-US): vistas según el estado de las cuentas por pagar.
- [Xero: estados contables](https://developer.xero.com/documentation/api/accounting/types/): distingue pagos completos y facturas pendientes o parcialmente pagadas.

Estas fuentes documentan sus flujos; no aportan métricas públicas de mejora
aplicables a esta aplicación. La adaptación se validó con datos ficticios,
teclado, filtros combinados, exportación y registro de pagos.

## Verificación

Las pruebas unitarias cubren calendario, redondeo, estados, excepciones,
cancelación, pagos entre meses, filtros y permisos de interfaz. Storybook
`Administración/Utilidades y socios/Compromisos` utiliza servicios en memoria.
La validación de navegador se realizó a 1440×900, 1024×768, 768×1024, 390×844
y 360×800, además de zoom y foco de diálogos. Evidencia local en
`tmp/partners-validation/` (fuera de Git).

Las pruebas de persistencia están excluidas de la suite normal. Requieren el
emulador local de Firestore en `127.0.0.1:8189`, cargado con `firestore.rules`.
Solo usan datos ficticios del emulador; verifican concurrencia, aislamiento de
negocio, permisos, periodo cerrado y que reintentar/vincular no duplique saldos.

```powershell
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless --include=**/finance-commitments.emulator.spec.ts --exclude=**/unused.spec.ts
npm run build
```

Resultado del 9 de noviembre de 2026: build de producción correcto; 525 de
527 pruebas generales correctas y 5 de 5 pruebas de emulador correctas. Las
dos fallas generales son de `app-version.service.spec.ts`, que espera la
versión fija 2.2.3 mientras el proyecto usa 2.3.0; son ajenas a esta tarea.
El build conserva advertencias de tamaño inicial, fuentes y dependencias
CommonJS. No existe script de lint configurado.

Los cinco tamaños de pantalla pasaron la comprobación de desbordamientos y
áreas táctiles; axe no detectó infracciones en las tres vistas revisadas.
Las pruebas de navegador también comprobaron filtros combinados, CSV filtrado,
crear/editar/cancelar compromisos, vincular egresos, registrar pagos parciales,
cerrar con Escape, restaurar foco y ampliar a 200 %. Esto no sustituye una
auditoría completa con lectores de pantalla.
