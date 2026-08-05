import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const APPLY_MODE = process.argv.includes("--apply");
const SUMMARY_ONLY = process.argv.includes("--summary");
const SERVICE_ACCOUNT_ARG_NAMES = ["--credentials", "--service-account", "--serviceAccount"];
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];

type CatalogProductBackupRow = {
  document_id: string;
  data: FirebaseFirestore.DocumentData;
};

type CatalogProductSummaryRow = {
  id: string;
  business: string;
  supplier_id: string;
  name: string;
  price_cost: number | null;
  price_clienta: number | null;
};

function readArgValue(nameOrNames: string | string[]): string | null {
  const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
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
  const cleaned = String(value || "").trim().replace(/^["']|["']$/g, "");
  return cleaned ? path.resolve(cleaned) : null;
}

function credentialCandidates(): string[] {
  return [
    readArgValue(SERVICE_ACCOUNT_ARG_NAMES),
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...DEFAULT_SERVICE_ACCOUNT_PATHS,
  ]
    .map((candidate) => normalizePath(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function initFirebaseAdmin(): void {
  if (admin.apps.length) return;

  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(inline)),
      projectId: PROJECT_ID,
    });
    return;
  }

  const credentialPath = credentialCandidates().find((candidate) => fs.existsSync(candidate));
  if (!credentialPath) {
    throw new Error("No se encontró una credencial administrativa para Firebase.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(require(credentialPath)),
    projectId: PROJECT_ID,
  });
}

function toSummaryRow(docSnap: FirebaseFirestore.QueryDocumentSnapshot): CatalogProductSummaryRow {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    business: String(data["business_id"] || "bm"),
    supplier_id: String(data["supplier_id"] || "sin_proveedor"),
    name: String(data["name"] || "Sin nombre"),
    price_cost: typeof data["price_cost"] === "number" ? data["price_cost"] : null,
    price_clienta: typeof data["price_clienta"] === "number" ? data["price_clienta"] : null,
  };
}

async function deleteDocuments(docs: FirebaseFirestore.QueryDocumentSnapshot[]): Promise<void> {
  const db = admin.firestore();
  for (let offset = 0; offset < docs.length; offset += 400) {
    const batch = db.batch();
    for (const docSnap of docs.slice(offset, offset + 400)) batch.delete(docSnap.ref);
    await batch.commit();
    console.log(`[catalog-products-delete] borrados ${Math.min(offset + 400, docs.length)}/${docs.length}`);
  }
}

function createBackup(rows: CatalogProductBackupRow[]): string {
  const backupDir = path.resolve(process.cwd(), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `catalog-products-catalogo-${timestamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      project_id: PROJECT_ID,
      business: "catalogo",
      created_at: new Date().toISOString(),
      count: rows.length,
      rows,
    }, null, 2),
    "utf8",
  );
  return backupPath;
}

async function run(): Promise<void> {
  initFirebaseAdmin();
  const db = admin.firestore();
  const snapshot = await db.collection("catalog_products").where("business_id", "==", "catalogo").get();
  const targets = snapshot.docs;
  const summaries = targets.map(toSummaryRow);

  const bySupplier = summaries.reduce<Record<string, number>>((counts, row) => {
    counts[row.supplier_id] = (counts[row.supplier_id] || 0) + 1;
    return counts;
  }, {});

  console.log(`[catalog-products-delete] mode=${APPLY_MODE ? "APPLY" : "DRY-RUN"} business=catalogo`);
  console.log(`[catalog-products-delete] targets=${targets.length}`);
  console.log(`[catalog-products-delete] by_supplier=${JSON.stringify(bySupplier)}`);
  if (!SUMMARY_ONLY) console.table(summaries.slice(0, 20));

  if (!APPLY_MODE) return;
  if (targets.length === 0) return;

  const backupRows: CatalogProductBackupRow[] = targets.map((docSnap) => ({
    document_id: docSnap.id,
    data: docSnap.data(),
  }));
  const backupPath = createBackup(backupRows);
  await deleteDocuments(targets);

  const verification = await db.collection("catalog_products").where("business_id", "==", "catalogo").get();
  console.log(`[catalog-products-delete] deleted=${targets.length} remaining=${verification.size}`);
  console.log(`[catalog-products-delete] backup=${backupPath}`);
  if (verification.size > 0) throw new Error(`La verificación encontró ${verification.size} registros restantes.`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[catalog-products-delete] failed: ${message}`);
  process.exitCode = 1;
});
