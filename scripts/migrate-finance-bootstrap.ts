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
import * as fs from "node:fs";
import * as path from "node:path";

type FinanceAccountSeed = {
  account_id: string;
  business_id: "bm" | "catalogo";
  name: string;
  balance: number;
  notes: string;
};

const PROJECT_ID = "base-mayorista";
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];

const ACCOUNT_SEED: FinanceAccountSeed[] = [
  {
    account_id: "acc_caja_general",
    business_id: "bm",
    name: "General",
    balance: 0,
    notes: "Efectivo operativo diario.",
  },
  {
    account_id: "acc_banco_principal",
    business_id: "bm",
    name: "Banco principal",
    balance: 0,
    notes: "Cuenta bancaria principal para cobros y pagos.",
  },
  {
    account_id: "acc_caja_chica",
    business_id: "bm",
    name: "Caja chica",
    balance: 0,
    notes: "Fondo para gastos menores y consumibles.",
  },
  {
    account_id: "acc_fondo_inversion",
    business_id: "bm",
    name: "Fondo de inversion",
    balance: 0,
    notes: "Bolsa para compras por inversion y reposicion.",
  },
  {
    account_id: "acc_reserva_pasivos",
    business_id: "bm",
    name: "Reserva de pasivos",
    balance: 0,
    notes: "Reserva para deudas fijas y deudas a meses.",
  },
  {
    account_id: "acc_catalogo_general",
    business_id: "catalogo",
    name: "General",
    balance: 0,
    notes: "Cuenta general del negocio Catálogo.",
  },
];

const APPLY_MODE = process.argv.includes("--apply");
const SERVICE_ACCOUNT_ARG_NAMES = ["--credentials", "--service-account", "--serviceAccount"];

function getArgValue(names: string[]): string | null {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    for (const name of names) {
      if (arg === name) return process.argv[index + 1] || null;
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return null;
}

function findServiceAccountPath(): string {
  const candidates = [
    getArgValue(SERVICE_ACCOUNT_ARG_NAMES),
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...DEFAULT_SERVICE_ACCOUNT_PATHS,
  ]
    .map((candidate) => String(candidate || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (match) return match;
  throw new Error("No se encontró la credencial Firebase. Usa --credentials <ruta>.");
}

async function run(): Promise<void> {
  const modeLabel = APPLY_MODE ? "APPLY" : "DRY-RUN";
  const serviceAccountPath = findServiceAccountPath();
  console.log(`[finance-bootstrap] Mode: ${modeLabel}`);
  console.log(`[finance-bootstrap] Service account path: ${serviceAccountPath}`);

  const serviceAccount = require(serviceAccountPath);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
  }

  const db = admin.firestore();
  const accountsCollection = db.collection("finance_accounts");

  let createCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  const batch = db.batch();

  for (const seed of ACCOUNT_SEED) {
    const docRef = accountsCollection.doc(seed.account_id);
    const snap = await docRef.get();

    if (snap.exists) {
      const data = snap.data() || {};
      if (data["business_id"] && data["business_id"] !== seed.business_id) {
        skipCount += 1;
        console.warn(`- skip ${seed.account_id}: pertenece a ${String(data["business_id"])}`);
        continue;
      }

      const updates: Record<string, unknown> = {};
      if (!data["account_id"]) updates["account_id"] = seed.account_id;
      if (!data["business_id"]) updates["business_id"] = seed.business_id;
      if (!data["name"] || (seed.account_id === "acc_caja_general" && data["name"] === "Caja general")) {
        updates["name"] = seed.name;
      }
      if (!data["notes"]) updates["notes"] = seed.notes;
      if (Object.keys(updates).length === 0) {
        skipCount += 1;
        console.log(`- skip ${seed.account_id} (already configured)`);
        continue;
      }

      updateCount += 1;
      console.log(`- update ${seed.account_id}: ${Object.keys(updates).join(", ")}`);
      if (APPLY_MODE) {
        batch.set(docRef, {
          ...updates,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
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

  if (APPLY_MODE && createCount + updateCount > 0) {
    await batch.commit();
    console.log(`[finance-bootstrap] committed create=${createCount}, update=${updateCount}.`);
  } else if (APPLY_MODE) {
    console.log("[finance-bootstrap] nothing to commit.");
  }

  console.log(
    `[finance-bootstrap] done. create=${createCount}, update=${updateCount}, skip=${skipCount}, total_seed=${ACCOUNT_SEED.length}`,
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
