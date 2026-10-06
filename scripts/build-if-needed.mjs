import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, ".mcp-state");
const stampPath = path.join(stateDir, "build-fingerprint.json");
const distEntry = path.join(root, "dist", "index.js");
const force = process.argv.includes("--force") || process.env.LOCAL_CODER_FORCE_BUILD === "1";
const skip = process.argv.includes("--skip");

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(target));
    else if (entry.isFile()) out.push(target);
  }
  return out;
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function fingerprint() {
  const files = [
    ...await walk(path.join(root, "src")),
    ...["package.json", "package-lock.json", "tsconfig.json"]
      .map((name) => path.join(root, name))
      .filter((target) => target),
  ].sort();
  const hash = createHash("sha256");
  let count = 0;
  for (const file of files) {
    if (!(await exists(file))) continue;
    const relative = path.relative(root, file).replace(/\\/g, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
    count++;
  }
  return { value: hash.digest("hex"), files: count };
}

if (skip) {
  if (!(await exists(distEntry))) {
    console.error("[Build] -NoBuild requested but dist/index.js does not exist.");
    process.exit(1);
  }
  console.log("[Build] Skipped by request.");
  process.exit(0);
}

const current = await fingerprint();
let previous = null;
try { previous = JSON.parse(await fs.readFile(stampPath, "utf8")); } catch {}
if (!force && previous?.fingerprint === current.value && await exists(distEntry)) {
  console.log(`[Build] Source unchanged (${current.files} inputs) - using current dist.`);
  process.exit(0);
}

console.log(force ? "[Build] Forced rebuild." : "[Build] Source changed - compiling.");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
if (!(await exists(tsc))) {
  console.error("[Build] TypeScript compiler is missing. Run npm install first.");
  process.exit(1);
}
const built = spawnSync(process.execPath, [tsc], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (built.status !== 0) process.exit(built.status ?? 1);

await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(stampPath, JSON.stringify({
  version: 1,
  fingerprint: current.value,
  files: current.files,
  built_at: new Date().toISOString(),
}, null, 2) + "\n");
console.log("[Build] Build fingerprint saved.");