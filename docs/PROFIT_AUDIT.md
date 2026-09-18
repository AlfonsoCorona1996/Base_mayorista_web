# Utilidades y socios: criterio y trazabilidad

La vista de **Utilidades y socios** es un reporte vivo de pedidos por mes de
creación, separado de los cierres contables por entrega y del flujo mensual de
caja. Incluye pedidos en proceso, sin esperar a su entrega o liquidación.
El selector de negocio y el filtro de ruta siguen delimitando el reporte.
Los saldos de socios son acumulados de ese alcance; seleccionar un mes en el
detalle no los transforma en saldos mensuales.

## Cálculo

- Venta: suma de precio clienta por unidades vigentes, menos descuento vigente,
  más envío. Las confirmaciones pendientes usan cantidad solicitada. Se respetan
  confirmaciones parciales, unidades sin existencia, cancelaciones y devoluciones.
- Costo: precio costo registrado; solo si falta o es inválido, precio público / 2.
  El cero explícito se respeta. El detalle identifica la fuente por producto.
- Utilidad de venta: venta menos costo. El costo de devoluciones reintegrables
  se revierte; el de mercancía dañada se conserva.
- Cobrado: `totals.paid_amount`, limitado entre cero y la venta vigente. El
  excedente se señala para revisar reembolsos o saldos a favor. No se vuelven
  a sumar eventos de cobro al total del pedido, evitando duplicarlos.
- Utilidad cobrada: utilidad × cobrado / venta. Utilidad pendiente: utilidad
  menos su parte cobrada. Son atribuciones proporcionales del margen, no caja
  bancaria ni autorización para retirar dinero. Los gastos se informan aparte.
- Utilidad neta: utilidad de ventas menos gastos registrados; compra de mercancía
  queda como capital, sin duplicar el costo de los productos vendidos.
- Participación: utilidad neta dividida 50/50. Saldo por retirar: participación
  menos retiros explícitamente asignados a cada socio. No se resta de nuevo la
  parte pendiente de cobro. Se conservan saldos negativos y pérdidas.
- Redondeo a centavos por pedido. En reparto, el segundo socio recibe el
  centavo residual para que ambas partes sumen exactamente el total.

## Datos incompletos y movimientos

No se filtran pedidos por estado o por falta de datos. Cancelados/devueltos se
conservan con venta vigente cero. Sin productos, se conserva la venta del total
registrado. Sin cantidad, precio clienta o costo estimable, la utilidad del pedido
queda **sin determinar**; no se convierte en ganancia ficticia. Los totales
permanecen provisionales y el pedido está en “Datos por revisar”.

Las fechas usan `America/Mexico_City`. Las fechas originalmente ausentes se
conservan en metadatos de lectura, sin usar el día de carga como fecha real.
“Sin fecha” incluye esos registros. No se altera la persistencia.

Los retiros solo se asignan por `socio_blanca` o `socio_andrea_pepe`; un nombre
en las notas no prueba su destino. Otros retiros quedan pendientes de clasificar,
visibles, sin reducir arbitrariamente ambas participaciones. Los gastos cuyo
concepto sugiere retiro se señalan, conservando su categoría registrada hasta
su revisión. Ajustes estimados y devoluciones aproximadas se señalan para evitar
descontar además una devolución ya aplicada a los productos.

Un retiro pertenece al mes de su salida; no se presume que liquide la utilidad
del mismo mes. Por ello los saldos individuales se presentan acumulados.

## Auditoría reproducible, solo lectura

```powershell
node node_modules/tsx/dist/cli.mjs scripts/audit-profit-history.ts --credentials <ruta-credencial>
```

También acepta `GOOGLE_APPLICATION_CREDENTIALS`. Lee completas las colecciones
`orders`, `finance_expenses` y `finance_withdrawals`, sin límite, fecha o estado.
Genera un reporte Markdown y JSON por negocio en `tmp/profit-audit/` (ignorado
por Git). No modifica Firestore ni imprime credenciales. Los documentos sin
negocio aparecen como `sin-negocio`: requieren clasificación, ya que el cliente
autenticado solo consulta los negocios permitidos por sus reglas de acceso.

La revisión realizada el 16 de septiembre de 2026 encontró 379 pedidos: 373 de
Base Mayorista y 6 de Catálogo. Todos tenían negocio asignado. Base Mayorista
tenía 5 pedidos vacíos, 4 pedidos con cobro mayor a su venta vigente y 2 gastos
estimados que requieren conciliación. Catálogo tenía 2 pedidos vacíos y un
pedido sin costo ni precio público. No se modificó ninguno de estos registros.
También se identificaron 53 totales guardados que difieren del detalle vigente
en Base Mayorista; 50 estaban en cero pese a contener productos. Se conserva
la venta calculada por productos y ambos importes se muestran en el desglose.
Los importes y referencias completos están en el reporte local, no en Git.

## Interfaz y verificación

La jerarquía prioriza utilidad neta, saldo individual y tabla mensual. Las
devoluciones, descuentos y procedencia del costo quedan en el desglose por
producto. Los botones de cada mes y socio filtran el detalle y trasladan el foco
a su encabezado. Los pedidos originales se abren desde ese desglose.

El historial y los productos mantienen columnas con desplazamiento horizontal
contenido, anunciado y accesible por teclado. El resto se reorganiza en móvil.
El detalle pagina en grupos de 20 sin limitar el cálculo; CSV exporta todos los
registros del periodo seleccionado, incluso si hay búsqueda, filtro de socio o paginación.
Las cadenas potencialmente interpretables como fórmulas CSV se escapan.

