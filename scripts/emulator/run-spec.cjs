// Corre un *.emulator.spec.ts contra el emulador de Firebase.
//
//   node scripts/emulator/run-spec.cjs <spec en src/app/core> [--rules <archivo>] [--permissive] [--log <archivo>]
//
// - Por omisión carga `firestore.rules` (las reglas REALES del repo) en el proyecto que usa
//   la app (`base-mayorista`) dentro del emulador del puerto 8597. La recarga en caliente del
//   emulador solo aplica al proyecto con el que arrancó, por eso se cargan explícitamente.
// - `--rules <archivo>` carga otro juego de reglas (p. ej. una copia de las publicadas).
// - `--permissive` no carga reglas: para specs que usan el emulador permisivo (8297/9397).
// - El builder de pruebas excluye `*.emulator.spec.ts`: se copia el spec con otro nombre,
//   se corre Karma sin interfaz y se borra la copia.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const spec = args.find((arg, i) => !arg.startsWith("--") && !["--rules", "--log"].includes(args[i - 1]));
if (!spec) { console.error("Falta el nombre del spec (relativo a src/app/core)."); process.exit(2); }
const permissive = args.includes("--permissive");
const rulesFile = path.resolve(root, flag("--rules") || "firestore.rules");
const logFile = path.resolve(root, flag("--log") || `tmp/emulator-logs/${path.basename(spec, ".ts")}.log`);
const source = path.join(root, "src/app/core", spec);
const copy = path.join(root, "src/app/core/zz-emulator-run.spec.ts");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

(async () => {
  let header = "reglas: permisivas del emulador (sin cargar)";
  if (!permissive) {
    let status = 0;
    let text = "";
    try {
      const res = await fetch("http://127.0.0.1:8597/emulator/v1/projects/base-mayorista:securityRules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: fs.readFileSync(rulesFile, "utf8") }] } }),
      });
      status = res.status;
      text = await res.text();
    } catch (error) {
      text = String(error);
    }
    if (status !== 200) {
      console.error(`No se cargaron las reglas (${status}). ¿Está el emulador en 8597? ${text.slice(0, 300)}`);
      process.exit(3);
    }
    header = `reglas: ${path.relative(root, rulesFile)} sha256 ${sha(rulesFile)}`;
  }
  console.log(header);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.copyFileSync(source, copy);
  try {
    const ng = path.join(root, "node_modules/@angular/cli/bin/ng.js");
    const res = spawnSync(process.execPath, [ng, "test", "--include=**/zz-emulator-run.spec.ts", "--watch=false", "--browsers=ChromeHeadless"], {
      cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    });
    const out = `${header}\n${res.stdout}\n${res.stderr}`;
    fs.writeFileSync(logFile, out);
    const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/);
    console.log(clean.filter((line) => /TOTAL|Executed \d+ of \d+ .*\(\d|\sFAILED$/.test(line)).slice(-6).join("\n"));
    console.log(`log: ${path.relative(root, logFile)}`);
    process.exitCode = res.status || 0;
  } finally {
    fs.rmSync(copy, { force: true });
  }
})();
