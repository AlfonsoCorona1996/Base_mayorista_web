# Changelog

Todos los cambios relevantes del frontend se documentan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[Versionado Semántico](https://semver.org/lang/es/).

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
