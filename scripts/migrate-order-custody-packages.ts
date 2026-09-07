/**
 * Fase 0 · Un solo campo por concepto en los pedidos.
 *
 * 1. Custodia. Convivían `custody_status` y `current_holder_location` con el
 *    mismo significado, escritos a mano en pares. Se conserva
 *    `current_holder_location` (vocabulario más rico y nombre más claro) y se
 *    borra `custody_status`. Único valor que no era idéntico:
 *      custody_status "shipment"  ->  current_holder_location "in_transit"
 *
 * 2. Estados. Cuatro conceptos tenian nombre en español y en ingles vivos al
 *    mismo tiempo. Se conserva el español:
 *      delivered -> entregado          in_transit -> en_ruta
 *      delivered_partial -> entregado_parcial
 *      packing -> empaque              inbound_in_transit -> en_transito
 *
 * 3. Cajas. `PackageRecord` traía `state` y `status`, con vocabularios
 *    traslapados. Se conserva `state` como ciclo de vida único y se borra
 *    `status`. `armado` era sinónimo de `closed`.
 *
 * Dry-run (predeterminado): npm run firebase:migrate-order-fields:dry
 * Aplicar:                  npm run firebase:migrate-order-fields:apply
 * Credencial opcional: -- --credentials "C:\\ruta\\serviceAccountKey.json"
 */
import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const APPLY = process.argv.includes("--apply");

const report = {
  ordersScanned: 0,
  ordersUnchanged: 0,
  custodyFieldRemoved: 0,
  holderDerivedFromCustody: 0,
  holderDerivedFromStatus: 0,
  packagesNormalized: 0,
  packageStatusRemoved: 0,
  packageArmadoRenamed: 0,
  statusRenamed: 0,
  statusRenamesByPair: {} as Record<string, number>,
  custodyDisagreements: [] as string[],
  unknownStatuses: [] as string[],
};

/** Nombre viejo -> canonico. Igual que LEGACY_ORDER_STATUS_ALIASES en orders.service.ts. */
const STATUS_ALIASES: Record<string, string> = {
  delivered: "entregado",
  delivered_partial: "entregado_parcial",
  in_transit: "en_ruta",
  packing: "empaque",
  inbound_in_transit: "en_transito",
};

const CANONICAL_STATUSES = [
  "borrador", "confirmando_proveedor", "reservado_inventario", "solicitado_proveedor",
  "supplier_processing", "en_transito", "recibido_qa", "empaque", "ready_for_route",
  "assigned_to_run", "en_ruta", "entregado", "entregado_parcial", "closed",
  "pago_pendiente", "pagado_parcial", "pagado", "cancelado", "devuelto",
];

const HOLDER_VALUES = ["gdl", "in_transit", "durango", "delivery_staff", "customer", "other"];
const PACKAGE_STATES = ["open", "closed", "en_ruta", "entregado", "devuelto"];

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

/** Misma lógica que `normalizeHolderLocation` en orders.service.ts. */
function resolveHolderLocation(data: FirebaseFirestore.DocumentData): { value: string; source: "existing" | "custody" | "derived" } {
  const current = data["current_holder_location"];
  if (HOLDER_VALUES.includes(String(current))) return { value: String(current), source: "existing" };

  const legacy = String(data["custody_status"] || "");
  if (legacy === "shipment") return { value: "in_transit", source: "custody" };
  if (["gdl", "durango", "delivery_staff", "customer"].includes(legacy)) return { value: legacy, source: "custody" };

  const status = String(data["status"] || "");
  if (data["delivered_at"] || ["delivered", "entregado", "pagado", "closed"].includes(status)) {
    return { value: "customer", source: "derived" };
  }
  if (data["shipment_id"]) return { value: "in_transit", source: "derived" };
  if (data["route_run_id"] || ["assigned_to_run", "in_transit", "en_ruta"].includes(status)) {
    return { value: "delivery_staff", source: "derived" };
  }
  return { value: "gdl", source: "derived" };
}

/** El valor que `custody_status` habría expresado, para detectar desacuerdos. */
function custodyAsHolder(legacy: unknown): string | null {
  const value = String(legacy || "");
  if (value === "shipment") return "in_transit";
  if (["gdl", "durango", "delivery_staff", "customer"].includes(value)) return value;
  return null;
}

