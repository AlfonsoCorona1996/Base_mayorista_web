# Changelog

Todos los cambios relevantes del frontend se documentan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[Versionado Semántico](https://semver.org/lang/es/).

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
