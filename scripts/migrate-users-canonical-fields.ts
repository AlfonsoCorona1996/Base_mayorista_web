/**
 * Users canonical-field migration.
 *
 * Purpose:
 * - Normalize duplicate snake_case/camelCase fields in users/* docs.
 * - Optionally delete legacy snake_case aliases after canonicalization.
 *
 * Usage:
 *   npx tsx scripts/migrate-users-canonical-fields.ts
 *   npx tsx scripts/migrate-users-canonical-fields.ts --apply
 *   npx tsx scripts/migrate-users-canonical-fields.ts --apply --delete-legacy
 *   npx tsx scripts/migrate-users-canonical-fields.ts --apply --uid=<uid>
 */

import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ID = "base-mayorista";
const DEFAULT_SERVICE_ACCOUNT_PATH = path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json");

const APPLY_MODE = process.argv.includes("--apply");
const DELETE_LEGACY = process.argv.includes("--delete-legacy");
const HELP_MODE = process.argv.includes("--help") || process.argv.includes("-h");
const TARGET_UID = readArgValue("--uid");
const LIMIT = Number(readArgValue("--limit") || "0");

type FieldAliasRule = {
  canonical: string;
  aliases: string[];
};

const FIELD_ALIAS_RULES: FieldAliasRule[] = [
  { canonical: "displayName", aliases: ["display_name"] },
  { canonical: "isActive", aliases: ["active"] },
  { canonical: "invitePending", aliases: ["invite_pending"] },
  { canonical: "mustChangePassword", aliases: ["must_change_password"] },
  { canonical: "loginMode", aliases: ["login_mode"] },
  { canonical: "invitedAt", aliases: ["invited_at"] },
  { canonical: "lastInvitedAt", aliases: ["last_invited_at"] },
  { canonical: "acceptedAt", aliases: ["accepted_at"] },
  { canonical: "createdAt", aliases: ["created_at"] },
  { canonical: "updatedAt", aliases: ["updated_at"] },
];

function readArgValue(flag: string): string | null {
  const exact = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);
  const index = process.argv.findIndex((entry) => entry === flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return null;
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isTimestampLike(value: unknown): value is { toMillis: () => number } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { toMillis?: unknown };
  return typeof candidate.toMillis === "function";
}

function isEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isTimestampLike(a) && isTimestampLike(b)) {
    return a.toMillis() === b.toMillis();
  }
  return false;
}

function pickCanonicalValue(data: Record<string, unknown>, rule: FieldAliasRule): unknown {
  if (hasOwn(data, rule.canonical)) {
    return data[rule.canonical];
  }
  for (const alias of rule.aliases) {
    if (hasOwn(data, alias)) return data[alias];
  }
  return undefined;
}

function printHelp() {
  console.log("Users canonical-field migration");
  console.log("");
  console.log("Usage:");
  console.log("  npx tsx scripts/migrate-users-canonical-fields.ts");
  console.log("  npx tsx scripts/migrate-users-canonical-fields.ts --apply");
  console.log("  npx tsx scripts/migrate-users-canonical-fields.ts --apply --delete-legacy");
  console.log("  npx tsx scripts/migrate-users-canonical-fields.ts --apply --uid=<uid>");
  console.log("");
  console.log("Flags:");
  console.log("  --apply             Writes changes. Default mode is dry-run.");
  console.log("  --delete-legacy     Deletes snake_case alias fields after canonicalization.");
  console.log("  --uid=<uid>         Processes only one user document.");
  console.log("  --limit=<n>         Processes at most n users.");
}

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  if (fs.existsSync(DEFAULT_SERVICE_ACCOUNT_PATH)) {
    const serviceAccount = require(DEFAULT_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    console.log(`[users-canonical] credential: service account (${DEFAULT_SERVICE_ACCOUNT_PATH})`);
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: PROJECT_ID });
    console.log("[users-canonical] credential: GOOGLE_APPLICATION_CREDENTIALS");
    return;
  }

  throw new Error(
    `No se encontro credencial Firebase. Esperado: ${DEFAULT_SERVICE_ACCOUNT_PATH} o GOOGLE_APPLICATION_CREDENTIALS.`,
  );
}

