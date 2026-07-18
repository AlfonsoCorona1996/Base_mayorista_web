import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const APPLY_MODE = process.argv.includes("--apply");
const SUMMARY_ONLY = process.argv.includes("--summary");
const CONFIRM_ALL_BUSINESSES = process.argv.includes("--confirm-all-businesses");
const FORCE_RESERVED = process.argv.includes("--force-reserved");
const RECONCILE_DELIVERY = process.argv.includes("--reconcile-delivery");
const BUSINESS_ARG = readArgValue("--business")?.trim().toLowerCase() || "all";
const SERVICE_ACCOUNT_ARG_NAMES = ["--credentials", "--service-account", "--serviceAccount"];
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];

type InventoryBackupRow = {
  document_id: string;
  data: FirebaseFirestore.DocumentData;
};

type InventorySummaryRow = {
  id: string;
  business: string;
  title: string;
  on_hand: number;
  available: number;
  reserved: number;
  in_review: number;
  damaged: number;
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

function safeQty(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function businessId(data: FirebaseFirestore.DocumentData): string {
  return String(data["business_id"] || "bm").trim().toLowerCase() || "bm";
}

function reservationQty(data: FirebaseFirestore.DocumentData): number {
  const reservations = data["reservations"];
  if (!reservations || typeof reservations !== "object" || Array.isArray(reservations)) {
    return safeQty(data["reserved_qty"]);
  }

  const fromMap = Object.values(reservations as Record<string, unknown>).reduce((sum, entry) => {
    if (typeof entry === "number") return sum + safeQty(entry);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return sum;
    return sum + safeQty((entry as Record<string, unknown>)["qty"]);
  }, 0);
  return Math.max(safeQty(data["reserved_qty"]), fromMap);
}

function reservationOrderIds(data: FirebaseFirestore.DocumentData): string[] {
  const reservations = data["reservations"];
  if (!reservations || typeof reservations !== "object" || Array.isArray(reservations)) return [];
  return Object.entries(reservations as Record<string, unknown>)
    .filter(([, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      return safeQty((entry as Record<string, unknown>)["qty"]) > 0;
    })
    .map(([orderId]) => orderId)
    .filter(Boolean);
}

function toSummaryRow(docSnap: FirebaseFirestore.QueryDocumentSnapshot): InventorySummaryRow {
  const data = docSnap.data();
  const reserved = reservationQty(data);
  const onHand = safeQty(data["on_hand_qty"] ?? data["available_qty"] ?? data["quantity_on_hand"]);
  const available = safeQty(data["available_qty"] ?? Math.max(0, onHand - reserved));
  return {
    id: docSnap.id,
    business: businessId(data),
    title: String(data["title"] || "Sin nombre"),
    on_hand: onHand,
    available,
    reserved,
    in_review: safeQty(data["in_review_qty"]),
    damaged: safeQty(data["damaged_qty"]),
  };
}

function matchesBusiness(data: FirebaseFirestore.DocumentData): boolean {
  return BUSINESS_ARG === "all" || businessId(data) === BUSINESS_ARG;
}

async function deleteDocuments(docs: FirebaseFirestore.QueryDocumentSnapshot[]): Promise<void> {
  const db = admin.firestore();
  for (let offset = 0; offset < docs.length; offset += 400) {
    const batch = db.batch();
    for (const docSnap of docs.slice(offset, offset + 400)) batch.delete(docSnap.ref);
    await batch.commit();
  }
}

async function reconcileReservedOrders(docs: FirebaseFirestore.QueryDocumentSnapshot[]): Promise<number> {
  const db = admin.firestore();
  const nowIso = new Date().toISOString();
  let updated = 0;

  for (let offset = 0; offset < docs.length; offset += 180) {
    const batch = db.batch();
    for (const docSnap of docs.slice(offset, offset + 180)) {
      const data = docSnap.data();
      const currentStatus = String(data["status"] || "");
      const preservesStatus = ["pagado", "closed", "entregado", "delivered"].includes(currentStatus);
      const nextStatus = preservesStatus ? currentStatus : "delivered";
      const eventId = `evt-inventory-reset-${Date.now()}-${docSnap.id}`;
      const deliveredAt = data["delivered_at"] || admin.firestore.FieldValue.serverTimestamp();

      batch.update(docSnap.ref, {
        status: nextStatus,
        delivery_status: "delivered",
        custody_status: "customer",
        current_holder_location: "customer",
        delivered_at: deliveredAt,
        last_event_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.set(docSnap.ref.collection("events").doc(eventId), {
        id: eventId,
        orderId: docSnap.id,
        type: "DELIVERY_RECONCILED_FOR_INVENTORY_RESET",
        message: "Entrega reconciliada antes del reinicio total de inventario",
        meta: {
          previous_status: currentStatus || null,
          next_status: nextStatus,
          payment_unchanged: true,
          source: "scripts/reset-inventory-items.ts",
        },
        actor: { uid: "system", name: "Sistema" },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtIso: nowIso,
      });
      updated += 1;
    }
    await batch.commit();
  }

  return updated;
}

function createBackup(rows: InventoryBackupRow[], orders: InventoryBackupRow[]): string {
  const backupDir = path.resolve(process.cwd(), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `inventory-items-${BUSINESS_ARG}-${timestamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      project_id: PROJECT_ID,
      business: BUSINESS_ARG,
      created_at: new Date().toISOString(),
      inventory_rows: rows,
      linked_orders_before_reconciliation: orders,
    }, null, 2),
    "utf8",
  );
  return backupPath;
}

async function run(): Promise<void> {
  if (APPLY_MODE && BUSINESS_ARG === "all" && !CONFIRM_ALL_BUSINESSES) {
    throw new Error("Para borrar todos los negocios debes agregar --confirm-all-businesses.");
  }

  initFirebaseAdmin();
  const db = admin.firestore();
  const snapshot = await db.collection("inventory_items").get();
  const targets = snapshot.docs.filter((docSnap) => matchesBusiness(docSnap.data()));
  const summaries = targets.map(toSummaryRow);
  const reservations = summaries.filter((row) => row.reserved > 0);
  const reservedOrderIds = new Set(targets.flatMap((docSnap) => reservationOrderIds(docSnap.data())));

  const byBusiness = summaries.reduce<Record<string, number>>((counts, row) => {
    counts[row.business] = (counts[row.business] || 0) + 1;
    return counts;
  }, {});

  console.log(`[inventory-reset] mode=${APPLY_MODE ? "APPLY" : "DRY-RUN"} business=${BUSINESS_ARG}`);
  console.log(`[inventory-reset] targets=${targets.length} reservations=${reservations.length}`);
  console.log(`[inventory-reset] by_business=${JSON.stringify(byBusiness)}`);
  if (!SUMMARY_ONLY) console.table(summaries);

  let reservedOrderDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (reservedOrderIds.size > 0) {
    const orderSnapshot = await db.collection("orders").get();
    reservedOrderDocs = orderSnapshot.docs.filter((docSnap) => reservedOrderIds.has(docSnap.id));
    const orderRows = reservedOrderDocs
      .map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          business: businessId(data),
          status: String(data["status"] || "sin_estado"),
          delivery: String(data["delivery_status"] || "pending"),
          payment: String(data["customer_payment_status"] || "pending"),
          custody: String(data["custody_status"] || "sin_custodia"),
        };
      });
    const foundOrderIds = new Set(orderRows.map((row) => row.id));
    const missingOrders = [...reservedOrderIds].filter((orderId) => !foundOrderIds.has(orderId));
    const byStatus = orderRows.reduce<Record<string, number>>((counts, row) => {
      const key = `${row.status}/${row.delivery}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    console.log(`[inventory-reset] reserved_order_ids=${reservedOrderIds.size} missing_orders=${missingOrders.length}`);
    console.log(`[inventory-reset] reserved_orders_by_status=${JSON.stringify(byStatus)}`);
    console.table(orderRows);
    if (missingOrders.length > 0) console.log(`[inventory-reset] missing_order_ids=${missingOrders.join(",")}`);
  }

  if (!APPLY_MODE) return;
  if (reservations.length > 0 && (!FORCE_RESERVED || !RECONCILE_DELIVERY)) {
    console.table(reservations);
    throw new Error("Hay reservas activas. Para un reinicio confirmado usa --force-reserved --reconcile-delivery.");
  }
  if (targets.length === 0) return;

  const backupRows: InventoryBackupRow[] = targets.map((docSnap) => ({
    document_id: docSnap.id,
    data: docSnap.data(),
  }));
  const orderBackupRows: InventoryBackupRow[] = reservedOrderDocs.map((docSnap) => ({
    document_id: docSnap.id,
    data: docSnap.data(),
  }));
  const backupPath = createBackup(backupRows, orderBackupRows);
  const reconciledOrders = reservations.length > 0
    ? await reconcileReservedOrders(reservedOrderDocs)
    : 0;
  await deleteDocuments(targets);

  const verification = await db.collection("inventory_items").get();
  const remaining = verification.docs.filter((docSnap) => matchesBusiness(docSnap.data())).length;
  console.log(`[inventory-reset] deleted=${targets.length} remaining=${remaining}`);
  console.log(`[inventory-reset] reconciled_orders=${reconciledOrders} payment_fields_changed=0`);
  console.log(`[inventory-reset] backup=${backupPath}`);
  if (remaining > 0) throw new Error(`La verificación encontró ${remaining} registros restantes.`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[inventory-reset] failed: ${message}`);
  process.exitCode = 1;
});
