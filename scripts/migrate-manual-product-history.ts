/**
 * Manual product history backfill migration.
 *
 * Goal:
 * - Read legacy manual items from orders/*.
 * - Seed missing docs into manual_product_suggestions so autocomplete
 *   can suggest products that existed before the feature was implemented.
 *
 * Usage:
 *   npx tsx scripts/migrate-manual-product-history.ts
 *   npx tsx scripts/migrate-manual-product-history.ts --apply
 *   npx tsx scripts/migrate-manual-product-history.ts --apply --before=2026-03-01
 *   npx tsx scripts/migrate-manual-product-history.ts --limit-orders=300
 *
 * Notes:
 * - Default mode is dry-run.
 * - Creates missing titles and backfills image_url / price_public on existing titles when missing.
 * - --before is exclusive and interpreted as UTC date start (YYYY-MM-DDT00:00:00Z).
 */

import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const DEFAULT_SERVICE_ACCOUNT_PATH = path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json");

const APPLY_MODE = process.argv.includes("--apply");
const HELP_MODE = process.argv.includes("--help") || process.argv.includes("-h");
const LIMIT_ORDERS = Number(readArgValue("--limit-orders") || "0");
const BEFORE_ARG = readArgValue("--before");

const ORDERS_PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 350;

type AnyRecord = Record<string, unknown>;

type AggregatedManualEntry = {
  normalizedTitle: string;
  title: string;
  variant: string;
  color: string;
  imageUrl: string | null;
  pricePublic: number | null;
  priceClienta: number | null;
  priceCost: number | null;
  usedCount: number;
  firstUsedAt: Date;
  lastUsedAt: Date;
  payloadUpdatedAt: Date;
};

function readArgValue(flag: string): string | null {
  const exact = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);
  const index = process.argv.findIndex((entry) => entry === flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return null;
}

function printHelp(): void {
  console.log("Manual product history backfill migration");
  console.log("");
  console.log("Usage:");
  console.log("  npx tsx scripts/migrate-manual-product-history.ts");
  console.log("  npx tsx scripts/migrate-manual-product-history.ts --apply");
  console.log("  npx tsx scripts/migrate-manual-product-history.ts --apply --before=2026-03-01");
  console.log("  npx tsx scripts/migrate-manual-product-history.ts --limit-orders=300");
  console.log("");
  console.log("Flags:");
  console.log("  --apply                Writes changes. Default mode is dry-run.");
  console.log("  --before=YYYY-MM-DD    Optional exclusive UTC cutoff for orders updated_at.");
  console.log("  --limit-orders=<n>     Optional max number of orders to scan (for testing).");
}

function initFirebaseAdmin(): void {
  if (admin.apps.length) return;

  if (fs.existsSync(DEFAULT_SERVICE_ACCOUNT_PATH)) {
    const serviceAccount = require(DEFAULT_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    console.log(`[manual-history-backfill] credential: service account (${DEFAULT_SERVICE_ACCOUNT_PATH})`);
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: PROJECT_ID });
    console.log("[manual-history-backfill] credential: GOOGLE_APPLICATION_CREDENTIALS");
    return;
  }

  throw new Error(
    `No se encontro credencial Firebase. Esperado: ${DEFAULT_SERVICE_ACCOUNT_PATH} o GOOGLE_APPLICATION_CREDENTIALS.`,
  );
}

