/**
 * Repara productos normalizados que quedaron con variantes duplicadas por la
 * fusion controlada (el empate se hacia por SKU y los SKU se generan con el
 * normalized_id, asi que dos documentos nunca coincidian).
 *
 * Funde las variantes que comparten nombre: conserva la primera (SKU original,
 * precios publicados) y le une los color_stock de las duplicadas.
 *
 * Uso:
 *   npx tsx scripts/repair-merged-listing-variants.ts --id=<normalized_id>
 *   npx tsx scripts/repair-merged-listing-variants.ts --id=<normalized_id> --apply
 *   npx tsx scripts/repair-merged-listing-variants.ts --scan
 */

import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const APPLY_MODE = process.argv.includes("--apply");
const SCAN_MODE = process.argv.includes("--scan");
const LOG = "[repair-merged-listing-variants]";
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

function variantKey(item: any): string {
  return String(item?.variant_name || "").trim().toLowerCase();
}

function normalizeSku(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

interface FusedResult {
  items: any[];
  removedSkus: string[];
  fusedGroups: Array<{ name: string; keptSku: string; addedColors: string[]; droppedSkus: string[] }>;
}

function fuseDuplicateVariants(items: any[]): FusedResult {
  const byKey = new Map<string, any>();
  const out: any[] = [];
  const removedSkus: string[] = [];
  const fusedGroups: FusedResult["fusedGroups"] = [];

  for (const item of items) {
    const key = variantKey(item);
    const existing = key ? byKey.get(key) : undefined;

    if (!existing) {
      if (key) byKey.set(key, item);
      out.push(item);
      continue;
    }

    // Duplicada: sus colores se funden en la variante original y se descarta.
    const seen = new Set(
      (existing.color_stock || []).map((entry: any) => String(entry?.color_name || "").trim().toLowerCase())
    );
    const addedColors: string[] = [];

    for (const entry of item.color_stock || []) {
      const name = String(entry?.color_name || "").trim();
      if (!name) continue;
      const colorKey = name.toLowerCase();
      if (seen.has(colorKey)) continue;
      seen.add(colorKey);
      existing.color_stock = [
        ...(existing.color_stock || []),
        { color_name: name, stock_state: entry?.stock_state || existing.stock_state || "in_stock" },
      ];
      addedColors.push(name);
    }

    const droppedSku = String(item?.sku || "").trim();
    if (droppedSku) removedSkus.push(droppedSku);

    const groupName = String(existing.variant_name || "");
    const group = fusedGroups.find((row) => row.name === groupName);
    if (group) {
      group.addedColors.push(...addedColors);
      group.droppedSkus.push(droppedSku);
    } else {
      fusedGroups.push({
        name: groupName,
        keptSku: String(existing.sku || ""),
        addedColors,
        droppedSkus: [droppedSku],
      });
    }
  }

  return { items: out, removedSkus, fusedGroups };
}

async function findSkuReferences(db: FirebaseFirestore.Firestore, skus: string[]): Promise<string[]> {
  const hits: string[] = [];
  const wanted = new Set(skus.map((sku) => normalizeSku(sku)));
  if (wanted.size === 0) return hits;

  for (const sku of skus) {
    for (const [collectionName, field] of [
      ["inventory_items", "sku"],
      ["catalog_products", "sku"],
      ["catalog_barcode_aliases", "sku"],
    ] as Array<[string, string]>) {
      const snap = await db.collection(collectionName).where(field, "==", sku).limit(1).get();
      if (!snap.empty) hits.push(`${collectionName}/${snap.docs[0].id} (${field}=${sku})`);
    }
  }

  // Los pedidos guardan sus items como arreglo dentro del documento.
  const orders = await db.collection("orders").get();
  for (const orderDoc of orders.docs) {
    const items = orderDoc.data()?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (wanted.has(normalizeSku(item?.sku))) hits.push(`orders/${orderDoc.id} (item sku=${item?.sku})`);
    }
  }

  return hits;
}

