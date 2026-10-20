# Validación del ranking de productos

Componentes Angular reales con servicios simulados, sin escrituras de pedidos desde el navegador. Datos de presentación independientes del ranking real.

Cinco viewports: 1440 × 900, 1024 × 768, 768 × 1024, 390 × 844 y 360 × 800, más espacio CSS equivalente a zoom de 200%. Se abren comparación y explicación; se prueba unidades/ganancia, ficha con venta positiva, carga, error, vacío y cambio de negocio. Cambiar al negocio Catálogo modifica el ranking y conserva los datos BM de la ficha BM abierta.

`results.json` registra errores de ejecución, ancho del documento y áreas táctiles. Las comprobaciones verifican que la ficha muestre $400 en el fixture y que no muestre importes cero mientras cargan los pedidos o cuando falla la consulta.

Resultado: 56 estados, sin errores de ejecución, desbordamientos horizontales ni objetivos táctiles inferiores a 44 px.

Ejemplos: [ranking móvil](360-ranking.png), [comparación](390-comparison.png), [error](390-error.png), [ficha](390-detail.png).
