/**
 * Business scope migration.
 *
 * Purpose:
 * - Create initial businesses/bm and businesses/catalogo docs.
 * - Mark existing private data as business_id="bm".
 * - Add businessMemberships to users, preserving current role/sections/capabilities as BM.
 *
 * Usage:
 *   npx tsx scripts/migrate-business-scope.ts
 *   npx tsx scripts/migrate-business-scope.ts --apply
 */

import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];
const APPLY_MODE = process.argv.includes("--apply");
const SERVICE_ACCOUNT_ARG_NAMES = ["--credentials", "--service-account", "--serviceAccount"];

const PRIVATE_COLLECTIONS = [
  "orders",
  "inventory_items",
  "suppliers",
  "supplier_operations",
  "finance_accounts",
  "finance_expenses",
  "finance_withdrawals",
  "finance_cuts",
  "normalized_listings",
  "categories",
];

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const inlineServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineServiceAccountJson) {
    const serviceAccount = JSON.parse(inlineServiceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    console.log("[business-scope] credential: FIREBASE_SERVICE_ACCOUNT_JSON");
    return;
  }

  const serviceAccountPath = findServiceAccountPath();
  if (serviceAccountPath) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    console.log(`[business-scope] credential: service account (${serviceAccountPath})`);
    return;
  }

  throw new Error(
    [
      "No se encontro credencial Firebase.",
      `Busque en: ${credentialCandidates().join(" | ")}`,
      "Opciones:",
      '  npm run firebase:migrate-business-scope:dry -- --credentials "C:\\ruta\\serviceAccountKey.json"',
      '  npm run firebase:migrate-business-scope:apply -- --credentials "C:\\ruta\\serviceAccountKey.json"',
      '  $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\ruta\\serviceAccountKey.json"; npm run firebase:migrate-business-scope:dry',
      '  $env:FIREBASE_SERVICE_ACCOUNT_JSON=(Get-Content "C:\\ruta\\serviceAccountKey.json" -Raw); npm run firebase:migrate-business-scope:dry',
    ].join("\n"),
  );
}

function findServiceAccountPath(): string | null {
  for (const candidate of credentialCandidates()) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function credentialCandidates(): string[] {
  return [
    getArgValue(SERVICE_ACCOUNT_ARG_NAMES),
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...DEFAULT_SERVICE_ACCOUNT_PATHS,
  ]
    .map((candidate) => normalizePath(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

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

function normalizePath(value: string | undefined | null): string | null {
  const cleaned = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  return path.resolve(cleaned);
}

async function commitBatchIfNeeded(batch: FirebaseFirestore.WriteBatch, pending: number): Promise<FirebaseFirestore.WriteBatch> {
  if (!APPLY_MODE || pending <= 0) return batch;
  await batch.commit();
  return admin.firestore().batch();
}

async function seedBusinesses(db: FirebaseFirestore.Firestore): Promise<void> {
  const rows = [
    { business_id: "bm", name: "Base Mayorista", short_name: "BM", active: true },
    { business_id: "catalogo", name: "Catalogo", short_name: "Catalogo", active: true },
  ];
  const batch = db.batch();
  for (const row of rows) {
    const ref = db.collection("businesses").doc(row.business_id);
    console.log(`- seed businesses/${row.business_id}`);
    if (APPLY_MODE) {
      batch.set(
        ref,
        {
          ...row,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  }
  if (APPLY_MODE) await batch.commit();
}

async function markCollectionAsBm(db: FirebaseFirestore.Firestore, collectionName: string): Promise<void> {
  const snap = await db.collection(collectionName).get();
  let updateCount = 0;
  let skipCount = 0;
  let pending = 0;
  let batch = db.batch();

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (data["business_id"]) {
      skipCount += 1;
      continue;
    }

    updateCount += 1;
    pending += 1;
    console.log(`- ${collectionName}/${docSnap.id}: set business_id=bm`);
    if (APPLY_MODE) {
      batch.set(
        docSnap.ref,
        {
          business_id: "bm",
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    if (pending >= 450) {
      batch = await commitBatchIfNeeded(batch, pending);
      pending = 0;
    }
  }

  if (pending > 0) {
    await commitBatchIfNeeded(batch, pending);
  }
  console.log(`[business-scope] ${collectionName}: update=${updateCount}, skip=${skipCount}`);
}

async function migrateUsers(db: FirebaseFirestore.Firestore): Promise<void> {
  const snap = await db.collection("users").get();
  let updateCount = 0;
  let skipCount = 0;
  let pending = 0;
  let batch = db.batch();

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (data["businessMemberships"]) {
      skipCount += 1;
      continue;
    }

    const roleId = String(data["roleId"] || "operativo");
    const sections = data["sections"] || {};
    const capabilities = data["capabilities"] || {};
    const memberships: Record<string, unknown> = {
      bm: {
        businessId: "bm",
        enabled: true,
        roleId,
        sections,
        capabilities,
      },
    };

    if (roleId === "super_admin") {
      memberships["catalogo"] = {
        businessId: "catalogo",
        enabled: true,
        roleId,
        sections,
        capabilities,
      };
    }

    updateCount += 1;
    pending += 1;
    console.log(`- users/${docSnap.id}: add businessMemberships`);
    if (APPLY_MODE) {
      batch.set(
        docSnap.ref,
        {
          businessMemberships: memberships,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    if (pending >= 450) {
      batch = await commitBatchIfNeeded(batch, pending);
      pending = 0;
    }
  }

  if (pending > 0) {
    await commitBatchIfNeeded(batch, pending);
  }
  console.log(`[business-scope] users: update=${updateCount}, skip=${skipCount}`);
}

async function run(): Promise<void> {
  console.log(`[business-scope] Mode: ${APPLY_MODE ? "APPLY" : "DRY-RUN"}`);
  initFirebaseAdmin();
  const db = admin.firestore();

  await seedBusinesses(db);
  for (const collectionName of PRIVATE_COLLECTIONS) {
    await markCollectionAsBm(db, collectionName);
  }
  await migrateUsers(db);

  console.log("[business-scope] done");
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[business-scope] failed\n${message}`);
  process.exitCode = 1;
});
