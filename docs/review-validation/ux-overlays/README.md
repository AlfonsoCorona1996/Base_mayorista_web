# Modales y submenús de Review

Se abrió la plantilla real de Angular con servicios simulados en 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844 y 360 × 800. No se escribieron documentos de producción ni se subieron archivos a Storage durante esta auditoría. Las imágenes son fixtures de presentación, no muestras para evaluar la IA.

31 estados por tamaño, 155 capturas: portada frente a foto visible, menús de colores y de tres posiciones de fotos adicionales, fotos excluidas, ayuda de código, atributos, buscador/árbol/creación/propuesta de categoría, alta y edición de variantes, detalles y colores de variantes, selector anidado, selección de portada, cambio de foto, alta de color con/sin foto, foto seleccionada, error de subida, mensaje original, acciones adicionales, fusión vacía/con opciones y visor con/sin zoom.

`results.json` registra dimensiones, padding, margin, gap, colores, desbordamientos y objetivos táctiles. La revisión no encontró desbordamientos horizontales, controles visibles cubiertos ni áreas táctiles menores de 44 px en las regiones auditadas. Los controles fuera del área desplazable visible no se consideran tapados. El input de archivo oculto se acciona mediante el botón accesible «Subir foto».

Además de las capturas se comprobó Escape en el selector anidado. Las pruebas unitarias cubren bloqueo del cierre durante una operación, creación solo tras confirmar, cancelación, rechazo de duplicados y conservación de la portada.

Ejemplos: [añadir color en escritorio](1440-new-color-selected.png), [añadir color en móvil](360-new-color-selected.png), [nota de ayuda](360-code-help.png), [portada y foto visible](1440-cover-versus-selection.png).