/** Misma lógica que `normalizePackage` en orders.service.ts. */
function normalizePackage(pkg: FirebaseFirestore.DocumentData) {
  const rawState = String(pkg?.["state"] || "").trim();
  let state: string;
  let renamedArmado = false;

  if (rawState === "armado") {
    state = "closed";
    renamedArmado = true;
  } else if (PACKAGE_STATES.includes(rawState)) {
    state = rawState;
  } else {
    state = pkg?.["status"] === "closed" ? "closed" : "open";
  }

  const hadStatus = pkg?.["status"] !== undefined;
  const next = { ...pkg, state };
  delete next["status"];
  return { next, hadStatus, renamedArmado, changed: hadStatus || renamedArmado || rawState !== state };
}

async function migrateOrders(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection("orders").get();
  const writer = APPLY ? db.bulkWriter() : null;

  for (const entry of snap.docs) {
    const data = entry.data();
    report.ordersScanned += 1;

    const holder = resolveHolderLocation(data);
    const hadCustody = data["custody_status"] !== undefined;

    // Si ambos existian y no coincidian, hay que saberlo antes de borrar uno.
    if (hadCustody && holder.source === "existing") {
      const expected = custodyAsHolder(data["custody_status"]);
      if (expected && expected !== holder.value) {
        report.custodyDisagreements.push(
          `${entry.id}: custody_status=${data["custody_status"]} (=> ${expected}) vs current_holder_location=${holder.value}. Se conserva ${holder.value}.`,
        );
      }
    }

    if (hadCustody) report.custodyFieldRemoved += 1;
    if (holder.source === "custody") report.holderDerivedFromCustody += 1;
    if (holder.source === "derived") report.holderDerivedFromStatus += 1;

    const rawPackages: FirebaseFirestore.DocumentData[] = Array.isArray(data["packages"]) ? data["packages"] : [];
    const normalized = rawPackages.map(normalizePackage);
    const packagesChanged = normalized.some((row) => row.changed);
    report.packageStatusRemoved += normalized.filter((row) => row.hadStatus).length;
    report.packageArmadoRenamed += normalized.filter((row) => row.renamedArmado).length;
    if (packagesChanged) report.packagesNormalized += 1;

    // Estado del pedido: los cuatro conceptos que tenian nombre en dos idiomas.
    const rawStatus = String(data["status"] || "");
    let nextStatus = rawStatus;
    if (STATUS_ALIASES[rawStatus]) {
      nextStatus = STATUS_ALIASES[rawStatus];
      report.statusRenamed += 1;
      const pair = `${rawStatus} -> ${nextStatus}`;
      report.statusRenamesByPair[pair] = (report.statusRenamesByPair[pair] || 0) + 1;
    } else if (!CANONICAL_STATUSES.includes(rawStatus)) {
      // No se toca: se reporta para revisarlo a mano antes de decidir.
      report.unknownStatuses.push(`${entry.id}: status=${rawStatus || "(vacio)"}`);
    }
    const statusChanged = nextStatus !== rawStatus;

    const holderChanged = holder.source !== "existing";
    if (!hadCustody && !packagesChanged && !holderChanged && !statusChanged) {
      report.ordersUnchanged += 1;
      continue;
    }

    const patch: FirebaseFirestore.DocumentData = {
      current_holder_location: holder.value,
      custody_status: admin.firestore.FieldValue.delete(),
      order_fields_model_version: 2,
      order_fields_migrated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (statusChanged) patch["status"] = nextStatus;
    // `packages` es un arreglo: se reemplaza completo o no se toca.
    if (packagesChanged) patch["packages"] = normalized.map((row) => row.next);

    writer?.set(entry.ref, patch, { merge: true });
  }

  await writer?.close();
}

async function run() {
  console.log(`[order-fields] modo=${APPLY ? "APPLY" : "DRY-RUN"}`);
  initAdmin();
  const db = admin.firestore();
  await migrateOrders(db);

  const reportJson = JSON.stringify(report, null, 2);
  const reportDir = path.resolve(process.cwd(), "migration-reports");
  const reportPath = path.join(reportDir, `order-fields-${APPLY ? "apply" : "dry-run"}.json`);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${reportJson}\n`, "utf8");
  console.log(reportJson);
  console.log(`[order-fields] reporte=${reportPath}`);
  if (!APPLY) {
    console.log("Dry-run: no se escribió ningún documento.");
    console.log("Revisa `custodyDisagreements` antes de usar --apply: ahí los dos campos decían cosas distintas.");
    console.log("Revisa `unknownStatuses`: son estados fuera del vocabulario que el script NO toca.");
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
