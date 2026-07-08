/**
 * Migración idempotente de devoluciones, inventario y CRM.
 *
 * Dry-run (predeterminado): npm run firebase:migrate-returns-crm:dry
 * Aplicar: npm run firebase:migrate-returns-crm:apply
 * Credencial opcional: -- --credentials "C:\\ruta\\serviceAccountKey.json"
 */
import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";
import { toPersistedOrderTotals } from "../src/app/core/order-financials";

const PROJECT_ID = "base-mayorista";
const APPLY = process.argv.includes("--apply");
const DELIVERED = new Set(["delivered", "delivered_partial", "entregado", "closed", "pago_pendiente", "pagado_parcial", "pagado"]);
const report = {
  ordersRecalculated: 0,
  reservationsConsumed: 0,
  reservationShortages: [] as string[],
  returnMovementsCreated: 0,
  pendingReturns: [] as string[],
  damagedReturns: [] as string[],
  customersScoped: 0,
  customerClones: 0,
  ordersReassigned: 0,
  inventoryLinked: 0,
  permissionsUpdated: 0,
  ambiguousSkus: [] as string[],
  missingSkus: [] as string[],
};

function capabilitiesForRole(role: string): Record<string, boolean> {
  if (role === "admin" || role === "super_admin") return {
    "cap.payments.refund": true,
    "cap.returns.view": true,
    "cap.returns.create": true,
    "cap.returns.approve": true,
    "cap.returns.restock": true,
  };
  if (role === "administrativo") return {
    "cap.returns.view": true,
    "cap.returns.create": true,
    "cap.returns.approve": true,
    "cap.returns.restock": true,
  };
  return {};
}

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

function businessId(value: unknown): "bm" | "catalogo" {
  return value === "catalogo" ? "catalogo" : "bm";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
}

