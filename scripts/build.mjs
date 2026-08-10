import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
const ngCli = join(workspaceRoot, "node_modules", "@angular", "cli", "bin", "ng.js");

function gitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const commit = String(
  process.env.APP_COMMIT_SHA
    || process.env.SOURCE_COMMIT_HASH
    || process.env.GITHUB_SHA
    || gitOutput(["rev-parse", "HEAD"])
    || "unknown",
).trim();
const dirty = !process.env.APP_COMMIT_SHA && gitOutput(["status", "--porcelain"]).length > 0;
const builtAt = new Date().toISOString();

const build = spawnSync(
  process.execPath,
  [ngCli, "build", ...process.argv.slice(2)],
  { cwd: workspaceRoot, stdio: "inherit", env: process.env },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const browserOutput = join(workspaceRoot, "dist", "admin-web", "browser");
mkdirSync(browserOutput, { recursive: true });
writeFileSync(
  join(browserOutput, "version.json"),
  `${JSON.stringify({
    service: "base-mayorista-admin-web",
    version: packageMetadata.version,
    commit,
    dirty,
    built_at: builtAt,
  }, null, 2)}\n`,
  "utf8",
);

console.log(`Build metadata: frontend v${packageMetadata.version} (${commit.slice(0, 7)}${dirty ? ", dirty" : ""})`);
