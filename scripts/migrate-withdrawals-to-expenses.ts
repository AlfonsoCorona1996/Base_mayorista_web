/**
 * Reclasifica retiros que en realidad son gastos del negocio.
 *
 * Un gasto capturado como retiro se descuenta del reparto de socios en lugar de
 * restar de la utilidad. El resultado es que a los socios les aparece menos
 * dinero del que les toca y el gasto nunca sale en ningun reporte.
 *
 * La regla despues de esta migracion es:
 *   finance_withdrawals -> solo dinero que sale a socios o personas
 *   finance_expenses    -> todo gasto operativo y compra de mercancia
 *
 * Uso:
 *   npx tsx scripts/migrate-withdrawals-to-expenses.ts            (dry-run)
 *   npx tsx scripts/migrate-withdrawals-to-expenses.ts --apply
 *
 * En modo --apply escribe primero un respaldo JSON de cada retiro afectado y
 * solo despues lo convierte. Nada se borra sin quedar guardado en disco.
 */

import * as admin from "firebase-admin";
import * as fs from "node:fs";
import * as path from "node:path";

type ExpenseCategory =
  | "compra_inversion"
  | "paqueteria"
  | "viaticos"
  | "sueldos"
  | "equipo"
  | "consumibles"
  | "servicios"
  | "comisiones"
  | "perdida"
  | "ajuste"
  | "deuda_fija"
  | "deuda_meses";

type WithdrawalDoc = {
  withdrawal_id?: string;
  business_id?: string;
  amount?: number;
  occurred_at?: string;
  purpose?: string;
  recipient?: string | null;
  route_id?: string | null;
  account_id?: string | null;
  notes?: string | null;
};

type Rule = {
  category: ExpenseCategory;
  reason: string;
  match: (text: string, purpose: string) => boolean;
};

const PROJECT_ID = "base-mayorista";
const DEFAULT_SERVICE_ACCOUNT_PATHS = [
  path.resolve(__dirname, "../../../Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json"),
  path.resolve(__dirname, "../../whatsapp-bot/serviceAccountKey.json"),
];

const PARTNER_PURPOSES = new Set(["socio_blanca", "socio_andrea_pepe"]);
const PARTNER_HINTS = ["blanca", "andrea", "pepe"];

/**
 * Solo se reclasifica lo que se reconoce sin ambiguedad. Un retiro que no cae
 * en ninguna regla se reporta para revisarlo a mano en vez de adivinar.
 */
const RULES: Rule[] = [
  {
    category: "paqueteria",
    reason: "Menciona paqueteria o envio",
    match: (text) => /paqueter|envio|env[ií]o|flete|guia|gu[ií]a|mensajer/.test(text),
  },
  {
    category: "viaticos",
    reason: "Menciona viaticos o viaje",
    match: (text) => /vi[aá]tico|viaje|gasolina|caseta|hospedaje/.test(text),
  },
  {
    category: "ajuste",
    reason: "Estimado para cuadrar una devolucion que no se registro",
    match: (text) => /devoluci[oó]n|devolucion|%/.test(text),
  },
  {
    category: "equipo",
    reason: "Menciona equipo o herramienta",
    match: (text) => /impresora|equipo|herramienta|mobiliario|computad|laptop/.test(text),
  },
  {
    category: "consumibles",
    reason: "Menciona consumibles",
    match: (text) => /bolsa|etiqueta|papeler|utensilio|consumible/.test(text),
  },
  {
    category: "servicios",
    reason: "Menciona un servicio fijo",
    match: (text) => /renta|luz|internet|tel[eé]fono|telefono|agua/.test(text),
  },
  {
    category: "sueldos",
    reason: "Retiro registrado como sueldo",
    match: (_text, purpose) => purpose === "sueldo",
  },
  {
    category: "compra_inversion",
    reason: "Retiro registrado como inversion",
    match: (_text, purpose) => purpose === "inversion",
  },
];

const APPLY_MODE = process.argv.includes("--apply");
const SERVICE_ACCOUNT_ARG_NAMES = ["--credentials", "--service-account", "--serviceAccount"];

