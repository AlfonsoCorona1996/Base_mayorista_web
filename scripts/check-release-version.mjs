import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const errors = [];
if (!semver.test(pkg.version)) errors.push(`package.json contiene una version SemVer invalida: ${pkg.version}`);
if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
  errors.push("package-lock.json no coincide con package.json");
}
if (!changelog.includes(`## [${pkg.version}]`)) {
  errors.push(`CHANGELOG.md no contiene una entrada para ${pkg.version}`);
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`Frontend v${pkg.version}: metadatos de release consistentes.`);
