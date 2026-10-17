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
- No se añaden consultas `where` ni índices compuestos para estos campos. No hace falta backfill para que los documentos antiguos funcionen.
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
