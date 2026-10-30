# Costo editable en artículos del pedido

El modal de añadir y editar productos permite cambiar el costo unitario para catálogo, inventario y captura manual. El cambio corresponde al artículo del pedido: no actualiza los precios del catálogo ni el costo de inventario. La utilidad se calcula con el costo guardado.

La escritura usa los endpoints de artículos existentes. `price_cost_override: true` indica una edición explícita del campo; el backend consume esa marca sin persistirla. Para catálogo v2, sin esa intención se conserva el costo autoritativo o el costo previamente guardado.

El backend valida el costo positivo, registra `price_cost_override_from`, `price_cost_override_to`, `price_cost_override_by` y `price_cost_override_at`, y calcula nuevamente los totales. Usa los permisos de edición de artículos existentes. Si aumentar el costo deja una venta por debajo del costo, se mantienen el permiso, motivo y confirmación requeridos; un costo mayor requiere una nueva autorización aunque la pérdida anterior ya estuviera autorizada.

No se agregan dependencias, listeners ni consultas de productos. El formulario valida vacío, cero, negativos y entradas no numéricas. Productos con costos diferentes conservan líneas separadas mediante la comparación existente de artículos.

## Validación

- Build de producción correcto, con avisos de presupuestos y dependencias CommonJS.
- Frontend: 493 pruebas correctas de 495. Las dos fallidas corresponden a `AppVersionService`: esperan `/version.json?v=2.2.3`, mientras el proyecto está en `2.3.0`.
- Backend: 137 pruebas correctas de 137, incluyendo cinco regresiones sobre costos, auditoría, utilidad y autorización.
- Modal real con servicios simulados en Chromium y WebKit, en 1440×900, 1024×768, 768×1024, 390×844 y 360×800: campo editable, validación del error, guardado, nombres largos y ausencia de desbordamientos. Controles de 46 px y fuente de 16 px en móvil.
- Sin script de lint configurado. Diff revisado; se conservaron los cambios ajenos de la encuesta de aniversario.
- Evidencia y arnés local en `tmp/order-cost-edit/` (no versionado).

## Publicación

El backend requiere publicar los cambios de `order_items_pricing.js` del repositorio hermano `Base Mayorista Backend/Base_Mayorista`, antes de activar el frontend. La API anterior rechaza cambios del costo de líneas de catálogo v2. No se desplegó ni se modificaron pedidos reales durante esta tarea.
