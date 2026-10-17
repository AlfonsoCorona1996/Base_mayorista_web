# Review: validación rápida y metadatos de WhatsApp

## Alcance

`/main/review/:id` conserva la ruta, Angular standalone, el contrato `normalized_v3.0` y la generación de SKU internos. Se reorganizó como una columna de validación: información, fotos/colores, variantes, precios, mensaje original y opciones avanzadas. La barra inferior mantiene Guardar y Validar y publicar disponibles. Fusión, rechazo y datos técnicos están en opciones avanzadas; la fusión usa un diálogo nativo.

Las variantes se editan desde chips; disponibilidad, notas y asignaciones de color quedan bajo edición avanzada. Se rechazan duplicados por espacios, mayúsculas y equivalencia numérica (`6`, `06`, `6.0`). La comprobación se aplica también en el servicio de escritura y el normalizador del backend. Los documentos existentes con duplicados requieren corregirlos antes de guardar, sin eliminar sus variantes automáticamente.

La galería permite ampliar, navegar con botones/flechas, elegir portada, excluir y restaurar fotos. Los diálogos nativos contienen el foco y lo devuelven al cerrar. Se conserva el stock `unknown_qty` al cargar: anteriormente Review lo convertía en disponible. Guardar ya no reduce la lista de portadas a una sola imagen.

## Contrato y persistencia

Los campos nuevos viven dentro de `normalized_listings/{id}.listing`:

```ts
keywords?: string[];       // Ausente en documentos antiguos: []
supplierSku?: string | null; // Ausente o sin evidencia: null
extractionOverrides?: { keywords?: boolean; supplierSku?: boolean };
```

El SKU de proveedor se mantiene como texto, conservando ceros iniciales y puntuación. No participa en la generación ni en el índice `variant_skus_normalized`, ni tiene una restricción de unicidad global.

La edición manual activa una protección por campo, incluidos `[]` y `null` introducidos deliberadamente. La persistencia del backend lee y escribe en una transacción para no sobrescribir una edición concurrente de estos campos. También protege campos presentes en documentos ya revisados que todavía no tengan las marcas explícitas. El modelo no puede activar sus propias marcas de edición humana.

Guardar y publicar continúan siendo una sola escritura. Catálogo conserva `listing` completo al editar inventario/precios. La fusión une y normaliza palabras clave, conserva la referencia del destino o incorpora la del origen cuando corresponde. Se bloquea antes de escribir si hay referencias distintas, proveedores distintos con referencias, o un destino cuyo SKU fue vaciado manualmente y un origen con SKU. No se rechaza el origen ante esos conflictos.

El contrato de WhatsApp no tiene referencias de proveedor por variante. `catalog_products`, usado por importaciones Excel, sí tiene `supplier_sku` e identificadores por variante. Se mantuvo esa separación; no se añadieron referencias por variante a WhatsApp ni se transformaron los códigos importados. Si una extracción contiene referencias distintas por talla, el SKU de producto queda en `null`.

## Búsqueda, reglas e índices

- El catálogo administrativo de WhatsApp filtra en memoria sobre `normalized_listings` y completa la carga de páginas al buscar. Ahora incluye `listing.keywords` y `listing.supplierSku`, sin cambiar paginación ni listeners.
- La selección de productos en Pedidos ya utilizaba `semantic_tags`, `search_aliases` y `search_blob`; ahora incorpora ambos campos directamente. Así los cambios manuales son consultables sin depender de regenerar un blob antiguo.
- `services/customer_ai_catalog.service.js` añade ambos campos a su texto de búsqueda normalizado.
- La portada pública no ofrece un buscador; no se modificó. La búsqueda de productos importados continúa usando su contrato existente.
- La búsqueda de catálogo sigue en memoria. La reutilización de categorías del normalizador consulta la referencia exacta y filtra proveedor y negocio antes de reutilizarla; no requiere índice compuesto. No hay backfill automático.
- Las reglas actuales permiten actualizar el mapa `listing` a los roles autorizados; no contienen una lista cerrada de campos. No se ampliaron permisos. Crear o reactivar categorías sigue requiriendo administrador según `firestore.rules`.