La story `Administración/Utilidades y socios/Auditoría` usa datos ficticios y
ofrece variantes con datos, vacío, carga y error. Las pruebas de cálculo cubren
costos faltantes, cero explícito, pedidos incompletos, fechas, devoluciones,
abonos, sobrepagos, gastos, retiros, pérdidas y centavos.

Validación al incorporar el PDF: la suite general ejecutó 215
pruebas: 214 aprobadas y una falla ajena en `review.spec.ts:79` (el mock de
publicación no implementa `invalidateAllValidated`, por lo que no navega).
Build de producción aprobado con advertencias de presupuesto y CommonJS.
El proyecto no tiene script de lint.

La revisión en navegador usa 1440×900, 1024×768, 768×1024, 390×844 y 360×800,
incluyendo filtros, CSV, foco, estados de carga/error/vacío, nombres largos y
zoom al 200%. Evidencias locales en `tmp/profit-audit/screenshots/`.

## Reporte para socios: consulta y PDF

Desde **Preparar reporte para socios** se puede elegir todo el historial, un
mes, “Sin fecha” o un rango de fechas con ambos extremos incluidos. El rango
usa la creación del pedido y la fecha de ocurrencia de cada movimiento, nunca
la fecha de pago para atribuir ventas. Las fechas incompletas o invertidas
bloquean la exportación y muestran el motivo.

La vista del periodo y el PDF usan la misma selección y los mismos totales.
La cobranza representa el acumulado actual de los pedidos seleccionados,
incluyendo pagos posteriores al rango; no es el cobro ocurrido dentro del rango
ni una reconstrucción del saldo al cierre. Se identifica negocio, ruta, periodo,
momento de emisión y moneda MXN.

**Ver y descargar PDF** genera un documento local con `pdf-lib` (dependencia
existente, cargada bajo demanda), abre una vista previa y permite descargarlo.
No transmite datos a un servicio externo. El visor nativo depende del navegador;
la descarga y el detalle HTML permanecen disponibles. El diálogo permite Escape
y devuelve el foco al botón de origen. Cada emisión captura una selección
coherente antes de cargar el generador.

El documento contiene resumen de ventas, costos, cobranza y utilidad; reparto
y retiros del periodo; saldos históricos por socio claramente separados;
tabla de todos los pedidos; gastos y retiros con referencias; fechas de pago,
estimaciones, devoluciones, excedentes y observaciones por pedido. El desglose
de productos es opcional. Los pagos son acumulados por pedido, no una relación
de abonos individuales. Los registros sin fecha se anexan por separado cuando
no pueden atribuirse al periodo, sin sumarlos a sus totales.

El PDF no aplica búsqueda, filtro de socio ni paginación del detalle. Las tablas
repiten encabezados; los textos largos continúan en páginas adicionales y los
pedidos conservan su referencia. Los caracteres fuera de WinAnsi se representan
con su código Unicode para evitar fallos o eliminación silenciosa de texto.

Pruebas del reporte cubren límites inclusivos, rangos inválidos, cobranza posterior,
pedidos incompletos/sin fecha y filtros que no deben limitar una exportación.
La validación documental sobre la lectura del 16 de septiembre comprobó los
373 pedidos de Base Mayorista presentes en el PDF completo, sin texto fuera
de página; también se verificó un PDF de junio y contenido artificial extremo.
La descarga desde navegador se cotejó con los totales y referencias esperados.
Evidencia local: `tmp/profit-audit/pdf-validation.json` y
`tmp/profit-audit/pdf-browser-results.json`. Los PDF con datos reales permanecen
en `tmp/`, fuera de Git; son ejemplos de esa lectura, no una consulta actualizada.

## Normalización autorizada de fechas de pago

El 16 de septiembre de 2026 se aplicó en Firebase el criterio solicitado por
el usuario para Base Mayorista: los cobros de pedidos creados del 1 de mayo
al 31 de agosto de 2026 toman la fecha de creación del pedido como fecha
histórica **estimada**. Los límites de mes se interpretan en Ciudad de México.

Se actualizaron 123 pedidos (74 de mayo, 36 de junio, 4 de julio y 9 de agosto)
y 14 eventos históricos. Se conservaron sin cambios 116 pedidos sin cobros en
ese intervalo. No se cambiaron importes, saldos, estados, fecha de creación ni
otros campos operativos. No había asientos ni periodos cerrados vinculados.

Los campos canónicos `orders.paid_at` y
`order_collection_events.cash_occurred_at` contienen ahora la fecha estimada;
no hay una excepción de cálculo por rango de fechas en la interfaz.
`paid_at_quality` / `data_quality` indican la estimación y
`payment_date_normalization` guarda versión, criterio, fecha anterior y momento
de normalización. La fecha de creación del evento de captura se conserva.

```powershell
# Ensayo sin escrituras en Firebase
node node_modules/tsx/dist/cli.mjs scripts/normalize-historical-payment-dates.ts --credentials <ruta>
# Aplicación explícita: respaldo, lote atómico con precondiciones, verificación
node node_modules/tsx/dist/cli.mjs scripts/normalize-historical-payment-dates.ts --credentials <ruta> --apply
```

El script respalda los documentos completos y los tipos Timestamp antes de
escribir en `backups/payment-dates-created-at-2026-may-aug-v1/`, excluido de Git.
Comprueba que ningún campo ajeno al cambio se haya alterado. La marca de versión
evita reaplicar el criterio, incluso si después se registra un pago real nuevo.
No crea cobros ni asientos, ni modifica cuentas bancarias. Se detiene ante
asientos o periodos cerrados que requieran conciliación.
