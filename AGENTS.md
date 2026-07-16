# Reglas para tareas de interfaz

- Antes de modificar una interfaz, lee y aplica `docs/UI_GUIDELINES.md`.
- Respeta la arquitectura Angular existente. En tareas solamente visuales, no cambies lógica de negocio, contratos de datos ni comportamiento funcional.
- Reutiliza componentes, variables CSS, iconos y patrones existentes antes de crear otros. Mantén TypeScript estricto y evita `any` salvo justificación explícita.
- Usa HTML semántico y accesible, estados de foco visibles y controles nativos correctamente etiquetados.
- Diseña mobile-first. Evita alturas fijas innecesarias, valores arbitrarios y `!important` salvo justificación. No ocultes información esencial para resolver responsive ni permitas overflow horizontal.
- Contempla contenido largo y estados de carga, vacío, error, deshabilitado y sin resultados.
- Valida como mínimo en 1440 x 900, 1024 x 768, 768 x 1024, 390 x 844 y 360 x 800. Comprueba desbordamientos, superposición, textos cortados, áreas táctiles pequeñas, espacios excesivos, scroll problemático, formularios difíciles y nombres o textos largos.
- Ejecuta los comandos disponibles de lint, pruebas y build. Revisa el diff final y evita cambios no relacionados.