## Categorías

Review permite buscar, navegar la jerarquía, seleccionar una sugerencia y crear con un padre explícito. `CategoriesService.ensurePath` comparte la creación con la administración normal. Las equivalencias ignoran acentos, mayúsculas y espacios; devuelven la ruta canónica. La creación usa transacción e identificador determinístico para evitar duplicados concurrentes del mismo nombre/padre. Una categoría equivalente inactiva se reactiva mediante los permisos existentes.

## Hallazgo imagen-color

Antes del cambio:

1. `raw_persist.js` unía `settled[idx]` con `images[idx]`. `Promise.allSettled` conserva el orden de entrada: no se encontró evidencia de una carrera por finalización de uploads en ese punto.
2. `normalize_worker.js` convertía las imágenes en URLs y descartaba `image_id` antes de analizar. El prompt enviaba una lista numerada de URLs y pedía URLs en la respuesta; no existía verificación de identidad estable.
3. `sanitizeNormalized` tenía un `resolvedColorCursor` compartido entre variantes. Cuando había nombres repetidos, una misma referencia podía terminar en un color diferente según el orden de recorrido de las variantes.
4. La reparación automática solo se disparaba cuando una URL estaba asociada a colores distintos. No detectaba un intercambio entre dos URLs válidas.

Ahora cada upload conserva el ID en su propia operación. Se pasa `image_id` junto a cada imagen a la IA, se resuelve la respuesta con un mapa por ID y solo se aceptan URLs conocidas. Un ID desconocido no se sustituye por la URL de otra foto. Los documentos antiguos pueden resolverse por coincidencia exacta de URL. El cursor compartido se eliminó: referencias ambiguas necesitan identidad de imagen; no se adivina por posición. `product_colors[].image_id` es aditivo y la URL se conserva para los consumidores existentes.

Esto corrige la asociación técnica. No garantiza que la interpretación visual del color sea correcta; el operador puede comprobarla y corregirla en Review.

## Modelo y prompt del backend

Fuente: `openai_responses.js`, función `runNormalizationWithOpenAI`.

- Modelo configurado: `process.env.OPENAI_MODEL || "gpt-5.2"`. No se cambió. El valor efectivo de un despliegue puede estar sobrescrito por su entorno; no se inspeccionaron credenciales ni se verificó la configuración de producción.
- Endpoint real: Chat Completions (`/v1/chat/completions`), pese al nombre del archivo.
- Formato: `response_format: { type: "json_object" }`, `max_tokens: 4000`. Es JSON mode, no Structured Outputs con esquema estricto. La distinción está documentada en [OpenAI Docs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat).
- El prompt se compone de `requiredSkeleton`, `buildCategoriesPrompt`, `imageAnalysisPrompt` y `promptText`. Lee texto impreso y tallas `#N`/`#N-M`, clasifica portadas/colores, construye variantes y título, elige una categoría activa o propone otra, y extrae el precio publicado como precio de venta (`precio_final`) junto con su moneda. Por la nueva regla comercial, el worker calcula costo = venta ÷ 2 y clienta = venta × 0.75, con redondeo monetario. La extracción y su reparación usan esta misma interpretación; los documentos existentes no se migran automáticamente.
- Las categorías del prompt se limitan por defecto a 180 entradas/8000 caracteres. El código contiene heurísticas posteriores para títulos y tallas, además de una reparación de JSON y una reparación de colores.
- Se añadió `METADATA_PROMPT` en `listing_metadata.js`: 5–10 términos justificados, permitiendo menos; SKU solo con etiqueta/referencia explícita y evidencia literal; identidad estable para las fotos. No se cambió el modelo ni se reescribió el pipeline.
- `supplierSkuEvidence` es un dato transitorio de extracción. Para imágenes exige un ID conocido y un fragmento literal con etiqueta de código; para texto se comprueba el mensaje real. Se rechazan códigos ausentes, contradictorios o sin evidencia. La lectura visual sigue dependiendo del modelo existente; no es una segunda validación OCR independiente.
- Campos que admiten desconocido: título, categoría/propuesta, proveedor, imágenes por color, notas y precios pueden contener `null`; listas pueden estar vacías; disponibilidad usa `unknown_qty`. El SKU nuevo conserva `null` cuando falta información. No existe confianza por campo.

