# Ficha de catálogo — octubre de 2026

La ruta `/main/catalogo/:id` adopta la composición, paleta, tipografía, botones y jerarquía de Review. El título real del producto da contexto antes de las fotos. La portada se reconoce por una insignia con check; la selección de una foto es un estado distinto y no cambia la portada.

## Organización

- Galería principal con miniaturas, colores y visor ampliable. El visor admite flechas del teclado, navegación entre fotos y Escape.
- Información del producto: nombre al editar, código etiqueta y su ayuda desplegable, palabras clave, categoría y proveedor. Código etiqueta se distingue del SKU interno de cada variante.
- Precios: venta, costo y clienta. Las métricas auxiliares se consultan en un desplegable. Se respeta el alcance existente de Manuales Catálogo, que solo muestra costo y clienta.
- Variantes desplegables con disponibilidad, precios y colores. SKU interno y notas se agrupan en otro desplegable. Las acciones masivas de disponibilidad están junto a las variantes.
- Inventario propio separado de disponibilidad con proveedor. Venta neta y ganancia permanecen visibles; el resto de métricas se despliega cuando se necesita.
- Editor de fotos y colores en un diálogo nativo: solo se desplaza el cuerpo; título y acciones permanecen accesibles. Los enlaces de imágenes se consultan o editan dentro del editor, fuera de la ficha de consulta.
- «Guardar cambios» es la acción primaria de la ficha. Las acciones destructivas usan texto rojo y menor peso visual. Cerrar el editor devuelve el foco al control que lo abrió.

## Alcance

Cambios de presentación y navegación de la interfaz. Se reutilizan `ReviewIcon`, `ReviewDialogDirective`, tokens globales y los métodos existentes del catálogo. Se conservan persistencia, estados de proveedor, sincronización de disponibilidad por color, precios introducidos manualmente, cálculo de métricas y feature flags.

El código etiqueta y las palabras clave existentes se muestran sin añadir un contrato nuevo de edición. La edición de imágenes conserva el mecanismo por enlace que ya tenía esta pantalla. Crear categorías, analizar imágenes o recalcular precios no forma parte de este rediseño.

Las columnas responden al ancho del componente mediante una consulta de contenedor: abrir el menú lateral no comprime la ficha en dos columnas cuando falta espacio. En móvil el botón de edición ocupa su propia fila, dejando al título todo el ancho disponible.

## Verificación

La URL solicitada responde en localhost, pero el navegador de pruebas es redirigido al inicio de sesión. La inspección funcional y visual usa el componente Angular real con servicios simulados y fotografías de prueba; no verifica los datos concretos de ese producto ni escribe en Firebase/Storage.

- Cinco tamaños: 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844 y 360 × 800.
- Galería, selección, visor/zoom, todos los desplegables, edición, editor de fotos y colores, contenido largo, vacío, carga y error.
- Comprobaciones adicionales con espacio reservado para el menú lateral y espacio CSS equivalente a zoom de 200%.
- 97 estados visuales medidos: sin desbordamientos horizontales, controles visibles tapados en los modales ni objetivos táctiles menores de 44 px.
- Pruebas de regresión: explorar fotos no altera la portada ni guarda; editar costo conserva venta/clienta; la disponibilidad conserva la relación variante-colores; se respetan precios por negocio y el feature flag de inventario.
- Suite completa: 406/408 correctas. Los dos fallos anteriores de `AppVersionService` esperan `2.2.3` aunque el proyecto declara `2.3.0`. Las cuatro pruebas nuevas pasan.
- Compilación final de producción correcta; conserva las advertencias existentes de tamaño y dependencias CommonJS.
- No existe script de lint. `git diff --check` sin errores.

Capturas y medidas: [validación visual](catalog-validation/README.md).
