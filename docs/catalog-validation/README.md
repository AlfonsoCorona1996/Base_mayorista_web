# Validación visual de la ficha de catálogo

Componente Angular real con datos y servicios simulados. Las fotos son fixtures de presentación. La ruta de localhost redirige al navegador de pruebas al inicio de sesión; `live-route.png` documenta esa limitación.

Capturas a 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844 y 360 × 800. `*-before.png` conserva la vista anterior. El resto muestra consulta, selección de foto, visor, zoom, ayudas, acciones masivas, notas, ventas, inventario, registro técnico, edición, variantes, editor de fotos/colores, contenido largo, vacío, carga y error.

`720-zoom-equivalent.png` comprueba el espacio CSS equivalente a 1440 × 900 con zoom del 200%. `1024-sidebar-space.png` reserva 304 px para el menú lateral y verifica la adaptación por ancho del contenedor.

`results.json` registra dimensiones, padding, gap, objetivos táctiles, etiquetas de formularios, desbordamientos y controles cubiertos dentro de los modales. Se comprueba Escape, restauración de foco y guardado con un servicio simulado.

Resultado final: 97 estados capturados y medidos, sin errores de ejecución, desbordamiento horizontal, controles visibles tapados en los modales, controles sin etiqueta ni objetivos táctiles menores de 44 px. Las cinco capturas anteriores y la captura de acceso a la ruta se conservan aparte de esas mediciones.

Ejemplos: [escritorio](1440-initial.png), [móvil](360-initial.png), [editor de fotos](1440-assets-top.png), [foto del color en móvil](360-assets-color.png).
