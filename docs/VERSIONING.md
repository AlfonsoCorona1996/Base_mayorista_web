# Versionado y releases

Frontend y backend son artefactos desplegables independientes y por eso mantienen
versiones SemVer propias. La versión del frontend vive en su `package.json`; la del
backend vive en el `package.json` de su repositorio. No se debe usar el nombre del
commit como sustituto de la versión.

## Regla SemVer

- `PATCH` (`2.1.0` → `2.1.1`): corrección compatible sin funcionalidad nueva.
- `MINOR` (`2.1.0` → `2.2.0`): funcionalidad o endpoint compatible nuevo.
- `MAJOR` (`2.1.0` → `3.0.0`): cambio incompatible de contrato, datos o despliegue.

Los esquemas de Firestore, formatos de importación y contratos API conservan su
propia versión; no deben inferirse a partir de la versión de la aplicación.

## Flujo de release

1. Trabajar en una rama y usar commits convencionales (`feat:`, `fix:`, `perf:`, `chore:`).
2. Elegir el incremento SemVer según el cambio de mayor impacto.
3. Actualizar `package.json`, `package-lock.json` y `CHANGELOG.md`.
4. Ejecutar `npm run version:check`, pruebas y build.
5. Integrar el cambio y crear un tag anotado `vX.Y.Z` sobre el commit exacto de release.
6. Desplegar ese tag o commit, nunca un directorio local sin confirmar.
7. Verificar `/version.json` en frontend y `/health` en backend después del despliegue.

Para DigitalOcean se recomienda declarar `APP_COMMIT_SHA=${_self.COMMIT_HASH}`. Si
el despliegue es manual desde un clon Git, los scripts obtienen el commit directamente
del repositorio.

## Compatibilidad de este release

- Frontend `2.1.x` funciona con backend `2.2.x` para mutaciones incrementales e identificación exacta en UI.
- Frontend `2.2.x` requiere backend `2.3.x` para sellar en servidor la auditoría de opciones provisionales de catálogo.
- Desplegar primero backend `2.3.x` y después frontend `2.2.x`; el cambio de contrato es aditivo y compatible.
