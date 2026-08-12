# Flujo profesional de interfaces

Este proyecto usa un ciclo corto `Storybook → Angular` para reducir retrabajo y mantener una sola implementación real. Figma es opcional cuando el alcance requiere explorar un flujo completo antes de escribir componentes.

## Responsabilidad de cada herramienta

- **Storybook (UI Lab)** es la fuente de verdad visual: renderiza los componentes Angular reales de forma aislada, con sus estados de carga, error, vacío, deshabilitado y tamaños objetivo.
- **La aplicación Angular** compone esos componentes y conserva la lógica de negocio, servicios y persistencia en sus contenedores de feature.
- **Figma (opcional)** se reserva para flujos nuevos, arquitectura de información o composiciones grandes cuya intención todavía no pueda evaluarse con un componente real.

Storybook no contiene copias estáticas de la interfaz. El componente que se aprueba en el UI Lab es el mismo que consume la pantalla real.

## Flujo por cambio

1. Documentar el problema con captura, viewport, estado y resultado esperado.
2. Crear o ajustar un componente presentacional pequeño, estricto y accesible.
3. Añadir historias para los estados relevantes y los viewports de 390, 360 y tablet cuando corresponda.
4. Revisar en Storybook jerarquía, contenido largo, teclado, contraste y criterios de aceptación.
5. Integrar el componente aprobado en la feature sin mover reglas de negocio al componente visual.
6. Ejecutar pruebas, `npm run build-storybook`, `npm run build` y `npm run version:check`.
7. Registrar el cambio en `CHANGELOG.md` con la versión SemVer que corresponda.

Cuando el problema abarque una pantalla o flujo todavía indefinido, puede añadirse una exploración opcional en Figma antes del paso 2.

## Piloto: Pedido detalle

- Componente real: `ClientaDiscountPanelComponent`
- Historia: `Pedidos/Clienta discount panel`
- Integración: alta/edición de producto y descuento rápido de artículos del pedido.
- Prototipo siguiente: `Pedidos/Agregar producto/Experiencia completa`, con selección verificable y opciones provisionales de talla/color.

## Comandos

```bash
npm run storybook
npm run build-storybook
```

El servidor local abre el UI Lab en `http://localhost:6006`. El build estático se genera en `storybook-static/` y no se despliega junto con la aplicación salvo que se configure explícitamente.

## Versionado

- **PATCH**: correcciones visuales, accesibilidad, responsive o refactors sin nueva capacidad pública.
- **MINOR**: nueva capacidad visible y compatible hacia atrás.
- **MAJOR**: cambios incompatibles de contrato o flujo.

La infraestructura de Storybook por sí sola no obliga a subir una versión pública; se registra dentro de la versión del cambio de producto que acompaña.
