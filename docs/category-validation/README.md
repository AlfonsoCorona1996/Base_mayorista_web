# Corrección de categorías del bot y Review

Fecha: 2026-10-20.

## Problema y alcance

El mensaje «Conjunto niño … Conjunto felpa» podía terminar en `Ropa > Mujer > Conjunto`. El enrutamiento anterior no distinguía edades, no equiparaba conjunto/conjuntos ni niño/niños y no contrastaba la categoría con los atributos extraídos al terminar la normalización.

La consulta de diagnóstico fue de solo lectura. El producto del incidente ya tenía una corrección manual confirmada; se conservó. No se modificaron productos ni categorías en Firebase durante las pruebas.

## Backend

En el repositorio `Base_Mayorista`:

- `category_routing.js` reconoce variantes singular/plural, distingue adulto/infantil/bebé y excluye ramas incompatibles cuando la evidencia es inequívoca. `Niños` se trata como la rama infantil general del catálogo existente, también válida para niñas.
- Un conjunto se clasifica como conjunto aunque describa playera o chamarra entre sus piezas.
- `openai_responses.js` vuelve a contrastar la categoría después de obtener los atributos. Una referencia previamente confirmada del proveedor tampoco puede imponerse a evidencia de público contradictoria.
- Si falta la categoría específica, puede proponerla bajo una rama existente y compatible. La propuesta requiere aceptación humana; el normalizador no crea categorías.
- Un error al cargar la taxonomía deja de sustituirla por una lista parcial sesgada hacia ropa de mujer.

No se cambió el modelo ni se añadieron llamadas de IA. Estas reglas cubren los casos de regresión comprobados; no constituyen una evaluación general de precisión del modelo.

## Interfaz

- Navegación por niveles, con ruta visible y orden alfabético en español dentro de cada rama.
- Búsqueda por varias palabras, sin depender del orden ni de los acentos; resultados con nombre y ubicación. Los resultados adicionales se muestran con «Mostrar más categorías».
- Creación con ubicaciones agrupadas y ordenadas. Al explorar una rama, se propone esa ubicación y se muestra la ruta antes de crear.
- Estados de carga, error con reintento, catálogo vacío y búsqueda sin resultados. Se eliminó el catálogo ficticio de respaldo.
- Navegación con teclado, devolución del foco y cierre con Escape, incluso cuando todavía no hay categoría seleccionada.

## Validación

- Backend: 115 pruebas correctas, incluyendo ocho regresiones de clasificación.
- Frontend focalizado: 44 pruebas correctas de categorías y Review.
- Suite general: 437 correctas y dos fallos ajenos a categorías en `AppVersionService`: esperan `/version.json?v=2.2.3`, mientras el proyecto solicita `2.3.0`.
- Build de producción correcto. Conserva avisos de presupuesto del bundle inicial y de la fuente Material Symbols, además de dependencias CommonJS.
- No hay un script de lint configurado.
- Auditoría visual del componente Angular real con las 106 categorías consultadas y una categoría ficticia de nombre largo. Persistencia y autenticación simuladas: ninguna prueba visual escribió en Firebase.
- 78 combinaciones de estado y viewport, sin errores de navegador, desbordamientos horizontales ni controles por debajo del tamaño táctil verificado. Se comprobó además que el botón de creación se puede alcanzar y pulsar sin quedar oculto por la barra inferior.
- Tamaños: 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844, 360 × 800 y 720 × 450.

`results.json` contiene las medidas. Las capturas incluyen navegación, nombres largos, creación, búsqueda, múltiples resultados, vacío, carga, error y edición de propuesta. Las capturas `*-create-action-visible.png` muestran el botón de creación dentro de la pantalla tras desplazarse.

Ejemplos:

- [Niveles principales, escritorio](1440-roots.png)
- [Búsqueda, tablet](1024-search.png)
- [Creación, móvil](360-create-action-visible.png)
- [Propuesta editable, móvil](390-proposal-edit.png)

Los cambios están preparados en los repositorios locales. Para que los use WhatsApp debe desplegarse el backend; esta validación no realiza un despliegue.