function cleanString(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(title: string): string {
  return cleanString(title).toLowerCase();
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const asRecord = value as { toDate?: unknown };
  if (typeof asRecord.toDate === "function") {
    const date = (asRecord.toDate as () => Date)();
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const asNum = Number(value);
  if (!Number.isFinite(asNum)) return null;
  return asNum;
}

function parseBeforeCutoff(arg: string | null): Date | null {
  if (!arg) return null;
  const parsed = new Date(`${arg}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Fecha invalida para --before: "${arg}". Formato esperado YYYY-MM-DD.`);
  }
  return parsed;
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function slugify(input: string): string {
  const ascii = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return ascii || "manual";
}

function makeManualSuggestionId(normalizedTitle: string): string {
  const slug = slugify(normalizedTitle).slice(0, 72);
  const hash = hashText(normalizedTitle);
  return `mp_legacy_${slug}_${hash}`;
}

function selectOrderDate(orderData: AnyRecord): Date {
  return toDate(orderData["updated_at"]) ?? toDate(orderData["created_at"]) ?? new Date();
}

function upsertAggregate(
  aggregate: Map<string, AggregatedManualEntry>,
  itemData: AnyRecord,
  observedAt: Date,
): { accepted: boolean; normalizedTitle?: string } {
  const title = cleanString(itemData["title"]);
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) {
    return { accepted: false };
  }

  const variant = cleanString(itemData["variant"]);
  const color = cleanString(itemData["color"]);
  const imageUrl = cleanString(itemData["image_url"]) || null;
  const pricePublic = toNumberOrNull(itemData["price_public"]);
  const priceClienta = toNumberOrNull(itemData["price_clienta"]);
  const priceCost = toNumberOrNull(itemData["price_cost"]);

  const current = aggregate.get(normalizedTitle);
  if (!current) {
    aggregate.set(normalizedTitle, {
      normalizedTitle,
      title,
      variant,
      color,
      imageUrl,
      pricePublic,
      priceClienta,
      priceCost,
      usedCount: 1,
      firstUsedAt: observedAt,
      lastUsedAt: observedAt,
      payloadUpdatedAt: observedAt,
    });
    return { accepted: true, normalizedTitle };
  }

  current.usedCount += 1;
  if (observedAt.getTime() < current.firstUsedAt.getTime()) current.firstUsedAt = observedAt;
  if (observedAt.getTime() > current.lastUsedAt.getTime()) current.lastUsedAt = observedAt;

  if (observedAt.getTime() >= current.payloadUpdatedAt.getTime()) {
    current.title = title || current.title;
    if (variant) current.variant = variant;
    if (color) current.color = color;
    if (imageUrl) current.imageUrl = imageUrl;
    if (pricePublic != null) current.pricePublic = pricePublic;
    if (priceClienta != null) current.priceClienta = priceClienta;
    if (priceCost != null) current.priceCost = priceCost;
    current.payloadUpdatedAt = observedAt;
  }

  return { accepted: true, normalizedTitle };
}

async function run(): Promise<void> {
  if (HELP_MODE) {
    printHelp();
    return;
  }

  if (LIMIT_ORDERS < 0 || Number.isNaN(LIMIT_ORDERS)) {
    throw new Error(`Valor invalido en --limit-orders: "${String(LIMIT_ORDERS)}"`);
  }

  const beforeCutoff = parseBeforeCutoff(BEFORE_ARG);
  const modeLabel = APPLY_MODE ? "APPLY" : "DRY-RUN";
  console.log(`[manual-history-backfill] mode=${modeLabel}`);
  if (beforeCutoff) {
    console.log(`[manual-history-backfill] beforeCutoff(UTC-exclusive)=${beforeCutoff.toISOString()}`);
  }
  if (LIMIT_ORDERS > 0) {
    console.log(`[manual-history-backfill] limitOrders=${LIMIT_ORDERS}`);
  }

  initFirebaseAdmin();

  const db = admin.firestore();
  const ordersCol = db.collection("orders");
  const suggestionsCol = db.collection("manual_product_suggestions");

  const existingSnap = await suggestionsCol.get();
  const existingTitleSet = new Set<string>();
  const existingIdSet = new Set<string>();
  const existingByTitle = new Map<
    string,
    { id: string; ref: FirebaseFirestore.DocumentReference; data: AnyRecord }
  >();

  for (const docSnap of existingSnap.docs) {
    existingIdSet.add(docSnap.id);
    const data = (docSnap.data() || {}) as AnyRecord;
    const normalized = normalizeTitle(cleanString(data["title"]));
    if (normalized) {
      existingTitleSet.add(normalized);
      if (!existingByTitle.has(normalized)) {
        existingByTitle.set(normalized, { id: docSnap.id, ref: docSnap.ref, data });
      }
    }
  }

  console.log(`[manual-history-backfill] existingSuggestions=${existingSnap.size}`);
  console.log(`[manual-history-backfill] existingUniqueTitles=${existingTitleSet.size}`);

  const aggregate = new Map<string, AggregatedManualEntry>();
  let scannedOrders = 0;
  let scannedManualItems = 0;
  let rejectedManualItems = 0;
  let skippedByCutoff = 0;

  let lastDocId: string | null = null;
  let keepPaging = true;

  while (keepPaging) {
    let pageQuery = ordersCol.orderBy(admin.firestore.FieldPath.documentId()).limit(ORDERS_PAGE_SIZE);
    if (lastDocId) {
      pageQuery = pageQuery.startAfter(lastDocId);
    }

    const pageSnap = await pageQuery.get();
    if (pageSnap.empty) break;

    for (const orderDoc of pageSnap.docs) {
      scannedOrders += 1;

      const orderData = (orderDoc.data() || {}) as AnyRecord;
      const observedAt = selectOrderDate(orderData);
      if (beforeCutoff && observedAt.getTime() >= beforeCutoff.getTime()) {
        skippedByCutoff += 1;
      } else {
        const items = Array.isArray(orderData["items"]) ? (orderData["items"] as unknown[]) : [];
        for (const rawItem of items) {
          if (!rawItem || typeof rawItem !== "object") continue;
          const itemData = rawItem as AnyRecord;
          const source = cleanString(itemData["source"]).toLowerCase();
          if (source !== "manual") continue;
          scannedManualItems += 1;
          const merged = upsertAggregate(aggregate, itemData, observedAt);
          if (!merged.accepted) rejectedManualItems += 1;
        }
      }

      if (LIMIT_ORDERS > 0 && scannedOrders >= LIMIT_ORDERS) {
        keepPaging = false;
        break;
      }
    }

    lastDocId = pageSnap.docs[pageSnap.docs.length - 1]?.id ?? null;
    if (!lastDocId) break;
  }

  const aggregatedEntries = Array.from(aggregate.values());
  const missingEntries = aggregatedEntries.filter((entry) => !existingTitleSet.has(entry.normalizedTitle));
  missingEntries.sort((a, b) => b.usedCount - a.usedCount);
  const patchExistingEntries = aggregatedEntries
    .map((entry) => {
      const existing = existingByTitle.get(entry.normalizedTitle);
      if (!existing) return null;
      const currentPricePublic = toNumberOrNull(existing.data["price_public"]);
      const currentImageUrl = cleanString(existing.data["image_url"]) || null;
      const needsPricePatch = currentPricePublic == null && entry.pricePublic != null;
      const needsImagePatch = !currentImageUrl && !!entry.imageUrl;
      if (!needsPricePatch && !needsImagePatch) return null;
      return { entry, existing, needsPricePatch, needsImagePatch };
    })
    .filter(
      (
        row,
      ): row is {
        entry: AggregatedManualEntry;
        existing: { id: string; ref: FirebaseFirestore.DocumentReference; data: AnyRecord };
        needsPricePatch: boolean;
        needsImagePatch: boolean;
      } => !!row,
    );

  console.log("");
  console.log(`[manual-history-backfill] scannedOrders=${scannedOrders}`);
  console.log(`[manual-history-backfill] skippedOrdersByCutoff=${skippedByCutoff}`);
  console.log(`[manual-history-backfill] scannedManualItems=${scannedManualItems}`);
  console.log(`[manual-history-backfill] rejectedManualItems(no-title)=${rejectedManualItems}`);
  console.log(`[manual-history-backfill] aggregatedUniqueManualTitles=${aggregatedEntries.length}`);
  console.log(`[manual-history-backfill] missingTitlesToSeed=${missingEntries.length}`);
  const imagePatchCount = patchExistingEntries.filter((row) => row.needsImagePatch).length;
  const pricePatchCount = patchExistingEntries.filter((row) => row.needsPricePatch).length;
  console.log(`[manual-history-backfill] existingTitlesToPatchPricePublic=${pricePatchCount}`);
  console.log(`[manual-history-backfill] existingTitlesToPatchImage=${imagePatchCount}`);

  const sample = missingEntries.slice(0, 20);
  if (sample.length > 0) {
    console.log("[manual-history-backfill] sample missing titles:");
    for (const row of sample) {
      console.log(
        `- ${row.title} | uses=${row.usedCount} | variant=${row.variant || "-"} | color=${row.color || "-"}`,
      );
    }
  }

  if (!APPLY_MODE) {
    console.log("");
    console.log("[manual-history-backfill] dry-run only. Re-run with --apply to write changes.");
    return;
  }

  if (missingEntries.length === 0 && patchExistingEntries.length === 0) {
    console.log("");
    console.log("[manual-history-backfill] nothing to write.");
    return;
  }

  let created = 0;
  let patchedPricePublic = 0;
  let patchedImageUrl = 0;
  let skippedIdCollision = 0;
  let batch = db.batch();
  let ops = 0;
  const commits: Promise<unknown>[] = [];

  for (const entry of missingEntries) {
    const docId = makeManualSuggestionId(entry.normalizedTitle);
    if (existingIdSet.has(docId)) {
      skippedIdCollision += 1;
      continue;
    }

    const ref = suggestionsCol.doc(docId);
    batch.set(ref, {
      id: docId,
      title: entry.title,
      variant: entry.variant,
      color: entry.color,
      image_url: entry.imageUrl,
      price_public: entry.pricePublic,
      price_clienta: entry.priceClienta,
      price_cost: entry.priceCost,
      used_count: entry.usedCount,
      last_used_at: admin.firestore.Timestamp.fromDate(entry.lastUsedAt),
      created_at: admin.firestore.Timestamp.fromDate(entry.firstUsedAt),
    });

    created += 1;
    existingIdSet.add(docId);
    ops += 1;

    if (ops >= WRITE_BATCH_SIZE) {
      commits.push(batch.commit());
      batch = db.batch();
      ops = 0;
    }
  }

  for (const row of patchExistingEntries) {
    const patch: Record<string, unknown> = {};
    if (row.needsPricePatch) {
      patch.price_public = row.entry.pricePublic;
      patchedPricePublic += 1;
    }
    if (row.needsImagePatch) {
      patch.image_url = row.entry.imageUrl;
      patchedImageUrl += 1;
    }
    batch.update(row.existing.ref, patch);
    ops += 1;
    if (ops >= WRITE_BATCH_SIZE) {
      commits.push(batch.commit());
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    commits.push(batch.commit());
  }
  if (commits.length > 0) {
    await Promise.all(commits);
  }

  console.log("");
  console.log(`[manual-history-backfill] created=${created}`);
  console.log(`[manual-history-backfill] patchedPricePublic=${patchedPricePublic}`);
  console.log(`[manual-history-backfill] patchedImageUrl=${patchedImageUrl}`);
  console.log(`[manual-history-backfill] skippedIdCollision=${skippedIdCollision}`);
  console.log(`[manual-history-backfill] commits=${commits.length}`);
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[manual-history-backfill] failed: ${message}`);
    process.exit(1);
  });