function getArgValue(names: string[]): string | null {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    for (const name of names) {
      if (arg === name) return process.argv[index + 1] || null;
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return null;
}

function findServiceAccountPath(): string {
  const candidates = [
    getArgValue(SERVICE_ACCOUNT_ARG_NAMES),
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ...DEFAULT_SERVICE_ACCOUNT_PATHS,
  ]
    .map((candidate) => String(candidate || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (match) return match;
  throw new Error("No se encontró la credencial Firebase. Usa --credentials <ruta>.");
}

function isPartnerWithdrawal(row: WithdrawalDoc): boolean {
  const purpose = String(row.purpose || "").trim();
  if (PARTNER_PURPOSES.has(purpose)) return true;
  const hint = `${row.recipient || ""} ${row.notes || ""}`.toLowerCase();
  return PARTNER_HINTS.some((needle) => hint.includes(needle));
}

function classify(row: WithdrawalDoc): Rule | null {
  const text = `${row.recipient || ""} ${row.notes || ""}`.toLowerCase();
  const purpose = String(row.purpose || "").trim();
  return RULES.find((rule) => rule.match(text, purpose)) || null;
}

function money(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function formatMoney(value: number): string {
  return value.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(12);
}

async function run(): Promise<void> {
  const modeLabel = APPLY_MODE ? "APPLY" : "DRY-RUN";
  const serviceAccountPath = findServiceAccountPath();
  console.log(`[withdrawals-to-expenses] Mode: ${modeLabel}`);
  console.log(`[withdrawals-to-expenses] Service account path: ${serviceAccountPath}`);

  const serviceAccount = require(serviceAccountPath);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
  }

  const db = admin.firestore();
  const snap = await db.collection("finance_withdrawals").get();

  const convert: Array<{ id: string; row: WithdrawalDoc; rule: Rule }> = [];
  const review: Array<{ id: string; row: WithdrawalDoc }> = [];
  let partnerCount = 0;

  for (const doc of snap.docs) {
    const row = doc.data() as WithdrawalDoc;
    if (isPartnerWithdrawal(row)) {
      partnerCount += 1;
      continue;
    }
    const rule = classify(row);
    if (rule) convert.push({ id: doc.id, row, rule });
    else review.push({ id: doc.id, row });
  }

  console.log(`\nRetiros totales: ${snap.size}`);
  console.log(`  De socios (no se tocan):     ${partnerCount}`);
  console.log(`  A reclasificar como gasto:   ${convert.length}`);
  console.log(`  Requieren revision manual:   ${review.length}`);

  if (convert.length > 0) {
    console.log("\n--- SE CONVIERTEN EN GASTO ---");
    let total = 0;
    for (const item of convert) {
      total += money(item.row.amount);
      console.log(
        `  ${String(item.row.occurred_at || "?").padEnd(12)}${formatMoney(money(item.row.amount))}` +
          `  ${item.rule.category.padEnd(17)} ${String(item.row.notes || item.row.recipient || "").slice(0, 45)}`,
      );
      console.log(`  ${" ".repeat(12)}${" ".repeat(12)}  -> ${item.rule.reason}`);
    }
    console.log(`  TOTAL${formatMoney(money(total))}`);
  }

  if (review.length > 0) {
    console.log("\n--- REVISAR A MANO (no se tocan) ---");
    for (const item of review) {
      console.log(
        `  ${String(item.row.occurred_at || "?").padEnd(12)}${formatMoney(money(item.row.amount))}` +
          `  [${String(item.row.purpose || "?").padEnd(10)}] ${String(item.row.notes || item.row.recipient || "").slice(0, 45)}`,
      );
    }
  }

  if (!APPLY_MODE) {
    console.log("\nDry-run. Nada se modificó. Corre con --apply para ejecutar.");
    return;
  }

  if (convert.length === 0) {
    console.log("\nNo hay nada que reclasificar.");
    return;
  }

  // Respaldo en disco antes de tocar Firestore: si algo sale mal, los retiros
  // originales se pueden reconstruir tal cual estaban.
  const backupPath = path.resolve(
    __dirname,
    `../backups/withdrawals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(
    backupPath,
    JSON.stringify(convert.map((item) => ({ id: item.id, category: item.rule.category, data: item.row })), null, 2),
    "utf8",
  );
  console.log(`\nRespaldo escrito en: ${backupPath}`);

  const batch = db.batch();
  for (const item of convert) {
    const expenseId = `exp_from_${item.id}`;
    batch.set(db.collection("finance_expenses").doc(expenseId), {
      expense_id: expenseId,
      business_id: item.row.business_id || "bm",
      category: item.rule.category,
      amount: money(item.row.amount),
      occurred_at: item.row.occurred_at || new Date().toISOString().slice(0, 10),
      route_id: item.row.route_id || null,
      route_run_id: null,
      order_id: null,
      shipment_id: null,
      shared_expense_group_id: null,
      allocation_method: null,
      allocated_from_total: null,
      account_id: item.row.account_id || null,
      installment_total: null,
      installment_index: null,
      notes: item.row.notes || item.row.recipient || null,
      migrated_from_withdrawal_id: item.id,
      migrated_reason: item.rule.reason,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.delete(db.collection("finance_withdrawals").doc(item.id));
  }

  await batch.commit();
  console.log(`\nListo: ${convert.length} retiros convertidos en gasto.`);
  if (review.length > 0) {
    console.log(`Quedan ${review.length} retiros por revisar a mano desde la app.`);
  }
}

run().catch((error) => {
  console.error("[withdrawals-to-expenses] Error:", error);
  process.exit(1);
});
