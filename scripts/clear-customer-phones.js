#!/usr/bin/env node
"use strict";

/**
 * Clear customer phone fields in Firebase (customers collection).
 *
 * Dry-run (default):
 *   node scripts/clear-customer-phones.js
 *
 * Apply changes:
 *   node scripts/clear-customer-phones.js --apply
 *
 * Optional flags:
 *   --limit=100         Only process first N customers (for testing)
 *   --service-account="C:\\path\\to\\serviceAccountKey.json"
 */

const fs = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");

const DEFAULT_PROJECT_ID = "base-mayorista";
const DEFAULT_SERVICE_ACCOUNT_PATH = path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json");
const BATCH_SIZE = 350;

function readArgValue(flag) {
  const exact = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);
  const index = process.argv.findIndex((entry) => entry === flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return null;
}

function showHelp() {
  console.log("Clear customer phone fields (Firebase)");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/clear-customer-phones.js");
  console.log("  node scripts/clear-customer-phones.js --apply");
  console.log("  node scripts/clear-customer-phones.js --apply --limit=50");
  console.log("  node scripts/clear-customer-phones.js --apply --service-account=../whatsapp-bot/serviceAccountKey.json");
  console.log("");
  console.log("Flags:");
  console.log("  --apply             Write updates (default is dry-run)");
  console.log("  --limit=<n>         Process only first N customers");
  console.log("  --service-account   Path to service account json file");
  console.log("  --help              Show this help");
}

function toSafeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function initFirebaseAdmin(serviceAccountPath) {
  if (admin.apps.length > 0) return;

  if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: DEFAULT_PROJECT_ID,
    });
    console.log(`[clear-customer-phones] credential: service account (${serviceAccountPath})`);
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: DEFAULT_PROJECT_ID });
    console.log("[clear-customer-phones] credential: GOOGLE_APPLICATION_CREDENTIALS");
    return;
  }

  throw new Error(
    `No Firebase credential found. Expected service account at ${serviceAccountPath} or GOOGLE_APPLICATION_CREDENTIALS.`,
  );
}

function buildPhonePatch(data) {
  const patch = {
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  let touched = false;

  if (Object.prototype.hasOwnProperty.call(data, "whatsapp")) {
    patch.whatsapp = "";
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(data, "phone")) {
    patch.phone = "";
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(data, "telefono")) {
    patch.telefono = "";
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(data, "phone_number")) {
    patch.phone_number = "";
    touched = true;
  }

  // Main schema in this project uses "whatsapp".
  if (!touched) {
    patch.whatsapp = "";
    touched = true;
  }

  return touched ? patch : null;
}

async function run() {
  const helpMode = process.argv.includes("--help") || process.argv.includes("-h");
  if (helpMode) {
    showHelp();
    return;
  }

  const applyMode = process.argv.includes("--apply");
  const limitRaw = readArgValue("--limit");
  const limit = limitRaw ? Number(limitRaw) : 0;
  if (limitRaw && (!Number.isFinite(limit) || limit < 0)) {
    throw new Error(`Invalid --limit value: ${limitRaw}`);
  }

  const serviceAccountArg = readArgValue("--service-account");
  const serviceAccountPath = path.resolve(process.cwd(), serviceAccountArg || DEFAULT_SERVICE_ACCOUNT_PATH);

  console.log(`[clear-customer-phones] mode=${applyMode ? "APPLY" : "DRY-RUN"}`);
  if (limit > 0) console.log(`[clear-customer-phones] limit=${limit}`);

  initFirebaseAdmin(serviceAccountPath);

  const db = admin.firestore();
  const customersCol = db.collection("customers");

  const snap = await customersCol.get();
  const docs = limit > 0 ? snap.docs.slice(0, limit) : snap.docs;

  let withWhatsapp = 0;
  let withPhone = 0;
  let withTelefono = 0;
  let withPhoneNumber = 0;

  const updates = [];

  for (const docSnap of docs) {
    const data = docSnap.data() || {};
    const whatsapp = toSafeString(data.whatsapp);
    const phone = toSafeString(data.phone);
    const telefono = toSafeString(data.telefono);
    const phoneNumber = toSafeString(data.phone_number);

    if (whatsapp) withWhatsapp += 1;
    if (phone) withPhone += 1;
    if (telefono) withTelefono += 1;
    if (phoneNumber) withPhoneNumber += 1;

    const patch = buildPhonePatch(data);
    if (patch) {
      updates.push({ ref: docSnap.ref, patch, id: docSnap.id, whatsapp, phone, telefono, phoneNumber });
    }
  }

  console.log("");
  console.log(`[clear-customer-phones] totalCustomersRead=${docs.length}`);
  console.log(`[clear-customer-phones] docsToUpdate=${updates.length}`);
  console.log(`[clear-customer-phones] nonEmpty.whatsapp=${withWhatsapp}`);
  console.log(`[clear-customer-phones] nonEmpty.phone=${withPhone}`);
  console.log(`[clear-customer-phones] nonEmpty.telefono=${withTelefono}`);
  console.log(`[clear-customer-phones] nonEmpty.phone_number=${withPhoneNumber}`);

  if (updates.length > 0) {
    console.log("[clear-customer-phones] sample docs:");
    for (const row of updates.slice(0, 10)) {
      const values = [
        row.whatsapp ? `whatsapp=${row.whatsapp}` : null,
        row.phone ? `phone=${row.phone}` : null,
        row.telefono ? `telefono=${row.telefono}` : null,
        row.phoneNumber ? `phone_number=${row.phoneNumber}` : null,
      ].filter(Boolean);
      console.log(`- ${row.id}${values.length ? ` | ${values.join(" | ")}` : ""}`);
    }
  }

  if (!applyMode) {
    console.log("");
    console.log("[clear-customer-phones] dry-run finished. Re-run with --apply to write updates.");
    return;
  }

  if (updates.length === 0) {
    console.log("");
    console.log("[clear-customer-phones] nothing to update.");
    return;
  }

  let committedBatches = 0;
  let updatedDocs = 0;
  let batch = db.batch();
  let ops = 0;

  for (const row of updates) {
    batch.update(row.ref, row.patch);
    ops += 1;
    updatedDocs += 1;

    if (ops >= BATCH_SIZE) {
      await batch.commit();
      committedBatches += 1;
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
    committedBatches += 1;
  }

  console.log("");
  console.log(`[clear-customer-phones] updatedDocs=${updatedDocs}`);
  console.log(`[clear-customer-phones] committedBatches=${committedBatches}`);
  console.log("[clear-customer-phones] done.");
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[clear-customer-phones] failed: ${message}`);
    process.exit(1);
  });