async function recalculateOrders(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection("orders").get();
  const writer = APPLY ? db.bulkWriter() : null;
  for (const order of snap.docs) {
    const data = order.data();
    const totals = toPersistedOrderTotals(data);
    const current = data["totals"] || {};
    const changed = Object.entries(totals).some(([key, value]) => Number(current[key] || 0) !== value);
    if (!changed && data["financial_model_version"] === 2) continue;
    report.ordersRecalculated += 1;
    writer?.set(order.ref, {
      business_id: businessId(data["business_id"]),
      totals,
      has_returns: (data["items"] || []).some((item: any) => Number(item?.returned_qty || 0) > 0),
      financial_model_version: 2,
      financial_migrated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await writer?.close();
  return snap.docs;
}

async function reconcileReservations(db: FirebaseFirestore.Firestore, orders: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const orderMap = new Map(orders.map((entry) => [entry.id, entry.data()]));
  const inventory = await db.collection("inventory_items").get();
  const existingMovements = new Set((await db.collection("inventory_movements").get()).docs.map((entry) => entry.id));
  const writer = APPLY ? db.bulkWriter() : null;
  for (const item of inventory.docs) {
    const data = item.data();
    const reservations = { ...(data["reservations"] || {}) } as Record<string, any>;
    let onHand = Math.max(0, Number(data["on_hand_qty"] ?? data["available_qty"] ?? data["quantity_on_hand"] ?? 0));
    let reserved = Math.max(0, Number(data["reserved_qty"] || 0));
    let changed = false;
    for (const [key, reservation] of Object.entries(reservations)) {
      if (reservation?.status !== "reserved") continue;
      const orderId = String(key).split(":")[0];
      const order = orderMap.get(orderId);
      if (!order || !DELIVERED.has(String(order["status"]))) continue;
      const qty = Math.max(0, Math.trunc(Number(reservation?.qty || 0)));
      if (qty > onHand || qty > reserved) {
        report.reservationShortages.push(`${item.id}: reserva ${key}=${qty}, on_hand=${onHand}, reservado=${reserved}`);
        continue;
      }
      reservations[key] = { ...reservation, status: "consumed", updated_at: new Date().toISOString() };
      onHand -= qty;
      reserved -= qty;
      changed = true;
      report.reservationsConsumed += qty;
      const movementId = safeId(`migration_sale_${item.id}_${key}`);
      if (!existingMovements.has(movementId)) writer?.set(db.collection("inventory_movements").doc(movementId), {
        movement_id: movementId,
        business_id: businessId(data["business_id"]),
        inventory_id: item.id,
        type: "sale",
        delta_on_hand: -qty,
        delta_available: 0,
        delta_reserved: -qty,
        delta_in_review: 0,
        delta_damaged: 0,
        order_id: orderId,
        order_item_id: null,
        return_id: null,
        reason: "Conciliación histórica de entrega",
        actor: "migration",
        idempotency_key: movementId,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    if (changed) writer?.set(item.ref, {
      on_hand_qty: onHand,
      reserved_qty: reserved,
      available_qty: Math.max(0, onHand - reserved),
      quantity_on_hand: Math.max(0, onHand - reserved),
      reservations,
      reservation_migrated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await writer?.close();
}

async function migrateReturns(db: FirebaseFirestore.Firestore) {
  const returns = await db.collection("returns").get();
  const existingMovements = new Set((await db.collection("inventory_movements").get()).docs.map((entry) => entry.id));
  const writer = APPLY ? db.bulkWriter() : null;
  for (const row of returns.docs) {
    const data = row.data();
    const status = String(data["status"] || "pending_review");
    if (status === "pending_review") report.pendingReturns.push(row.id);
    if (status === "damaged") report.damagedReturns.push(row.id);
    writer?.set(row.ref, {
      business_id: businessId(data["business_id"]),
      inventory_bucket: status === "pending_review" ? "in_review" : status === "damaged" ? "damaged" : "available",
      inventory_reconciliation_required: status === "pending_review" && !data["inventory_migrated_at"],
      return_model_version: 2,
    }, { merge: true });
    const inventoryId = String(data["inventory_id"] || "");
    if (!inventoryId) continue;
    const movementId = safeId(`migration_return_${row.id}`);
    if (existingMovements.has(movementId)) continue;
    report.returnMovementsCreated += 1;
    writer?.set(db.collection("inventory_movements").doc(movementId), {
      movement_id: movementId,
      business_id: businessId(data["business_id"]),
      inventory_id: inventoryId,
      type: status === "damaged" ? "damage" : "return",
      delta_on_hand: 0,
      delta_available: 0,
      delta_reserved: 0,
      delta_in_review: 0,
      delta_damaged: 0,
      order_id: data["order_id"] || null,
      order_item_id: data["item_id"] || null,
      return_id: row.id,
      reason: "Histórico importado sin alterar existencias; requiere conciliación si estaba pendiente",
      actor: "migration",
      idempotency_key: movementId,
      created_at: data["created_at"] || admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await writer?.close();
}

async function scopeCustomers(db: FirebaseFirestore.Firestore, orders: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const customers = await db.collection("customers").get();
  const ordersByCustomer = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const order of orders) {
    const customerId = String(order.data()["customer_id"] || "");
    if (!customerId) continue;
    ordersByCustomer.set(customerId, [...(ordersByCustomer.get(customerId) || []), order]);
  }
  const writer = APPLY ? db.bulkWriter() : null;
  for (const customer of customers.docs) {
    const data = customer.data();
    const related = ordersByCustomer.get(customer.id) || [];
    const businesses = new Set(related.map((order) => businessId(order.data()["business_id"])));
    if (!businesses.size) businesses.add("bm");
    const primary = businesses.has("bm") ? "bm" : [...businesses][0];
    writer?.set(customer.ref, { business_id: primary, crm_model_version: 2 }, { merge: true });
    report.customersScoped += 1;
    for (const business of businesses) {
      const targetId = business === primary ? customer.id : safeId(`${business}__${customer.id}`);
      if (targetId !== customer.id) {
        report.customerClones += 1;
        writer?.set(db.collection("customers").doc(targetId), {
          ...data,
          customer_id: targetId,
          business_id: business,
          insights: null,
          credit_balance: 0,
          source_customer_id: customer.id,
          crm_model_version: 2,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      for (const order of related.filter((entry) => businessId(entry.data()["business_id"]) === business)) {
        if (String(order.data()["customer_id"]) === targetId) continue;
        report.ordersReassigned += 1;
        writer?.set(order.ref, { customer_id: targetId }, { merge: true });
      }
    }
  }
  await writer?.close();
}

async function linkInventoryProducts(db: FirebaseFirestore.Firestore) {
  const listings = await db.collection("normalized_listings").get();
  const candidates = new Map<string, Array<{ productId: string; variantId: string }>>();
  const variantsByProduct = new Map<string, Array<{ variantId: string; name: string; sku: string }>>();
  for (const listing of listings.docs) {
    const productVariants: Array<{ variantId: string; name: string; sku: string }> = [];
    for (const variant of listing.data()?.listing?.items || []) {
      const sku = String(variant?.sku || "").trim().toLowerCase();
      productVariants.push({ variantId: String(variant?.variant_id || ""), name: String(variant?.variant_name || "").trim().toLowerCase(), sku });
      if (!sku) continue;
      candidates.set(sku, [...(candidates.get(sku) || []), { productId: listing.id, variantId: String(variant?.variant_id || "") }]);
    }
    variantsByProduct.set(listing.id, productVariants);
  }
  const inventory = await db.collection("inventory_items").get();
  const writer = APPLY ? db.bulkWriter() : null;
  for (const item of inventory.docs) {
    const data = item.data();
    if (data["product_id"] && data["variant_id"]) continue;
    const sku = String(data["sku"] || "").trim().toLowerCase();
    let matches = candidates.get(sku) || [];
    const embeddedProductId = [...variantsByProduct.keys()].find((productId) => item.id.includes(productId));
    const knownProductId = variantsByProduct.has(String(data["product_id"] || "")) ? String(data["product_id"]) : embeddedProductId;
    if (matches.length === 0 && knownProductId) {
      const name = String(data["variant_name"] || data["size_label"] || "").trim().toLowerCase();
      const variants = variantsByProduct.get(knownProductId) || [];
      const byName = name ? variants.filter((variant) => variant.name === name) : [];
      if (byName.length === 1) matches = [{ productId: knownProductId, variantId: byName[0].variantId }];
      else if (variants.length === 1) matches = [{ productId: knownProductId, variantId: variants[0].variantId }];
      else if (data["variant_id"]) matches = [{ productId: knownProductId, variantId: String(data["variant_id"]) }];
      else report.ambiguousSkus.push(`${item.id}: producto ${knownProductId}, variante no determinada`);
    }
    if (!sku && matches.length === 0) { report.missingSkus.push(item.id); continue; }
    if (matches.length !== 1) {
      if (matches.length > 1) report.ambiguousSkus.push(`${sku}: ${matches.map((row) => row.productId).join(", ")}`);
      else if (!knownProductId) report.missingSkus.push(`${item.id} (${sku})`);
      continue;
    }
    report.inventoryLinked += 1;
    writer?.set(item.ref, { product_id: matches[0].productId, variant_id: matches[0].variantId || null, sku_link_migrated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  await writer?.close();
}

async function migratePermissions(db: FirebaseFirestore.Firestore) {
  const writer = APPLY ? db.bulkWriter() : null;
  for (const collectionName of ["users", "roles"]) {
    const snap = await db.collection(collectionName).get();
    for (const row of snap.docs) {
      const data = row.data();
      const role = String(data["roleId"] || row.id || "operativo");
      const additions = capabilitiesForRole(role);
      const memberships = { ...(data["businessMemberships"] || {}) } as Record<string, any>;
      let needsUpdate = Object.entries(additions).some(([key, value]) => data["capabilities"]?.[key] !== value);
      for (const [id, membership] of Object.entries(memberships)) {
        const membershipAdditions = capabilitiesForRole(String(membership?.roleId || role));
        if (Object.entries(membershipAdditions).some(([key, value]) => membership?.capabilities?.[key] !== value)) needsUpdate = true;
        memberships[id] = { ...membership, capabilities: { ...(membership?.capabilities || {}), ...membershipAdditions } };
      }
      if (!needsUpdate) continue;
      report.permissionsUpdated += 1;
      writer?.set(row.ref, {
        capabilities: { ...(data["capabilities"] || {}), ...additions },
        ...(Object.keys(memberships).length ? { businessMemberships: memberships } : {}),
        permissions_returns_v2_migrated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
  await writer?.close();
}

async function run() {
  console.log(`[returns-inventory-crm] modo=${APPLY ? "APPLY" : "DRY-RUN"}`);
  initAdmin();
  const db = admin.firestore();
  const orders = await recalculateOrders(db);
  await reconcileReservations(db, orders);
  await migrateReturns(db);
  await scopeCustomers(db, orders);
  await linkInventoryProducts(db);
  await migratePermissions(db);
  const reportJson = JSON.stringify(report, null, 2);
  const reportDir = path.resolve(process.cwd(), "migration-reports");
  const reportPath = path.join(reportDir, `returns-inventory-crm-${APPLY ? "apply" : "dry-run"}.json`);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${reportJson}\n`, "utf8");
  console.log(reportJson);
  console.log(`[returns-inventory-crm] reporte=${reportPath}`);
  if (!APPLY) console.log("Dry-run: no se escribió ningún documento. Revisa las anomalías antes de usar --apply.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
