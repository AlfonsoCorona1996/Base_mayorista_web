# Guía de UI y UX

## Propósito

Esta guía es el punto de partida para cambios de interfaz en este repositorio. Se aplica junto con la arquitectura y los patrones existentes: no autoriza rediseños globales, cambios de lógica ni migraciones masivas. Si una regla general entra en conflicto con una necesidad real del contenido, documenta la decisión y elige la solución que conserve legibilidad, accesibilidad y funcionalidad.

## Estado actual del proyecto

- Aplicación Angular 20 standalone, con detección de cambios zoneless y TypeScript/plantillas en modo estricto.
- El proyecto usa CSS, no SCSS. `src/styles.css` es la hoja global declarada para build y tests en `angular.json`.
- Los tokens globales viven en `:root` dentro de `src/styles.css`. Allí se conservan los colores globales existentes y se agregan los tokens `--ui-*` de estructura y dimensiones.
- Varias features mantienen paletas, radios y tipografías encapsuladas en su propio `:host`. No las reemplaces globalmente sin una tarea explícita de consolidación.
- La tipografía global es Inter. Algunas experiencias usan una pila tipográfica propia dentro de su feature. Los iconos existentes son Material Symbols Rounded, cargados desde `src/index.html`.
- Los componentes compartidos actuales están en `src/app/shared/`: el escáner de código de barras y el registro de actividad. No existe todavía una biblioteca global de botones, inputs, cards o modales; esos patrones están definidos en las hojas de cada feature. Reutiliza primero el patrón de la feature y extrae un componente compartido solo cuando haya una API y reutilización reales.
- Los breakpoints históricos varían por feature. Para trabajo nuevo usa los rangos de esta guía, pero conserva un breakpoint existente cuando responda al punto donde ese contenido deja de funcionar. No hagas una migración masiva como parte de una tarea visual local.

## Flujo para una tarea de interfaz

1. Lee esta guía y delimita si la tarea es visual, funcional o ambas.
2. Revisa el componente, su CSS y los patrones equivalentes dentro de la misma feature y en `src/app/shared/`.
3. Reutiliza tokens `--ui-*`, variables locales, componentes e iconos existentes. No agregues dependencias para resolver estilos salvo autorización explícita.
4. Implementa mobile-first y deja que el contenido determine ajustes adicionales.
5. Comprueba estados, contenido largo, teclado y todos los viewports mínimos.
6. Ejecuta los scripts disponibles, revisa el diff y elimina cambios ajenos al alcance.

## Breakpoints y responsive

Rangos de referencia:

| Rango | Ancho |
| --- | ---: |
| Móvil pequeño | menos de 480 px |
| Móvil | 480 a 767 px |
| Tablet | 768 a 1023 px |
| Escritorio | 1024 a 1439 px |
| Escritorio grande | 1440 px o más |

Escribe primero la disposición móvil y agrega `min-width` cuando aporte claridad. Los rangos no sustituyen la prueba con contenido: introduce o ajusta un breakpoint donde la interfaz realmente deje de funcionar, aunque no coincida exactamente con un límite de dispositivo. Documenta los breakpoints excepcionales.

No resuelvas responsive ocultando información esencial. Reorganiza por prioridad, permite wrapping y cambia el patrón de presentación cuando sea necesario. El documento y cada región deben permanecer sin overflow horizontal accidental.

## Contenedores

- Ancho máximo general: `var(--ui-content-max-width)`, 1440 px.
- Padding móvil habitual: `var(--ui-page-padding-mobile)`, 16 px.
- Padding móvil mínimo excepcional: `var(--ui-page-padding-min)`, 12 px.
- Padding tablet: `var(--ui-page-padding-tablet)`, 24 px.
- Padding escritorio: entre 24 y 32 px; el token adaptable `--ui-page-padding-inline` usa 32 px por defecto desde 1024 px.
- Centra los contenedores limitados y usa `min-width: 0` en hijos de flex/grid cuando el contenido pueda forzar desbordamiento.
- Respeta `env(safe-area-inset-*)` en controles o barras pegadas a los bordes de la pantalla.

## Espaciado

Usa preferentemente la escala global de 4, 8, 12, 16, 24, 32 y 48 px mediante `--ui-space-4` a `--ui-space-48`. Elige el menor valor que conserve agrupación y legibilidad. Evita valores aislados salvo que una restricción técnica o una alineación óptica comprobable lo exija.

## Botones y controles