function duplicateNames(items: any[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const item of items) {
    const key = variantKey(item);
    if (!key) continue;
    if (seen.has(key)) dupes.add(String(item?.variant_name || "").trim());
    seen.add(key);
  }
  return [...dupes];
}

async function scanAll(db: FirebaseFirestore.Firestore): Promise<void> {
  const snap = await db.collection("normalized_listings").get();
  let affected = 0;

  for (const docSnap of snap.docs) {
    const items = docSnap.data()?.listing?.items;
    if (!Array.isArray(items)) continue;
    const dupes = duplicateNames(items);
    if (dupes.length === 0) continue;
    affected += 1;
    console.log(
      `${LOG} afectado ${docSnap.id} | "${docSnap.data()?.listing?.title}" | variantes=${items.length} | duplicadas=${dupes.join(", ")}`
    );
  }

  console.log(`${LOG} scan: revisados=${snap.size} afectados=${affected}`);
}

async function run(): Promise<void> {
  initFirebaseAdmin();
  const db = admin.firestore();

  if (SCAN_MODE) {
    await scanAll(db);
    return;
  }

  const id = argValue("--id");
  if (!id) throw new Error("Falta --id=<normalized_id> (o usa --scan).");

  const ref = db.collection("normalized_listings").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`No existe normalized_listings/${id}`);

  const data = snap.data() as FirebaseFirestore.DocumentData;
  const items = Array.isArray(data?.listing?.items) ? data.listing.items : [];

  const backupDir = argValue("--backup-dir") || process.cwd();
  const backupPath = path.join(backupDir, `backup-${id}-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`${LOG} respaldo escrito en ${backupPath}`);

  const before = items.length;
  const fused = fuseDuplicateVariants(JSON.parse(JSON.stringify(items)));

  console.log(`${LOG} mode=${APPLY_MODE ? "APPLY" : "DRY-RUN"} id=${id}`);
  console.log(`${LOG} variantes: ${before} -> ${fused.items.length}`);
  fused.fusedGroups.forEach((group) => {
    console.log(
      `${LOG}   talla ${group.name}: conserva ${group.keptSku} | +colores [${group.addedColors.join(", ")}] | descarta [${group.droppedSkus.join(", ")}]`
    );
  });

  if (fused.removedSkus.length === 0) {
    console.log(`${LOG} sin variantes duplicadas, nada que hacer`);
    return;
  }

  const references = await findSkuReferences(db, fused.removedSkus);
  if (references.length > 0) {
    console.log(`${LOG} ATENCION: los SKU a descartar estan referenciados:`);
    references.forEach((row) => console.log(`${LOG}   ${row}`));
    if (APPLY_MODE) throw new Error("Abortado: hay referencias a los SKU duplicados.");
  } else {
    console.log(`${LOG} ningun SKU descartado esta referenciado en inventario, catalogo, alias ni pedidos`);
  }

  // Colores globales que dejarian de estar en alguna variante.
  const referencedColors = new Set<string>();
  fused.items.forEach((item: any) => {
    (item.color_stock || []).forEach((entry: any) =>
      referencedColors.add(String(entry?.color_name || "").trim().toLowerCase())
    );
  });
  const orphanColors = (data.product_colors || [])
    .map((color: any) => String(color?.name || "").trim())
    .filter((name: string) => name && !referencedColors.has(name.toLowerCase()));
  if (orphanColors.length > 0) console.log(`${LOG} colores globales sin variante: ${orphanColors.join(", ")}`);

  const nextSkuIndex = [...new Set(fused.items.map((item: any) => normalizeSku(item?.sku)).filter(Boolean))].slice(0, 500);

  if (!APPLY_MODE) {
    console.log(`${LOG} DRY-RUN: no se escribio nada. Repite con --apply para aplicar.`);
    return;
  }

  await ref.set(
    {
      listing: { ...data.listing, items: fused.items },
      variant_skus_normalized: nextSkuIndex,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(`${LOG} aplicado: ${id} quedo con ${fused.items.length} variantes`);
}

run().catch((error) => {
  console.error(`${LOG} failed`, error);
  process.exitCode = 1;
});