Problemas que siguen requiriendo evaluación con mensajes reales: salida sin esquema estricto, posibles errores visuales aun con IDs correctos, heurísticas de tallas/títulos que pueden introducir suposiciones, límite de categorías/contexto y ausencia de confianza por campo. Las pruebas nuevas son determinísticas; no se hicieron llamadas de pago a OpenAI ni se enviaron mensajes de WhatsApp.

## Archivos y verificación

Frontend: `features/review/review.{ts,html,css}`, directiva local de diálogo, pruebas de Review; `core/listing-metadata.*`, contratos, servicio de persistencia, servicio/pruebas de categorías; búsqueda en `catalog.ts` y una extensión puntual de los términos de búsqueda de `pedido-detalle.ts`.

Backend: `listing_metadata.js` y sus pruebas, `normalized_persistence.js` y sus pruebas, wrapper `normalized_persist.js`, `normalize_worker.js`, `openai_responses.js`, `raw_persist.js` y `services/customer_ai_catalog.service.js`.

Se probaron 360×800, 375×667, 390×844, 430×932, 768×1024, 1024×768, 1366×768, 1440×900 y 1920×1080 en Chrome Headless con la plantilla Angular real, incluyendo contenido largo, controles táctiles, variantes desplegadas y búsqueda sin resultados. La revisión visual utiliza capturas de esa misma vista de prueba con datos ficticios. No sustituye una prueba autenticada en producción.

No hay scripts de lint configurados. El backend no tiene script de build/typecheck; se ejecutan `npm test` y comprobación sintáctica con Node. En frontend se ejecutan build de producción, TypeScript para aplicación/pruebas y Karma. La suite completa detectó dos fallos no relacionados en `app-version.service.spec.ts`: espera `2.2.3` cuando el proyecto ya usa `2.3.0`. Los archivos de listeners/performance que estaban modificados al comenzar no se tocaron.

### Resultado final de comprobaciones

- Backend: 77/77 pruebas correctas. Comprobación sintáctica de los módulos modificados sin errores.
- Frontend: 347/349 pruebas correctas; los dos fallos son las expectativas de versión descritas arriba. Las pruebas de Review, categorías y metadatos pasan.
- Capturas de la vista de prueba: [móvil](review-validation/review-390x844.png), [galería móvil](review-validation/review-390-gallery.png) y [escritorio](review-validation/review-1440x900.png). [Mediciones de los nueve tamaños](review-validation/viewport-results.json): sin desbordamiento horizontal.
- Build de producción y TypeScript de aplicación/pruebas: correctos. El build conserva advertencias por bundle inicial (817,12 kB frente a 800 kB), CSS de fuente y dependencias CommonJS.


## Revisión de UX y clasificación — octubre 2026

Punto de retorno anterior al cambio: commit `398f118`. Los archivos de Pedidos, rendimiento y configuración que ya estaban modificados quedaron fuera de ese commit y de este rediseño.

### Decisiones visuales

Se conserva la composición de dos columnas en tablet/escritorio y una columna en móvil. El título general precede a las fotos, y el nombre del color precede a su imagen. Producto mantiene nombre, código etiqueta y palabras clave en ese orden. La ayuda del código se consulta con un desplegable; las características extraídas también pueden revisarse y corregirse en un desplegable. Categoría ahora es una sección de decisión visible, independiente del buscador. Precios muestra primero venta y después costo; clienta conserva su cálculo del 75%.

