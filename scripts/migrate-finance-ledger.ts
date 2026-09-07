/**
 * Auditoría y migración del libro financiero.
 *
 * Uso seguro (predeterminado):
 *   npx tsx scripts/migrate-finance-ledger.ts
 *
 * La escritura se bloquea mientras existan movimientos sin cuenta o cobros sin
 * fecha. No se inventan meses históricos. Después de conciliar esos datos:
 *   npx tsx scripts/migrate-finance-ledger.ts --apply --allow-ambiguous
 */
import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

type BusinessId = "bm" | "catalogo";
type Row = FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>;

const PROJECT_ID = "base-mayorista";
const APPLY = process.argv.includes("--apply");
const ALLOW_AMBIGUOUS = process.argv.includes("--allow-ambiguous");
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];

function argValue(name: string): string | null {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1] || null;
  const prefix = process.argv.find((value) => value.startsWith(`${name}=`));
  return prefix ? prefix.slice(name.length + 1) : null;
}

function credentialsPath(): string {
  const candidates = [
    argValue("--credentials"),
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...DEFAULT_SERVICE_ACCOUNT_PATHS,
  ].map((value) => String(value || "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const match = candidates.map((value) => path.resolve(value)).find((value) => fs.existsSync(value));
  if (!match) throw new Error("No se encontró la credencial Firebase. Usa --credentials <ruta>.");
  return match;
}

function business(value: unknown): BusinessId {
  return value === "catalogo" ? "catalogo" : "bm";
}

function amount(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function generalAccountId(businessId: BusinessId): string {
  return businessId === "bm" ? "acc_caja_general" : "acc_catalogo_general";
}

function ledgerPayload(input: {
  id: string;
  businessId: BusinessId;
  accountId: string | null;
  kind: string;
  cashEffect: number;
  occurredAt: string;
  source: string;
  sourceId: string;
  orderId?: string | null;
  returnId?: string | null;
  quality: "confirmed" | "reconstructed" | "unknown";
  notes?: string | null;
}): Record<string, unknown> {
  return {
    entry_id: input.id,
    business_id: input.businessId,
    account_id: input.accountId,
    kind: input.kind,
    cash_effect: amount(input.cashEffect),
    amount: Math.abs(amount(input.cashEffect)),
    occurred_at: input.occurredAt,
    period_id: input.occurredAt.slice(0, 7),
    source: input.source,
    source_id: input.sourceId,
    order_id: input.orderId || null,
    return_id: input.returnId || null,
    reverses_entry_id: null,
    data_quality: input.quality,
    notes: input.notes || null,
    created_by: "migration",
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function all(db: FirebaseFirestore.Firestore, collectionName: string): Promise<Row[]> {
  return (await db.collection(collectionName).get()).docs;
}

async function run(): Promise<void> {
  const serviceAccount = require(credentialsPath());
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
  const db = admin.firestore();
  const [orders, collections, expenses, withdrawals, refunds, accounts, existingLedger, inventoryMovements] = await Promise.all([
    all(db, "orders"),
    all(db, "order_collection_events"),
    all(db, "finance_expenses"),
    all(db, "finance_withdrawals"),
    all(db, "finance_refunds"),
    all(db, "finance_accounts"),
    all(db, "finance_ledger_entries"),
    all(db, "inventory_movements"),
  ]);
  const existingIds = new Set(existingLedger.map((row) => row.id));
  const planned = new Map<string, Record<string, unknown>>();
  const ambiguous: Array<Record<string, unknown>> = [];
  const collectionAmountByOrder = new Map<string, number>();

  for (const row of collections) {
    const data = row.data();
    const status = String(data["verification_status"] || "confirmed");
    if (status === "rejected" || status === "reported" || status === "difference") continue;
    const businessId = business(data["business_id"]);
    const occurredAt = isoDate(data["cash_occurred_at"])
      || isoDate(data["verified_at"])
      || isoDate(data["created_at"]);
    if (!occurredAt) {
      ambiguous.push({ type: "collection_without_date", id: row.id, order_id: data["order_id"], amount: amount(data["amount"]) });
      continue;
    }
    const eventAmount = Math.max(0, amount(data["amount"]));
    const orderId = String(data["order_id"] || "");
    collectionAmountByOrder.set(orderId, amount((collectionAmountByOrder.get(orderId) || 0) + eventAmount));
    const id = `ledger_collection_${row.id}`;
    if (!existingIds.has(id)) planned.set(id, ledgerPayload({
      id, businessId, accountId: String(data["account_id"] || generalAccountId(businessId)),
      kind: "collection", cashEffect: eventAmount, occurredAt, source: "order_collection",
      sourceId: row.id, orderId, quality: data["cash_occurred_at"] ? "confirmed" : "reconstructed",
      notes: data["note"] || null,
    }));
  }

  for (const row of expenses) {
    const data = row.data();
    if (data["voided_at"]) continue;
    const occurredAt = isoDate(data["occurred_at"]);
    if (!occurredAt) continue;
    const businessId = business(data["business_id"]);
    const accountId = data["account_id"] ? String(data["account_id"]) : null;
    if (!accountId) ambiguous.push({ type: "expense_without_account", id: row.id, category: data["category"], amount: amount(data["amount"]), notes: data["notes"] });
    if (data["category"] === "ajuste" || data["category"] === "perdida") {
      ambiguous.push({ type: "expense_needs_classification", id: row.id, category: data["category"], amount: amount(data["amount"]), notes: data["notes"] });
    }
    const id = `ledger_expense_migration_${row.id}`;
    if (!existingIds.has(id)) planned.set(id, ledgerPayload({
      id, businessId, accountId,
      kind: data["category"] === "compra_inversion" ? "inventory_purchase" : "operating_expense",
      cashEffect: -Math.max(0, amount(data["amount"])), occurredAt, source: "finance_expense",
      sourceId: row.id, orderId: data["order_id"] || null, quality: accountId ? "confirmed" : "unknown",
      notes: data["notes"] || null,
    }));
  }

  for (const row of withdrawals) {
    const data = row.data();
    if (data["voided_at"]) continue;
    const occurredAt = isoDate(data["occurred_at"]);
    if (!occurredAt) continue;
    const businessId = business(data["business_id"]);
    const accountId = data["account_id"] ? String(data["account_id"]) : null;
    if (!accountId) ambiguous.push({ type: "withdrawal_without_account", id: row.id, purpose: data["purpose"], amount: amount(data["amount"]), notes: data["notes"] });
    const partner = data["purpose"] === "socio_blanca" || data["purpose"] === "socio_andrea_pepe";
    const id = `ledger_withdrawal_migration_${row.id}`;
    if (!existingIds.has(id)) planned.set(id, ledgerPayload({
      id, businessId, accountId, kind: partner ? "partner_distribution" : "other_withdrawal",
      cashEffect: -Math.max(0, amount(data["amount"])), occurredAt, source: "finance_withdrawal",
      sourceId: row.id, quality: accountId ? "confirmed" : "unknown", notes: data["notes"] || null,
    }));
  }

  for (const row of refunds) {
    const data = row.data();
    const occurredAt = isoDate(data["occurred_at"]) || isoDate(data["created_at"]);
    if (!occurredAt) continue;
    const businessId = business(data["business_id"]);
    const id = `ledger_refund_${row.id}`;
    if (!existingIds.has(id)) planned.set(id, ledgerPayload({
      id, businessId, accountId: data["account_id"] ? String(data["account_id"]) : null,
      kind: "refund", cashEffect: -Math.max(0, amount(data["amount"])), occurredAt,
      source: "finance_refund", sourceId: row.id, orderId: data["order_id"] || null,
      returnId: data["return_id"] || null, quality: "confirmed", notes: null,
    }));
  }

  let historicalCollectionsWithoutDate = 0;
  let historicalOrdersWithoutDate = 0;
  for (const row of orders) {
    const data = row.data();
    const paid = Math.max(0, amount(data["totals"]?.["paid_amount"]));
    const represented = collectionAmountByOrder.get(row.id) || 0;
    const missing = Math.max(0, amount(paid - represented));
    if (missing <= 0) continue;
    if (isoDate(data["paid_at"])) continue;
    historicalCollectionsWithoutDate += missing;
    historicalOrdersWithoutDate += 1;
    ambiguous.push({ type: "paid_order_without_collection_date", id: row.id, business_id: business(data["business_id"]), amount: missing });
  }

  const deliveredInventoryRefs = new Set<string>();
  for (const row of orders) {
    const data = row.data();
    const delivered = Boolean(data["delivered_at"]) || ["delivered", "delivered_partial", "entregado", "pago_pendiente", "pagado_parcial", "pagado", "closed", "devuelto"].includes(String(data["status"] || ""));
    if (!delivered) continue;
    for (const item of Array.isArray(data["items"]) ? data["items"] : []) {
      if (item?.["inventory_id"]) deliveredInventoryRefs.add(`${row.id}:${String(item["item_id"] || item["inventory_id"])}`);
    }
  }
  const saleMovementRefs = new Set(inventoryMovements.filter((row) => row.data()["type"] === "sale").map((row) => `${String(row.data()["order_id"] || "")}:${String(row.data()["order_item_id"] || row.data()["inventory_id"] || "")}`));
  const missingSaleMovements = [...deliveredInventoryRefs].filter((key) => !saleMovementRefs.has(key));

  const summary = {
    mode: APPLY ? "apply" : "dry-run",
    documents: { orders: orders.length, collections: collections.length, expenses: expenses.length, withdrawals: withdrawals.length, refunds: refunds.length, accounts: accounts.length, ledger: existingLedger.length },
    planned_ledger_entries: planned.size,
    ambiguous_count: ambiguous.length,
    historical_orders_without_collection_date: historicalOrdersWithoutDate,
    historical_amount_without_collection_date: amount(historicalCollectionsWithoutDate),
    delivered_inventory_lines_without_sale_movement: missingSaleMovements.length,
    ambiguous,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!APPLY) {
    console.log("\nDRY-RUN: no se escribió nada.");
    return;
  }
  if (ambiguous.length > 0 && !ALLOW_AMBIGUOUS) {
    throw new Error("Migración bloqueada: hay movimientos ambiguos. Concílialos o usa --allow-ambiguous de forma consciente.");
  }
  const rows = [...planned.entries()];
  for (let index = 0; index < rows.length; index += 400) {
    const batch = db.batch();
    for (const [id, payload] of rows.slice(index, index + 400)) batch.create(db.collection("finance_ledger_entries").doc(id), payload);
    await batch.commit();
  }
  console.log(`Migración aplicada: ${planned.size} entradas. No se modificaron saldos de cuentas ni meses históricos.`);
}

run().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
