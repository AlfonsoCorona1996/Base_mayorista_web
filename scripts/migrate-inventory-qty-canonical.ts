/**
 * Fase 0 · Unifica las cantidades de inventario en un solo nombre por concepto.
 *
 * Antes convivían dos campos con nombres casi iguales y significados distintos:
 *   on_hand_qty      -> existencia física total (apartado + revisión + daño + libre)
 *   quantity_on_hand -> a pesar del nombre, guardaba la cantidad DISPONIBLE
 *
 * Esta migración deja el modelo canónico y borra el campo legacy:
 *   on_hand_qty = reserved_qty + in_review_qty + damaged_qty + available_qty
 *   available_qty = lo que se puede vender hoy
 *
 * Documentos viejos que solo traen `quantity_on_hand` se reconstruyen sumando
 * de vuelta lo apartado, lo dañado y lo que está en revisión.
 *
 * Dry-run (predeterminado): npm run firebase:migrate-inventory-qty:dry
 * Aplicar:                  npm run firebase:migrate-inventory-qty:apply
 * Credencial opcional: -- --credentials "C:\\ruta\\serviceAccountKey.json"
 */
import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const APPLY = process.argv.includes("--apply");

const report = {
  scanned: 0,
  alreadyCanonical: 0,
  legacyFieldRemoved: 0,
  onHandRebuilt: 0,
  availableRebuilt: 0,
  quantitiesCorrected: [] as string[],
  negativesClamped: [] as string[],
};

function argValue(name: string): string | null {
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return null;
  return process.argv[index].includes("=") ? process.argv[index].slice(name.length + 1) : process.argv[index + 1] || null;
}

function initAdmin() {
  if (admin.apps.length) return;
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const candidates = [
    argValue("--credentials"),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
    path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
  ].filter(Boolean).map((entry) => path.resolve(String(entry).replace(/^["']|["']$/g, "")));
  if (inline) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(inline)), projectId: PROJECT_ID });
    return;
  }
  const file = candidates.find((entry) => fs.existsSync(entry));
  if (!file) throw new Error("No se encontró credencial Firebase. Usa --credentials o GOOGLE_APPLICATION_CREDENTIALS.");
  admin.initializeApp({ credential: admin.credential.cert(require(file)), projectId: PROJECT_ID });
}

function safeQty(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function has(data: FirebaseFirestore.DocumentData, key: string): boolean {
  return data[key] !== undefined && data[key] !== null;
}

/**
 * Misma lógica que `readInventoryQuantities` en inventory.service.ts.
 * Se duplica a propósito: el script corre con firebase-admin fuera de Angular
 * y no debe arrastrar el árbol de dependencias de la app.
 */
function canonicalQuantities(data: FirebaseFirestore.DocumentData) {
  const reserved = safeQty(data["reserved_qty"]);
  const inReview = safeQty(data["in_review_qty"]);
  const damaged = safeQty(data["damaged_qty"]);
  const legacyAvailable = safeQty(data["quantity_on_hand"]);

  const available = has(data, "available_qty") ? safeQty(data["available_qty"]) : legacyAvailable;
  const onHand = has(data, "on_hand_qty")
    ? safeQty(data["on_hand_qty"])
    : available + reserved + inReview + damaged;

  return { onHand, reserved, available, inReview, damaged };
}

async function migrateInventory(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection("inventory_items").get();
  const writer = APPLY ? db.bulkWriter() : null;

  for (const entry of snap.docs) {
    const data = entry.data();
    report.scanned += 1;

    const { onHand, reserved, available, inReview, damaged } = canonicalQuantities(data);
    const hadLegacy = data["quantity_on_hand"] !== undefined;
    const rebuiltOnHand = !has(data, "on_hand_qty");
    const rebuiltAvailable = !has(data, "available_qty");

    // La identidad que debe cumplirse siempre. Si no cuadra, manda la
    // existencia física: lo apartado, dañado y en revisión son hechos
    // registrados por movimientos; lo disponible es el residuo.
    const committed = reserved + inReview + damaged;
    const expectedAvailable = Math.max(0, onHand - committed);
    const mismatched = available !== expectedAvailable;

    if (mismatched) {
      report.quantitiesCorrected.push(
        `${entry.id}: disponible ${available} -> ${expectedAvailable} (fisico ${onHand}, comprometido ${committed})`,
      );
    }
    if (onHand < committed) {
      report.negativesClamped.push(
        `${entry.id}: existencia ${onHand} menor que comprometido ${committed}`,
      );
    }
    if (rebuiltOnHand) report.onHandRebuilt += 1;
    if (rebuiltAvailable) report.availableRebuilt += 1;
    if (hadLegacy) report.legacyFieldRemoved += 1;

    if (!hadLegacy && !rebuiltOnHand && !rebuiltAvailable && !mismatched) {
      report.alreadyCanonical += 1;
      continue;
    }

    writer?.set(entry.ref, {
      on_hand_qty: onHand,
      reserved_qty: reserved,
      available_qty: expectedAvailable,
      in_review_qty: inReview,
      damaged_qty: damaged,
      quantity_on_hand: admin.firestore.FieldValue.delete(),
      inventory_qty_model_version: 2,
      inventory_qty_migrated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await writer?.close();
}

async function run() {
  console.log(`[inventory-qty] modo=${APPLY ? "APPLY" : "DRY-RUN"}`);
  initAdmin();
  const db = admin.firestore();
  await migrateInventory(db);

  const reportJson = JSON.stringify(report, null, 2);
  const reportDir = path.resolve(process.cwd(), "migration-reports");
  const reportPath = path.join(reportDir, `inventory-qty-${APPLY ? "apply" : "dry-run"}.json`);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${reportJson}\n`, "utf8");
  console.log(reportJson);
  console.log(`[inventory-qty] reporte=${reportPath}`);
  if (!APPLY) {
    console.log("Dry-run: no se escribió ningún documento.");
    console.log("Revisa `quantitiesCorrected` y `negativesClamped` antes de usar --apply.");
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