Acciones en infinitivo, un primario por sección como máximo, secundarias con borde y ghost para apoyo. La barra inferior explica qué falta para publicar y reduce texto redundante. La confirmación usa texto además de color. El foco pasa a «Cambiar categoría» después de confirmar por teclado.

### Estado y persistencia

- `listing.categoryReview`: `{status: 'pending' | 'confirmed', path, confirmedBy?, confirmedAt?}`. La confirmación es válida solo para esa ruta; una ruta distinta o una propuesta pendiente la invalida. Documentos anteriores sin marca requieren confirmación al volver a publicar.
- Categoría existente: confirmar o cambiar directamente. Nueva: «Crear categoría y aceptar» o «Descartar propuesta», sin abrir submenús. Crear sí escribe la categoría en Firebase en ese momento (con los permisos existentes); el producto y su confirmación se guardan con Guardar/Publicar. Descartar solo modifica el borrador.
- Publicar verifica categoría tanto en Review como en `NormalizedListingsService`. Guardar borrador sigue permitido mientras haya pendientes. No se cambiaron permisos ni se desplegaron reglas nuevas.
- `listing.attributes`: tipo, público, marca, material, estampado, patrón, textura, corte y detalle, con fuente y evidencia cuando provienen de extracción. Se pueden corregir o vaciar manualmente. Esas correcciones no regeneran automáticamente el título ni sustituyen palabras clave ya revisadas.
- `extractionOverrides` protege también título, atributos, categoría y colores. El backend descarta supuestas confirmaciones generadas por el modelo y conserva decisiones humanas leyendo la versión actual dentro de la transacción.
- `product_colors[].review_required` señala asociación dudosa, identidad desconocida o discrepancia de URL/ID. La UI también señala colores sin foto y fotos compartidas. `listing.colorReview` confirma el conjunto de nombres/fotos mediante una firma; editar el conjunto invalida esa confirmación. Un color sin foto puede ser legítimo y se puede confirmar expresamente.

### Extracción y categoría en backend

`category_routing.js` normaliza equivalencias acotadas (pantalón/pantalones, caballero/hombre, jeans/mezclilla). Solo resuelve por reglas cuando la información respalda una ruta sin hojas competidoras. No inventa tejido ni público. Ordena candidatas por relevancia; si no hay coincidencias amplía al catálogo. La coincidencia final y las propuestas se contrastan con todo el catálogo activo.

Cuando hay proveedor conocido y código explícito, se puede reutilizar una ruta de productos publicados y confirmados del mismo proveedor, negocio y código. Referencias conflictivas o categorías inactivas no se reutilizan. Una consulta truncada tampoco se usa para decidir. Muchos mensajes nuevos no tienen aún proveedor asignado: en ese caso se omite esta reutilización.

La clasificación comparte la llamada que extrae imágenes, variantes y precios. Resolver la categoría por reglas reduce contexto de categorías; no significa que la normalización completa deje de necesitar IA. No se añadió una llamada exclusiva para categoría. Se mantiene el límite existente de contexto y las reparaciones existentes.

`product_attributes.js` valida fuentes, IDs, extractos de texto, negaciones y tipos antes de construir título y palabras clave. Los sinónimos se limitan a equivalencias comerciales explícitas. La evidencia visual procede de la lectura del modelo: validar su estructura no demuestra que el modelo haya visto correctamente la imagen. No se infiere composición o marca por el aspecto.

Los IDs estables evitan depender del orden de fotos. Las pruebas cubren inversión, referencias desconocidas y fotos compartidas. Sigue pendiente evaluar exactitud perceptual con fotografías reales; esto no garantiza detectar una predicción incorrecta que use un ID válido.

### Medir modelos antes de cambiar

