# Validación de Review: jerarquía y decisiones

Componente Angular real con servicios simulados, sin escrituras en Firebase ni llamadas pagadas a IA. Las fotos son fixtures de presentación; no sirven para medir exactitud perceptual del modelo.

Viewports: 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844 y 360 × 800. Para cada uno: `*-initial.png`, `*-category.png`, `*-proposal.png`, `*-colors.png`.

Se verifican confirmación, cambio, búsqueda sin resultados, propuesta visible sin menú, descarte, bloqueo de publicación, colores dudosos, nombres y palabras largas, visor/Escape, carga y guardado. `results.json` registra ancho del documento y controles pequeños. El único control pequeño es el glifo del checkbox; su etiqueta constituye el área interactiva de 44 px.

Se conserva el comportamiento sticky real en las capturas. Las capturas de `refinement/` corresponden al diseño anterior guardado en 398f118.