- Toda acción táctil debe ofrecer un área mínima de `var(--ui-touch-target-min)`: 44 x 44 px. El icono puede ser menor; su área interactiva no.
- Un botón habitual de escritorio debe medir al menos 40 o 44 px de alto. Usa `--ui-control-height-compact` o `--ui-control-height`.
- Una acción principal móvil debe medir preferentemente 48 px de alto: `--ui-control-height-comfortable`.
- Inputs móviles: mínimo 44 px y preferentemente 48 px de alto, con fuente mínima de 16 px para evitar zoom involuntario.
- Los botones con texto deben crecer con su contenido. No uses un ancho fijo que corte etiquetas; permite wrapping razonable cuando la traducción o el texto largo lo necesiten.
- Incluye estados hover cuando exista puntero, focus-visible, active, loading y disabled. No comuniques el estado solo con color.
- Usa `<button>` para acciones y enlaces para navegación. Todo botón dentro de formularios debe declarar su `type`.

## Cards

- Usa altura automática. No fijes alturas para igualar cards con contenido variable.
- Padding compacto: 12 a 16 px. Padding normal: 16 a 24 px.
- Ancho mínimo orientativo en grids: `var(--ui-card-min-width)`, 280 px. En móvil ocupan el ancho disponible sin provocar overflow.
- Prefiere `grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--ui-card-min-width)), 1fr))` cuando el patrón sea compatible.
- Evita espacio vacío añadido solo para agrandar una card y evita cards dentro de cards sin jerarquía real.
- Protege títulos, identificadores y acciones ante nombres largos; usa wrapping y reserva truncado para contenido que también pueda consultarse completo.

## Formularios

- Formulario corto: máximo aproximado entre 440 y 560 px (`--ui-form-max-width-compact` y `--ui-form-max-width-short`).
- Formulario mediano: máximo aproximado de 720 px (`--ui-form-max-width-medium`).
- Usa como máximo dos campos por fila en escritorio. En móvil, normalmente una sola columna.
- Los labels deben permanecer visibles y asociados al control. No dependas únicamente del placeholder.
- Muestra ayuda y errores cerca del campo correspondiente y relaciona mensajes con `aria-describedby` cuando aplique.
- Conserva valores, unidades, prefijos, sufijos y mensajes largos sin solapamiento. El orden de foco debe coincidir con el orden visual.
- En loading o disabled, evita dobles envíos y explica el estado cuando no sea evidente.

## Modales y overlays

- Pequeño: máximo aproximado de 440 px (`--ui-modal-max-width-small`).
- Formulario: 560 a 640 px; el token máximo es `--ui-modal-max-width-form`, 640 px.
- Amplio: 800 a 960 px; el token máximo es `--ui-modal-max-width-wide`, 960 px.
- En móvil usa pantalla completa o bottom sheet cuando ayude a completar la tarea.
- Evita scroll anidado. Si el contenido debe desplazarse, conserva título/contexto y acciones principales accesibles sin cubrir información.
- Gestiona foco inicial, navegación por teclado, Escape cuando sea seguro, devolución de foco y nombre accesible. Usa `role="dialog"` y `aria-modal="true"` cuando no exista un elemento o abstracción que ya proporcione esa semántica.
- Usa los tokens globales de capas enumerados en esta guía y verifica el contexto de apilamiento local antes de aumentar un z-index.

## Tablas y datos densos

No comprimas columnas hasta hacerlas ilegibles. En móvil decide explícitamente entre convertir filas en cards, mostrar primero la información prioritaria o permitir scroll horizontal cuando conservar las columnas sea esencial. El scroll de una tabla debe estar contenido y ser perceptible; nunca debe provocar overflow de toda la página.

Mantén encabezados comprensibles, asociación entre encabezados y celdas, formatos consistentes y acceso a acciones por teclado. Prueba valores extremos, estados sin resultados y cargas parciales.

## Estados de interfaz

Toda vista que dependa de datos debe contemplar, según corresponda:

- carga o skeleton sin saltos de layout desproporcionados;
- vacío inicial con contexto y siguiente acción;
- búsqueda o filtros sin resultados, diferenciados de un vacío inicial;
- error recuperable con mensaje y reintento;
- controles deshabilitados con motivo comprensible;
- éxito o confirmación cuando la acción no sea evidente;
- contenido largo, faltante o inesperado.

Los mensajes dinámicos importantes deben anunciarse con una región live apropiada, sin generar anuncios repetitivos.

## Accesibilidad y HTML

- Usa landmarks y HTML semántico: `main`, `nav`, `header`, `section`, listas, tablas, headings y controles nativos según su propósito.
- Mantén una jerarquía de encabezados coherente y un nombre accesible para cada control.
- Toda funcionalidad debe ser operable con teclado, con focus visible y sin trampas de foco.
- Asocia labels y campos; usa `fieldset` y `legend` para grupos cuando corresponda.
- Mantén contraste suficiente. No dependas únicamente del color, posición o icono para comunicar estado.
- Proporciona texto alternativo útil a imágenes informativas y `alt=""` a imágenes decorativas.
- Respeta preferencias como `prefers-reduced-motion` cuando agregues animación no esencial.

