# Changelog

Todos los cambios relevantes del frontend se documentan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[Versionado Semántico](https://semver.org/lang/es/).

## [2.5.0] - 2026-11-19

### Añadido

- Pedidos: promoción masiva desde el menú general de productos, con porcentajes 30/35/40 o personalizado, selección por descuento actual del 25 %, todos los elegibles o productos específicos, vista previa por pieza y total del pedido.
- Guardado con estado visible, resumen del resultado y deshacer durante la sesión que recupera los precios anteriores sin sobrescribir cambios posteriores de precio. Los artículos sin precio público válido, cancelados, con devoluciones o cuyo precio quedaría debajo del costo se excluyen con su motivo.

Solo frontend; reutiliza la actualización de artículos existente, sin cambios de API ni reglas de Firestore.

## [2.4.3] - 2026-11-19

Solo frontend; compatible con backend 2.3.1 y 2.3.2 y con las reglas publicadas para 2.4.0.

### Corregido

- Validación: en un producto recién extraído, todas las tallas vuelven a llevar todos los colores del producto (como en 2.3.0). En 2.4.1, si la IA repartía los colores de las fotos entre las tallas, se activaba sola la opción «Las variantes usan colores distintos» y se guardaba un color por talla. Ahora esa opción solo se activa sola en productos que una persona ya guardó con colores por talla.

## [2.4.2] - 2026-11-18

Solo frontend; compatible con backend 2.3.1 y con las reglas publicadas para 2.4.0.

### Corregido

- Detalle del pedido: ya no aparece «No se pudo cargar: responsables». La lista de sugerencias de «Asignar a» se leía de la colección `admins`, que está vacía y no tiene reglas, por lo que Firestore siempre la negaba. Ahora sugiere los responsables ya usados en las incidencias del pedido y a la persona en sesión, sin consultas adicionales.

## [2.4.1] - 2026-11-18

Solo frontend; compatible con backend 2.3.1 y con las reglas publicadas para 2.4.0.

### Corregido

- Revisión de catálogo: si el mensaje original no se puede cargar, la pantalla sigue permitiendo revisar y guardar el producto, avisa del problema y ofrece «Reintentar mensaje original».
- Revisión de catálogo: cuando las tallas no traen precios contradictorios (por ejemplo, el precio solo viene en una), se aplica el precio compartido a todas.
- Revisión de catálogo: al guardar se sincronizan los colores globales con las variantes, y al abrir otro producto se limpian el texto, las imágenes y los precios del anterior.

## [2.4.0] - 2026-11-17

Consolida FIX 03A-2, 03B-1 y 03B-1.1. **Requiere publicar `firestore.rules` antes que
este frontend**; ver [docs/releases/2.4.0.md](docs/releases/2.4.0.md). Sin migraciones: los
documentos anteriores se leen con compatibilidad.

### Añadido

- Pedidos: las acciones masivas (notas, bitácoras y embarques) muestran progreso y resultado por pedido, y permiten volver a seleccionar los que fallaron (integrado a `main` durante la ventana de 2.4.0).

- Asignaciones de inventario (`inventory_allocations`): cada línea de pedido queda ligada al documento de inventario donde tiene piezas apartadas, entregadas, devueltas o liberadas.
- Estado del ajuste de inventario de una entrega en el pedido (`inventory_sync`): pendiente, fallido, comprobado o resuelto manualmente, con reintento desde el detalle y aviso «Inventario pendiente» en la lista.
- Devoluciones sin inventario comprobado: se registran sin crear existencias y se resuelven tras un conteo físico desde Inventario.
- Arnés versionado para probar las reglas reales en el emulador y la compatibilidad entre el cliente publicado y unas reglas nuevas (`scripts/emulator/`).

### Cambiado

- Entregar y liberar solo afectan lo apartado por la línea del pedido; ya no pueden tomar piezas apartadas para otro pedido del mismo producto.
- Recibir mercancía de proveedor y apartarla para su pedido ocurre en una sola transacción.
- La entrega se registra sobre el pedido vivo: si otra sesión ya lo entregó no se reescriben fecha ni historial.
- Un pedido no se cierra mientras el inventario de su entrega esté pendiente o con error.
- Las fechas operativas de cobros, gastos, retiros y devoluciones usan la hora de la Ciudad de México.
- Al guardar artículos se envía la lista que la persona tenía a la vista para que el backend 2.3.1 rechace cambios sobre una versión anterior en lugar de perder artículos.
- Reglas de Firestore con menor costo por solicitud; mismas capacidades por rol salvo las correcciones de abajo.

### Corregido

- Con las reglas reales y los permisos predeterminados de cada rol, recibir mercancía de proveedor solo funcionaba para super administrador, los repartidores no podían registrar entregas y nadie podía registrar devoluciones.
- La entrega de mercancía de proveedor dejaba las piezas apartadas en inventario para los roles que no podían consultar las líneas del pedido.
- Conciliación: registrarla, confirmar dinero recibido o marcar diferencia exige el permiso de conciliación por cualquier ruta (antes, permisos de administración, cobro o embarque cambiaban el pedido y luego se negaba su evento). El cambio, su evento y el evento de cobro que lo origina se guardan en una sola transacción; una negación o un fallo no deja nada a medias y la pantalla solo se actualiza tras confirmar. Confirmar dos veces el mismo cobro lo registra una sola vez.
- Cobros de Durango: solo un cobro reportado se confirma, rechaza o pasa a diferencia. «Diferencia» sobre un cobro ya confirmado se registra en la conciliación del pedido sin tocar el cobro ni su ingreso (antes el cobro dejaba de contarse como cobrado mientras el dinero seguía en la cuenta), y ya no se puede rechazar ni volver a confirmar un cobro procesado por otra sesión.
- Las devoluciones de piezas dañadas o sin comprobar ya no cuentan como capital recuperado.
- El spec de versión dejó de depender de un número de versión fijo.


### Añadido

- Reporte para socios por mes, rango de fechas o historial completo, con consulta en pantalla, vista previa y descarga PDF y CSV.
- Trazabilidad por pedido y producto de ventas, costos, cobros, utilidad, devoluciones y estimaciones; gastos y retiros identificados por referencia.
- Auditoría reproducible del historial y normalización de fechas históricas de pago con respaldo, procedencia y verificación de integridad.

### Cambiado

- Rediseño de Utilidades y socios con ventas atribuidas al mes de creación, cobranza informada por separado y participación acumulada menos retiros de cada socio.
- Los pedidos incompletos permanecen visibles, los costos faltantes se estiman con precio público / 2 cuando es posible y los registros sin fecha conservan un anexo separado en el PDF.
- Los reportes distinguen actividad del periodo, cobranza acumulada a la emisión y saldos históricos de socios, sin limitar la exportación por búsqueda o paginación.

## [2.2.1] - 2026-08-12

### Cambiado

- El catálogo solicita métricas únicamente para el proveedor visible y deja de conservar una segunda copia completa de las filas normalizadas del preview.

### Corregido

- El avance de una importación permanece en 99% mientras se finaliza y activa la nueva generación.
- La fase final muestra “Finalizando y activando el catálogo” en lugar de aparentar que la publicación ya terminó.

## [2.2.0] - 2026-08-11

### Añadido

- Selección agrupada de catálogo: la búsqueda muestra un resultado por producto y talla/color se eligen dentro del card.
- Opción provisional exclusiva del pedido para capturar una talla o color faltante, reutilizar cualquier imagen del producto o subir una nueva.
- Galería filtrable e imágenes ampliables desde el producto seleccionado, las sugerencias y la biblioteca completa.
- Estados visibles de guardado, error recuperable y captura continua al añadir varios productos.

### Cambiado

- El formulario de producto enfoca automáticamente la búsqueda y utiliza controles táctiles para cantidad.
- El descuento de precio clienta se abre como diálogo bloqueante sin desplazar ni recortar el formulario.
- La distribución de cantidad y precios responde sin desbordamiento desde 360 px hasta escritorio.

### Corregido

- Una opción provisional sin confirmar bloquea “Añadir al pedido” y no puede mezclarse con una línea oficial existente.
- Inventario y captura manual ya no ofrecen por error el alta provisional de talla o color.
- Las imágenes nuevas validan formato y tamaño antes de subirse y conservan correctamente el último borrador confirmado.

## [2.1.1] - 2026-08-10

### Añadido

- UI Lab con Storybook para validar componentes Angular reales, estados accesibles y viewports móviles antes de integrarlos.
- Flujo de trabajo Storybook-first para aprobar componentes reales; Figma queda como exploración opcional para flujos grandes.

### Cambiado

- El panel de precio clienta ahora es un componente presentacional reutilizado por edición de producto y descuento rápido.

### Corregido

- Los controles nativos conservan fondo y texto legibles en iOS cuando el dispositivo usa modo oscuro.
- El selector `BM / Catálogo / Ambos` ya no se superpone al título ni al contenido en móvil.
- El modal de producto mantiene encabezado y acciones visibles, con scroll limitado al formulario.
- El descuento de precio clienta ocupa espacio dentro del formulario móvil y utiliza controles táctiles accesibles.
- El panel de descuento explica cuándo falta el precio base en lugar de mostrar sólo una acción deshabilitada.
- La nota para altas fuera de flujo incluye etiqueta asociada, ayuda, contador y validación previa al envío.

## [2.1.0] - 2026-08-10

### Añadido

- Seguimiento global, cancelación y recuperación visible de importaciones de catálogo.
- Identificación visible de las versiones desplegadas de frontend y backend.
- Metadatos públicos de build en `version.json` con versión, commit y fecha.

### Cambiado

- La validación de Excel continúa en segundo plano y requiere confirmación explícita antes de aplicar cambios.
- Las mutaciones individuales de pedidos envían únicamente el artículo modificado.
- Firebase reutiliza tokens vigentes en lugar de renovarlos antes de cada escritura.

### Corregido

- Guardar y publicar un producto ahora es una sola operación atómica con bloqueo de doble clic y progreso visible.
- La interfaz detecta importaciones sin avance y evita crear duplicados activos.

## [2.0.1] - 2026-08-04

### Corregido

- Ajustes de estabilidad en pedidos, clientas, reintentos HTTP e índices de Firestore.
