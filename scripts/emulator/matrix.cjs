// Extrae la matriz que un spec de emulador deja en su log y la imprime en Markdown, o
// compara las matrices de dos corridas.
//
//   node scripts/emulator/matrix.cjs <log>                  tabla identidad × operación
//   node scripts/emulator/matrix.cjs <log> --details        además, estado y detalle por celda
//   node scripts/emulator/matrix.cjs --diff <a.log> <b.log>  celdas cuyo resultado o estado cambia
//
// Reconoce las marcas [FIX03B11-RULES] (inventory-rules), [RULES-COMPAT] (client-rules-compat) y
// [SETTLEMENT-INTEGRITY] (settlement-integrity).
const fs = require("node:fs");

function readMatrix(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const tag of ["[RULES-COMPAT]", "[FIX03B11-RULES]", "[SETTLEMENT-INTEGRITY]"]) {
    const line = text.split(/\r?\n/).find((row) => row.includes(tag));
    if (!line) continue;
    const start = line.indexOf("[", line.indexOf(tag) + tag.length);
    return JSON.parse(line.slice(start, line.lastIndexOf("]") + 1));
  }
  throw new Error(`Sin matriz en ${file}`);
}
const mark = { ALLOW: "✅", DENY: "⛔", ERROR: "⚠️" };
const key = (cell) => `${cell.operation}|${cell.identity}`;

const args = process.argv.slice(2);
if (args[0] === "--diff") {
  const before = new Map(readMatrix(args[1]).map((cell) => [key(cell), cell]));
  const after = readMatrix(args[2]);
  let changed = 0;
  let worse = 0;
  for (const cell of after) {
    const prev = before.get(key(cell));
    if (!prev) { console.log(`NUEVA   ${key(cell)} ${cell.outcome}`); continue; }
    const sameState = (prev.state ?? "") === (cell.state ?? "");
    if (prev.outcome === cell.outcome && sameState) continue;
    changed += 1;
    const regress = prev.outcome === "ALLOW" && cell.outcome !== "ALLOW";
    if (regress) worse += 1;
    console.log(`${regress ? "EMPEORA" : "CAMBIA "} ${key(cell)}: ${prev.outcome} → ${cell.outcome}` +
      (sameState ? "" : `\n          antes:   ${prev.state}\n          después: ${cell.state}`) +
      (cell.detail ? `\n          detalle: ${cell.detail}` : ""));
  }
  console.log(`\nceldas: ${after.length} · con cambios: ${changed} · que empeoran (ALLOW → no ALLOW): ${worse}`);
  process.exitCode = worse > 0 ? 1 : 0;
} else {
  const cells = readMatrix(args[0]);
  const identities = [...new Set(cells.map((cell) => cell.identity))];
  const operations = [...new Set(cells.map((cell) => cell.operation))];
  console.log(`| Operación | ${identities.join(" | ")} |`);
  console.log(`| --- | ${identities.map(() => "---").join(" | ")} |`);
  for (const operation of operations) {
    const row = identities.map((identity) => {
      const cell = cells.find((entry) => entry.identity === identity && entry.operation === operation);
      return cell ? mark[cell.outcome] : "—";
    });
    console.log(`| ${operation} | ${row.join(" | ")} |`);
  }
  if (args.includes("--details")) {
    console.log("");
    for (const cell of cells) {
      console.log(`${cell.identity.padEnd(24)} ${cell.operation.padEnd(32)} ${cell.outcome.padEnd(5)} ${cell.state ?? ""} ${cell.detail ?? ""}`);
    }
  }
}
