# Pruebas contra el emulador de Firebase

Los `*.emulator.spec.ts` ejercitan los servicios reales contra un Firestore y un Auth
locales. No corren con `npm test` (el builder los excluye) y nunca tocan el proyecto real.

Requisitos: Java y Firebase CLI (`npm i -g firebase-tools`).

## Con las reglas reales (`firestore.rules`)

```bash
# terminal 1
firebase --config firebase.rules-test.json emulators:start --project demo-rules-test --only firestore,auth

# terminal 2
node scripts/emulator/run-spec.cjs inventory-rules.emulator.spec.ts        # matriz de permisos por rol
node scripts/emulator/run-spec.cjs delivery-consistency.emulator.spec.ts   # entrega e inventario
node scripts/emulator/run-spec.cjs client-rules-compat.emulator.spec.ts    # operaciones diarias por rol
node scripts/emulator/matrix.cjs tmp/emulator-logs/inventory-rules.emulator.spec.log
```

Los usuarios `users/{uid}` se siembran con el acceso `owner` del emulador (las reglas no
permiten crearlos desde el cliente). Si un commit de transacción falla solo con
`permission-denied`, el motivo está en `firestore-debug.log` (por ejemplo, el límite de
1000 expresiones por solicitud).

## Con reglas permisivas

```bash
firebase --config firebase.permissive-test.json emulators:start --project demo-test --only firestore,auth
node scripts/emulator/run-spec.cjs inventory-allocations.emulator.spec.ts --permissive
```

## Antes de publicar reglas nuevas

Las reglas se publican antes que el frontend, así que deben admitir al cliente que ya está
en producción. Con el árbol de la versión publicada y con el árbol nuevo:

```bash
# cliente publicado × reglas publicadas (copia descargada de producción)
node scripts/emulator/run-spec.cjs client-rules-compat.emulator.spec.ts --rules <publicadas.rules> --log tmp/emulator-logs/a.log
# cliente publicado × reglas propuestas
node scripts/emulator/run-spec.cjs client-rules-compat.emulator.spec.ts --rules <propuestas.rules> --log tmp/emulator-logs/b.log
node scripts/emulator/matrix.cjs --diff tmp/emulator-logs/a.log tmp/emulator-logs/b.log
```

`--diff` termina con código 1 si alguna operación que antes pasaba deja de pasar.
