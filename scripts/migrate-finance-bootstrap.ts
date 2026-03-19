/**
 * Finance bootstrap migration.
 *
 * Usage:
 *   npx tsx scripts/migrate-finance-bootstrap.ts
 *   npx tsx scripts/migrate-finance-bootstrap.ts --apply
 *
 * Default mode is dry-run.
 */

import * as admin from "firebase-admin";
import * as path from "node:path";

type FinanceAccountSeed = {
  account_id: string;
  name: string;
  balance: number;
  notes: string;
};

const PROJECT_ID = "base-mayorista";
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json");

const ACCOUNT_SEED: FinanceAccountSeed[] = [
  {
    account_id: "acc_caja_general",
    name: "Caja general",
    balance: 0,
    notes: "Efectivo operativo diario.",
  },
  {
    account_id: "acc_banco_principal",
    name: "Banco principal",
    balance: 0,
    notes: "Cuenta bancaria principal para cobros y pagos.",
  },
  {
    account_id: "acc_caja_chica",
    name: "Caja chica",
    balance: 0,
    notes: "Fondo para gastos menores y consumibles.",
  },
  {
    account_id: "acc_fondo_inversion",
    name: "Fondo de inversion",
    balance: 0,
    notes: "Bolsa para compras por inversion y reposicion.",
  },
  {
    account_id: "acc_reserva_pasivos",
    name: "Reserva de pasivos",
    balance: 0,
    notes: "Reserva para deudas fijas y deudas a meses.",
  },
];

const APPLY_MODE = process.argv.includes("--apply");

async function run(): Promise<void> {
  const modeLabel = APPLY_MODE ? "APPLY" : "DRY-RUN";
  console.log(`[finance-bootstrap] Mode: ${modeLabel}`);
  console.log(`[finance-bootstrap] Service account path: ${SERVICE_ACCOUNT_PATH}`);

  const serviceAccount = require(SERVICE_ACCOUNT_PATH);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
  }

  const db = admin.firestore();
  const accountsCollection = db.collection("finance_accounts");

  let createCount = 0;
  let skipCount = 0;
  const batch = db.batch();

  for (const seed of ACCOUNT_SEED) {
    const docRef = accountsCollection.doc(seed.account_id);
    const snap = await docRef.get();

    if (snap.exists) {
      skipCount += 1;
      const data = snap.data() || {};
      console.log(`- skip ${seed.account_id} (already exists as "${String(data["name"] || "")}")`);
      continue;
    }

    createCount += 1;
    console.log(`- create ${seed.account_id} (${seed.name})`);
    if (APPLY_MODE) {
      batch.set(docRef, {
        ...seed,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  if (APPLY_MODE && createCount > 0) {
    await batch.commit();
    console.log(`[finance-bootstrap] committed ${createCount} new account docs.`);
  } else if (APPLY_MODE) {
    console.log("[finance-bootstrap] nothing to commit.");
  }

  console.log(
    `[finance-bootstrap] done. create=${createCount}, skip=${skipCount}, total_seed=${ACCOUNT_SEED.length}`,
  );
  if (!APPLY_MODE) {
    console.log("[finance-bootstrap] dry-run only. Re-run with --apply to write changes.");
  }
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[finance-bootstrap] failed: ${message}`);
    process.exit(1);
  });
