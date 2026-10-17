# Review · refinamiento visual

La pantalla usa dos columnas desde tablet, una galería integrada por color y un panel con producto, variantes, precios y proveedor. Se reutilizan los tokens globales, Inter y el azul local de Review; los iconos SVG no requieren dependencias nuevas.

Se corrigieron la duplicación de controles de fotos, la edición dispersa de colores, la eliminación inmediata de variantes y los avisos que interrumpían la edición. El proveedor requerido muestra su error junto al selector, desplaza la vista y recibe el foco. El visor ocupa la pantalla con fondo oscuro, navegación, zoom y arrastre; Escape y los diálogos nativos restauran el foco. Las fórmulas, los contratos, los servicios, la fusión y las escrituras se conservan.

| Estado | Desktop | Móvil |
| --- | --- | --- |
| Inicial | [1440 × 900](1440-initial.png) | [390 × 844](390-initial.png) |
| Página completa | [Desktop](1440-full.png) | [Móvil](390-full.png) |
| Galería | [Desktop](1440-gallery.png) | [Móvil](390-gallery.png) |
| Variante | [Desktop](1440-variant.png) | [Móvil](390-variant.png) |
| Categoría y creación | [Desktop](1440-category.png) | [Móvil](390-category.png) |
| Proveedor requerido | [Desktop](1440-error.png) | [Móvil](390-error.png) |
| Visor | [Desktop](1440-lightbox.png) | [Móvil](390-lightbox.png) |
| Acciones | [Desktop](1440-actions.png) | [Móvil](390-actions.png) |

También hay capturas de 1024 × 768, 768 × 1024, 430 × 932 y 360 × 800, fotos adicionales, carga, vacío, guardado y contenido largo. [Mediciones de navegador](results.json): sin desbordamiento horizontal ni botones menores de 44 px; foco del proveedor, restauración de foco de ambos diálogos, zoom, arrastre y deslizamiento táctil comprobados.

Las capturas usan el componente Angular real con servicios sustituidos por datos de muestra; no se realizaron escrituras en Firestore ni una sesión autenticada de producción. La fotografía de muestra se reutiliza con distintas URLs para comprobar asociaciones. Las capturas de página completa expanden el scroll de `body` y colocan la barra al final para documentar todo el contenido; las capturas de viewport conservan su comportamiento sticky.

Validación: build de producción correcto. Suite de Review: **24/24**. Suite completa: **352/354**; los dos fallos preexistentes son de `app-version.service.spec.ts` (espera 2.2.3 y el proyecto usa 2.3.0). Se añadieron cinco pruebas de regresión para proveedor, asociaciones, eliminación de variantes, visor y notificaciones. No existe script de lint. Se mantienen las advertencias previas de presupuesto de bundle/fuente y dependencias CommonJS.

Pendiente: revisión visual del usuario y comprobación con productos reales en una sesión autenticada. Sin commit ni despliegue.
