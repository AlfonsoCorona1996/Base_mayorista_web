# Finance Bootstrap Migration

This migration seeds base finance accounts used by the `Administracion` module.

## What it seeds

Collection: `finance_accounts`

- `acc_caja_general`
- `acc_banco_principal`
- `acc_caja_chica`
- `acc_fondo_inversion`
- `acc_reserva_pasivos`

The script is idempotent:

- If a doc already exists, it is skipped.
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