async function run(): Promise<void> {
  if (HELP_MODE) {
    printHelp();
    return;
  }

  const modeLabel = APPLY_MODE ? "APPLY" : "DRY-RUN";
  console.log(`[users-canonical] mode=${modeLabel}`);
  console.log(`[users-canonical] deleteLegacy=${DELETE_LEGACY}`);
  if (TARGET_UID) console.log(`[users-canonical] uid=${TARGET_UID}`);
  if (LIMIT > 0) console.log(`[users-canonical] limit=${LIMIT}`);

  initFirebaseAdmin();

  const db = admin.firestore();
  const usersCollection = db.collection("users");
  const snapshot = TARGET_UID ? await usersCollection.where("uid", "==", TARGET_UID).get() : await usersCollection.get();

  const docs = LIMIT > 0 ? snapshot.docs.slice(0, LIMIT) : snapshot.docs;

  let scanned = 0;
  let changed = 0;
  let noop = 0;
  let legacyDeleted = 0;
  let conflicts = 0;
  const samples: string[] = [];

  let batch = db.batch();
  let batchOps = 0;
  const commits: Promise<unknown>[] = [];

  for (const docSnap of docs) {
    scanned += 1;
    const data = (docSnap.data() || {}) as Record<string, unknown>;
    const updatePayload: Record<string, unknown> = {};
    let localLegacyDeletes = 0;
    let localChanged = false;

    for (const rule of FIELD_ALIAS_RULES) {
      const canonicalPresent = hasOwn(data, rule.canonical);
      const canonicalCurrent = data[rule.canonical];
      const picked = pickCanonicalValue(data, rule);
      if (picked !== undefined) {
        if (!canonicalPresent || !isEqualValue(canonicalCurrent, picked)) {
          updatePayload[rule.canonical] = picked;
          localChanged = true;
          if (canonicalPresent && !isEqualValue(canonicalCurrent, picked)) {
            conflicts += 1;
          }
        }
      }

      if (DELETE_LEGACY) {
        for (const alias of rule.aliases) {
          if (!hasOwn(data, alias)) continue;
          updatePayload[alias] = admin.firestore.FieldValue.delete();
          localChanged = true;
          localLegacyDeletes += 1;
        }
      }
    }

    if (!localChanged) {
      noop += 1;
      continue;
    }

    changed += 1;
    legacyDeleted += localLegacyDeletes;

    if (samples.length < 20) {
      samples.push(
        `- ${docSnap.id}: keys=[${Object.keys(updatePayload)
          .sort()
          .join(", ")}]`,
      );
    }

    if (!APPLY_MODE) continue;

    batch.update(docSnap.ref, updatePayload);
    batchOps += 1;
    if (batchOps >= 400) {
      commits.push(batch.commit());
      batch = db.batch();
      batchOps = 0;
    }
  }

  if (APPLY_MODE && batchOps > 0) {
    commits.push(batch.commit());
  }
  if (APPLY_MODE && commits.length > 0) {
    await Promise.all(commits);
  }

  console.log("");
  console.log(`[users-canonical] scanned=${scanned}`);
  console.log(`[users-canonical] changed=${changed}`);
  console.log(`[users-canonical] unchanged=${noop}`);
  console.log(`[users-canonical] conflicts=${conflicts}`);
  console.log(`[users-canonical] legacyFieldsDeleted=${legacyDeleted}`);
  if (samples.length > 0) {
    console.log("[users-canonical] sample changes:");
    for (const line of samples) console.log(line);
  }

  if (!APPLY_MODE) {
    console.log("");
    console.log("[users-canonical] dry-run only. Re-run with --apply to write changes.");
  }
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[users-canonical] failed: ${message}`);
    process.exit(1);
  });

