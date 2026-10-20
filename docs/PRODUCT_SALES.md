# Ventas por producto y regularización histórica

## Corte aplicado

Por instrucción del usuario se regularizaron los pedidos con productos creados antes del **1 de octubre de 2026, 00:00, America/Mexico_City** (`2026-10-01T06:00:00Z`). Se leyeron 591 pedidos: 436 actualizados y verificados; 14 ya pagados; siete vacíos excluidos; 134 del corte en adelante sin cambios. Los pedidos cancelados o devueltos quedan excluidos por el procedimiento.

La regularización actualiza estado, pago de clienta, estado de cobro y saldo. Conserva los importes originales de la factura, las partidas y cualquier pago previamente mayor. Si el total registrado y el cálculo actual difieren, el importe liquidado cubre ambos sin reescribir la factura. No confirma partidas pendientes ni cambia movimientos de inventario.

Es una declaración histórica de pago, no un cobro nuevo en caja. No se generan movimientos de caja, depósitos ni eventos nuevos de recepción de dinero. Una fecha de pago existente se conserva; si falta, se usa creación como estimación y `paid_at_quality: estimated`. Cada pedido guarda `historical_payment_regularization` y un evento `HISTORICAL_PAYMENT_REGULARIZED` compatible con su historial.

Script reproducible: `scripts/mark-historical-orders-paid.ts`, seco por defecto y con `--apply` para escribir. Usa precondiciones por versión del documento, lotes acotados, copia previa, verificación de cada cambio e idempotencia. No ejecutar nuevamente para modificar otro corte sin revisar su constante y sus pruebas.

Respaldo y verificación locales, excluidos de Git: `tmp/historical-paid-2026-10-20T02-18-01-508Z/`. `backup.json` contiene las imágenes previas completas y `report.json` confirma 436 aplicados/436 verificados. El identificador usa UTC; la operación corresponde al 19 de octubre en México. Los campos de presentación de los 436 eventos se comprobaron y completaron para el historial.

## Cálculo y presentación

`product-sales.ts` es el cálculo compartido por ficha, tarjetas y ranking. Agrupa tallas y colores por ID del producto y negocio. Un SKU histórico se vincula a un ID solo cuando tiene un propietario único; un SKU compartido nunca une dos IDs explícitos. Los registros manuales se agrupan por nombre normalizado y aparecen identificados, separados de los productos vinculados al catálogo.

Se reconocen los mismos estados entregados/de cobro usados por el sistema. Las solicitudes en curso se muestran aparte; cancelaciones no suman ventas. Se descuentan devoluciones y la parte proporcional del descuento del pedido, excluyendo envío. La ganancia usa costo neto y señala costos faltantes; el ranking por ganancia excluye productos con costos incompletos. La última venta usa fecha de entrega/pago/creación, evitando que una actualización administrativa simule una venta reciente.

`ProductSalesService` usa todos los pedidos autorizados para el ranking, independientemente de la paginación y búsqueda del catálogo. El ranking respeta el negocio seleccionado; la ficha consulta siempre el negocio del producto, aunque cambie el selector global. No se amplían permisos ni reglas.

La pantalla distingue carga, caché pendiente de confirmar, error y un cero confirmado por servidor. El error permite reintentar. El producto estrella aparece primero, con comparación por unidades, venta neta o ganancia. Los cinco primeros y la explicación se consultan en desplegables.

## Resultado de referencia tras la regularización

Base Mayorista, por unidades netas: Paraguas (registro manual), 102 unidades, $11,412.50 de venta y $4,264.50 de ganancia calculada. Entre productos vinculados al catálogo: Pijama Chosen Dama, 59 unidades; New Balance Modelo 9060, 56 unidades. Este último encabeza la ganancia calculada: $8,414. Las métricas son históricas acumuladas, no una recomendación de compra ni una proyección.

Datos de respaldo del cálculo: `tmp/product-stars-report.json`. Al ser histórico manual, «Paraguas» es un grupo por nombre; no se mezcla automáticamente con otros IDs que pudieran compartir ese nombre.

## Comprobación

Pruebas de corte, exclusiones, pagos previos, idempotencia, descuentos, devoluciones, propietarios de SKU, negocio, costos pendientes y ausencia de falsos ceros. Suite completa ejecutada: 417/419 correctas; dos fallos anteriores de AppVersionService (espera 2.2.3 frente a versión actual 2.3.0). Pruebas dirigidas finales: 17/17 correctas, registradas en `tmp/product-sales-focused-tests.log`. La compilación de producción pasó en la primera comprobación; una repetición final quedó detenida y se canceló. La comprobación estricta final de Angular de ambas pantallas y sus dependencias terminó correctamente (`ngc -p tmp/tsconfig-product-sales-aot.json`, sin emisión).

Capturas de interfaz con datos simulados en [product-sales-validation](product-sales-validation/README.md); la regularización y el ranking numérico se contrastaron con lecturas reales de Firestore.
