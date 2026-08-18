# Finance Bootstrap Migration

This migration seeds base finance accounts used by the `Administracion` module and assigns every account to its business scope.

## What it seeds

Collection: `finance_accounts`

- `acc_caja_general` (`General`, Base Mayorista)
- `acc_banco_principal`
- `acc_caja_chica`
- `acc_fondo_inversion`
- `acc_reserva_pasivos`
- `acc_catalogo_general` (`General`, Catálogo)

The script is idempotent:

- Existing legacy docs missing `business_id` are repaired without changing their balance.
- Existing balances are never overwritten.

## Commands

Dry run (recommended first):

```bash
npm run firebase:migrate-finance:dry
```

Apply changes:

```bash
npm run firebase:migrate-finance:apply
```

## Service account

By default, the script expects:

`../whatsapp-bot/serviceAccountKey.json`

Resolved from this repo as:

`scripts/../../whatsapp-bot/serviceAccountKey.json`