Sigue el modelo configurado por `OPENAI_MODEL` (valor por defecto local `gpt-5.2`). Cada respuesta registra `normalization_ai_usage`, ID de publicación, fase, modelo devuelto, intentos, duración y uso de tokens. Sumar extracción y reparaciones para comparar el costo completo. Las llamadas fallidas sin uso reportado no permiten calcular un costo exacto.

Herramienta offline en backend: `node normalization_evaluation.js reviewed-runs.json`. Requiere los mismos IDs de casos para cada modelo y rechaza duplicados. Cada fila contiene `id`, `model`, `expected: {category, colors: {image_id: nombre}}`, `actual` con la misma forma, `duration_ms`, `calls: [{prompt_tokens, completion_tokens}]`, y opcionalmente `human_correction_required` y `cost_usd`. Devuelve exactitud de categoría/asociaciones de color, proporción de correcciones humanas, tokens, mediana de latencia y costo reportado. Costos no aportados quedan en null; no inventa tarifas ni una estimación.

Para la comparación real: muestra revisada de casos claros, ambiguos, sin texto, varias fotos, referencias repetidas y fallos conocidos de color; misma muestra y misma configuración para ambos modelos. Revisar títulos, atributos inventados y tiempo humano de corrección, además de la precisión automática. No se ejecutó una comparación pagada ni se eligió un sustituto sin esos resultados.

### Validación de esta iteración

Capturas y medidas en `docs/review-validation/ux-pass/`. Se prueba la plantilla real de Angular con servicios simulados; no son operaciones en Firebase de producción. El checkbox tiene un glifo menor de 44 px dentro de una etiqueta táctil de al menos 44 px.

### Ajustes de detalle y modal de colores

La portada lleva una insignia azul con check y un borde persistente en su miniatura. La fila de la foto que se está viendo usa un fondo suave y «En vista»: ambos estados se distinguen sin leer todas las notas. La ayuda de código etiqueta se presenta con sangría, fondo suave y borde lateral, agrupada con su desplegable.

«Añadir color» pide el nombre dentro del modal, permite seleccionar una foto existente o subir otra, y confirma la creación con una sola acción primaria. Se eliminaron los prompts del navegador de este flujo. Seleccionar una foto no crea un color ni cambia la portada; cancelar tampoco crea el color. Una foto ya subida permanece disponible en la galería. Los nombres vacíos o duplicados no se aceptan. La modalidad sin foto conserva la misma estructura.

Las tarjetas muestran el nombre antes de la imagen y mantienen áreas de imagen iguales. La selección se indica con borde y check; «Portada actual» solo aparece al elegir portada. El cuerpo del selector es la única zona desplazable: encabezado y acciones permanecen visibles sin cubrir fotos. Subida, error y ausencia de imágenes tienen estados explícitos. Escape cierra los diálogos cuando no hay una operación en curso; se corrigió el retorno `false` involuntario del manejador Angular que impedía ese cierre.

La auditoría de `ux-overlays/` abrió 31 estados de modales y submenús en los cinco tamaños exigidos (155 capturas), incluyendo selectores anidados, variantes, categorías, ayuda, menús de fotos, fusión y visor. No se detectaron desbordamientos horizontales, controles visibles tapados ni objetivos táctiles inferiores a 44 px en las regiones medidas. Son pruebas locales con servicios simulados, no una validación de Firebase/Storage de producción.

Pruebas dirigidas: 43/43 correctas (Review, metadatos y categorías). Suite completa ejecutada: 359/361; las dos fallas existentes de `app-version.service.spec.ts` esperan 2.2.3 aunque el proyecto declara 2.3.0. Backend: 92/92. No hay script de lint. La compilación final de producción terminó correctamente; conserva advertencias de tamaño y dependencias CommonJS. También se verificó el espacio CSS equivalente a zoom de 200%, con confirmación por teclado y foco restaurado.
