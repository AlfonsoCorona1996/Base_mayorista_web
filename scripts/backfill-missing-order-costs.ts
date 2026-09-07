/**
 * Completa costos faltantes de artículos históricos de BM.
 *
 * Regla autorizada: price_cost = 50% de price_clienta.
 * Solo afecta artículos reconocidos con costo vacío/cero y nunca sobrescribe
 * un costo existente.
 *
 * Uso:
 *   npx tsx scripts/backfill-missing-order-costs.ts
 *   npx tsx scripts/backfill-missing-order-costs.ts --apply
 */

import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  calculateOrderFinancials,
  money,
  recognizedItemQty,
} from "../src/app/core/order-financials";

type OrderItemRow = {
  item_id?: string;
  title?: string;
  price_clienta?: number | null;
  price_cost?: number | null;
  [key: string]: unknown;
};

type OrderRow = {
  order_id?: string;
  business_id?: string;
  status?: string;
  items?: OrderItemRow[];
  totals?: Record<string, unknown>;
  [key: string]: unknown;
};

type Change = {
  itemIndex: number;
  itemId: string;
  title: string;
  quantity: number;
  clientPrice: number;
  oldCost: number | null;
  newCost: number;
};

type OrderUpdate = {
  docId: string;
  orderId: string;
  original: OrderRow;
  updatedItems: OrderItemRow[];
  changes: Change[];
  oldCostTotal: number;
  newCostTotal: number;
  oldProfit: number;
  newProfit: number;
};

const PROJECT_ID = "base-mayorista";
const APPLY_MODE = process.argv.includes("--apply");
const EXCLUDED_STATUSES = new Set(["cancelado", "devuelto"]);

function findCredential(): string {
  const candidates = [
    process.env["FIREBASE_SERVICE_ACCOUNT"],
    process.env["FIREBASE_SERVICE_ACCOUNT_PATH"],
    process.env["GOOGLE_APPLICATION_CREDENTIALS"],
    path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
    path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  const found = candidates.find((value) => fs.existsSync(value));
  if (!found) throw new Error("No se encontró la credencial Firebase.");
  return found;
}

function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? money(parsed) : null;
}

function proposedUpdate(docId: string, data: OrderRow): OrderUpdate | null {
  const businessId = data.business_id === "catalogo" ? "catalogo" : "bm";
  const status = String(data.status || "borrador").trim().toLowerCase();
  if (businessId !== "bm" || EXCLUDED_STATUSES.has(status)) return null;

  const items = Array.isArray(data.items) ? data.items : [];
  const changes: Change[] = [];
  const updatedItems = items.map((item, itemIndex) => {
    const oldCost = nullableMoney(item.price_cost);
    const clientPrice = Math.max(0, money(item.price_clienta));
    const quantity = recognizedItemQty(item);
    if ((oldCost ?? 0) > 0 || clientPrice <= 0 || quantity <= 0) return item;

    const newCost = money(clientPrice * 0.5);
    changes.push({
      itemIndex,
      itemId: String(item.item_id || `index-${itemIndex}`),
      title: String(item.title || "Artículo sin nombre"),
      quantity,
      clientPrice,
      oldCost,
      newCost,
    });
    return { ...item, price_cost: newCost };
  });

  if (changes.length === 0) return null;
  const oldFinancials = calculateOrderFinancials({ items, totals: data.totals || {} });
  const newFinancials = calculateOrderFinancials({ items: updatedItems, totals: data.totals || {} });
  return {
    docId,
    orderId: String(data.order_id || docId),
    original: data,
    updatedItems,
    changes,
    oldCostTotal: oldFinancials.netCost,
    newCostTotal: newFinancials.netCost,
    oldProfit: oldFinancials.grossProfit,
    newProfit: newFinancials.grossProfit,
  };
}

async function run(): Promise<void> {
  const serviceAccount = JSON.parse(fs.readFileSync(findCredential(), "utf8")) as admin.ServiceAccount;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
  }

  const db = admin.firestore();
  const snapshot = await db.collection("orders").get();
  const updates = snapshot.docs
    .map((doc) => proposedUpdate(doc.id, doc.data() as OrderRow))
    .filter((row): row is OrderUpdate => Boolean(row));

  const itemCount = updates.reduce((sum, row) => sum + row.changes.length, 0);
  const unitCount = updates.reduce(
    (sum, row) => sum + row.changes.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const addedCost = money(updates.reduce((sum, row) => sum + row.newCostTotal - row.oldCostTotal, 0));

  console.log(`[missing-costs] modo=${APPLY_MODE ? "APPLY" : "DRY-RUN"}`);
  console.log(`[missing-costs] pedidos=${updates.length}, artículos=${itemCount}, unidades=${unitCount}`);
  console.log(`[missing-costs] costo a incorporar=$${addedCost.toFixed(2)}`);
  for (const row of updates) {
    console.log(`\n${row.orderId}: utilidad $${row.oldProfit.toFixed(2)} -> $${row.newProfit.toFixed(2)}`);
    for (const change of row.changes) {
      console.log(
        `  ${change.itemId} | ${change.title} | ${change.quantity} u. | ` +
        `clienta $${change.clientPrice.toFixed(2)} -> costo $${change.newCost.toFixed(2)}`,
      );
    }
  }

  if (!APPLY_MODE) {
    console.log("\nDry-run terminado. No se modificó Firestore.");
    return;
  }
  if (updates.length === 0) {
    console.log("\nNo hay costos faltantes por actualizar.");
    return;
  }

  const backupPath = path.resolve(
    __dirname,
    `../backups/missing-order-costs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(
    backupPath,
    JSON.stringify(updates.map((row) => ({
      doc_id: row.docId,
      order_id: row.orderId,
      changes: row.changes,
      original_items: row.original.items,
      original_totals: row.original.totals,
    })), null, 2),
    "utf8",
  );
  console.log(`\n[missing-costs] respaldo=${backupPath}`);

  const batch = db.batch();
  for (const row of updates) {
    const recalculated = calculateOrderFinancials({
      items: row.updatedItems,
      totals: row.original.totals || {},
    });
    batch.update(db.collection("orders").doc(row.docId), {
      items: row.updatedItems,
      "totals.cost_amount": recalculated.netCost,
      "totals.gross_profit": recalculated.grossProfit,
      missing_cost_backfill: {
        rule: "50_percent_price_clienta",
        item_count: row.changes.length,
        applied_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  console.log(`[missing-costs] aplicados=${updates.length} pedidos, ${itemCount} artículos, ${unitCount} unidades.`);
}

run().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
