import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const APPLY_MODE = process.argv.includes("--apply");
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];

function argValue(name: string): string | null {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function credentialCandidates(): string[] {
  return [
    argValue("--credentials"),
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...DEFAULT_SERVICE_ACCOUNT_PATHS,
  ]
    .map((value) => String(value || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

function initFirebaseAdmin(): void {
  if (admin.apps.length) return;
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(inlineJson)), projectId: PROJECT_ID });
    return;
  }
  const found = credentialCandidates().find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No se encontro credencial Firebase. Busque en: ${credentialCandidates().join(" | ")}`);
  admin.initializeApp({ credential: admin.credential.cert(require(found)), projectId: PROJECT_ID });
}

function normalizeSku(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

async function run(): Promise<void> {
  initFirebaseAdmin();
  const db = admin.firestore();
  const snap = await db.collection("catalog_products").get();
  let needsPatch = 0;
  let patched = 0;
  let batch = db.batch();
  let pending = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const sku = String(data.sku || "").trim();
    const next = normalizeSku(data.sku_normalized || sku);
    if (!sku || data.sku_normalized === next) continue;
    needsPatch += 1;
    if (APPLY_MODE) {
      batch.set(docSnap.ref, { sku_normalized: next, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      pending += 1;
      patched += 1;
      if (pending >= 450) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
  }

  if (APPLY_MODE && pending > 0) await batch.commit();
  console.log(`[catalog-products-search] mode=${APPLY_MODE ? "APPLY" : "DRY-RUN"}`);
  console.log(`[catalog-products-search] scanned=${snap.size}`);
  console.log(`[catalog-products-search] needs_sku_normalized=${needsPatch}`);
  console.log(`[catalog-products-search] patched=${patched}`);
}

run().catch((error) => {
  console.error("[catalog-products-search] failed", error);
  process.exitCode = 1;
});
