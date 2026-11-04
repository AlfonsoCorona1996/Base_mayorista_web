# Encuesta de aniversario · Noviembre de 2026

Campaña `aniversario-2026`, cuestionario **3**, misma ruta y seis preguntas. La versión del
cuestionario cambia porque se retira una opción, sin alterar los contratos ni la campaña.

- Pregunta 3: se retira «Un catálogo digital fácil de consultar y compartir». Quedan seis
  opciones, incluido Otro, y el límite sigue siendo dos.
- Pregunta 4: «Queremos llevar nuevas clientas hacia ti» pasa a ser el título principal y el
  destino de foco al entrar. La explicación sigue debajo, antes de «¿Te interesaría recibir estas
  posibles clientas?», que tiene menor tamaño. La propuesta sigue en preparación; responder no
  inscribe ni autoriza compartir datos. El grupo de respuestas también referencia la explicación
  mediante `aria-describedby`.
- Regalo: «10% extra» / «De descuento en tu próximo pedido. Úsalo durante noviembre de 2026.»
  La portada estática, la portada Angular, el registro y el comprobante comparten este texto.
  El backend conserva la descripción en `reward_snapshot`; no se cambia el cálculo de pedidos.

Los borradores v2 sin enviar conservan nombre, identificador, comentario y respuestas vigentes.
Solo se retira la selección `digital_catalog`; si era la única en la pregunta 3, se vuelve a esa
pregunta. Los envíos v1/v2 pendientes conservan su cuerpo original y se reintentan con la misma
versión e identificador, sin duplicados. Los comprobantes anteriores muestran su regalo original.

El backend conserva las definiciones v1/v2 y agrega v3. El panel permite consultar las tres versiones
sin mezclar resultados; las selecciones anteriores del catálogo continúan visibles en los reportes v2.
No hay migraciones de Firestore ni escrituras masivas sobre respuestas o regalos anteriores.

Primero se despliega el backend que admite v3 (commit `3522843`) y después este frontend. La API
pública `/api/surveys/aniversario-2026` debe devolver `questions_version: 3` y la descripción de
noviembre. Si existe una configuración explícita de `reward` en Firestore, mantiene prioridad.

Validación y capturas locales: `tmp/anniversary-november/` (ignorado por Git).

- Build de producción correcto, con los avisos ya existentes de presupuesto y CommonJS.
- Encuesta y panel: **47/47**. Suite global: **510/512**; los dos fallos anteriores de
  `AppVersionService` todavía esperan 2.2.3 en un proyecto 2.3.0. No existe script de lint.
- Backend: **162/162**, incluida la aceptación de v2 y el rechazo del catálogo en v3.
- Chrome sobre el build y las rutas reales del backend con Firestore exclusivamente emulado:
  **1440×900, 1024×768, 768×1024, 390×844, 360×800 y 320×568**. Portada con vigencia y
  botón visible, jerarquía de la pregunta 4, opciones, botones, scroll y texto al 200%.
- Se comprobaron registros 201, la vigencia en el snapshot real y la confirmación persistente;
  también el reintento de v2 sin duplicados y el comprobante anterior sin condiciones nuevas.
- En pantallas de hasta 640 px de alto, la portada reduce logo y espacios para dejar visible el
  botón junto a la vigencia. La bienvenida estática aplica la misma adaptación.

El frontend se prepara en `fix/aniversario-noviembre`. Integrarlo a `main` después de verificar
que la API publicada ya responde v3; el despliegue del backend sigue el procedimiento manual habitual.