## Angular, TypeScript y alcance

- Respeta componentes standalone, rutas, servicios, signals y patrones de detección de cambios existentes. No muevas responsabilidades entre capas como efecto lateral de una tarea visual.
- Mantén `strict`, `strictTemplates` y el resto de comprobaciones activas. Modela los datos y estrecha tipos; evita `any`. Si una integración obliga a usarlo, limita su alcance y deja la justificación junto al código.
- No cambies lógica de negocio, permisos, contratos, persistencia, analítica ni navegación cuando el encargo sea solamente visual.
- Conserva lógica derivada fuera de la plantilla cuando sea compleja y evita efectos secundarios desde expresiones de template.
- Reutiliza los componentes compartidos existentes y la API pública de la feature. No crees abstracciones prematuras por coincidencia visual aislada.

## CSS y criterio de diseño

- Mantén estilos de componente en su CSS encapsulado. Reserva `src/styles.css` para tokens, reset y reglas verdaderamente globales.
- Reutiliza tokens y variables del contexto. No reemplaces paletas o tipografías existentes sin un alcance explícito.
- Evita `!important`; úsalo solo ante una limitación de cascada documentada y después de evaluar especificidad y estructura.
- Evita alturas fijas innecesarias. Prefiere `min-height`, contenido fluido y límites máximos cuando sean imprescindibles.
- No uses valores arbitrarios de espaciado, color, radio o tamaño si existe un token o patrón equivalente.
- Prioriza densidad útil y claridad. Evita cards exageradamente grandes, sombras intensas generalizadas y espacios vacíos decorativos.
- No conviertas automáticamente un escritorio en una única columna móvil: reorganiza según prioridad y mantén visibles las acciones frecuentes.
- Usa sticky solo cuando facilite una tarea frecuente, no cubra información y funcione con zoom, teclado y safe-area.

## Tokens globales disponibles

Los tokens están en `src/styles.css` y pueden consumirse desde cualquier componente con `var(--ui-...)`.

| Grupo | Tokens |
| --- | --- |
| Contenido | `--ui-content-max-width` |
| Padding de página | `--ui-page-padding-min`, `--ui-page-padding-mobile`, `--ui-page-padding-tablet`, `--ui-page-padding-desktop`, `--ui-page-padding-inline` |
| Espaciado | `--ui-space-4`, `--ui-space-8`, `--ui-space-12`, `--ui-space-16`, `--ui-space-24`, `--ui-space-32`, `--ui-space-48` |
| Controles | `--ui-control-height-compact`, `--ui-control-height`, `--ui-control-height-comfortable`, `--ui-touch-target-min` |
| Cards | `--ui-card-min-width` |
| Formularios | `--ui-form-max-width-compact`, `--ui-form-max-width-short`, `--ui-form-max-width-medium` |
| Modales | `--ui-modal-max-width-small`, `--ui-modal-max-width-form`, `--ui-modal-max-width-wide` |
| Radios | `--ui-radius-sm`, `--ui-radius-md`, `--ui-radius-lg`, `--ui-radius-xl`, `--ui-radius-pill` |
| Capas | `--ui-z-base`, `--ui-z-raised`, `--ui-z-backdrop`, `--ui-z-sticky`, `--ui-z-navigation`, `--ui-z-overlay`, `--ui-z-modal`, `--ui-z-toast` |

Los tokens son una base para trabajo nuevo y mejoras localizadas. No hagas reemplazos mecánicos de valores existentes sin validar el resultado de cada pantalla.

## Validación mínima

Valida como mínimo estos viewports:

- 1440 x 900;
- 1024 x 768;
- 768 x 1024;
- 390 x 844;
- 360 x 800.

En cada uno comprueba:

- overflow horizontal o vertical accidental;
- superposición de contenido, overlays y elementos sticky;
- texto cortado, ilegible o sin acceso al valor completo;
- botones y áreas táctiles demasiado pequeños;
- espacios excesivos y pérdida de densidad útil;
- scroll bloqueado, doble o difícil de descubrir;
- formularios difíciles de recorrer, leer o enviar;
- nombres, etiquetas, importes y mensajes largos;
- teclado, focus, loading, vacío, sin resultados, error y disabled.

Prueba también zoom del navegador y navegación por teclado cuando el cambio afecte controles, modales o flujo de lectura.

## Comandos y revisión final

Usa los scripts definidos en `package.json`. Actualmente no existe script de lint; no lo sustituyas por una herramienta no configurada.

```powershell
npm test -- --watch=false
npm run build
```

Si se agrega un script de lint en el futuro, ejecútalo también. Corrige errores introducidos por la tarea, revisa el diff completo y confirma que no se modificaron pantallas, lógica o archivos ajenos al alcance.
