/**
 * Optional shell cwd persistence works when explicitly enabled for a stable MCP client.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  bootstrapShellSession,
  execInShellSession,
  getShellStatus,
  resetShellSession,
} from "../dist/lib/persistent-shell.js";
import { loadGlobalShellState } from "../dist/lib/global-shell-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stateDir = path.join(root, ".tool-test-tmp", "shell-persist");

process.env.MCP_SHELL_STATE_DIR = stateDir;
process.env.MCP_SHELL_PERSIST_CWD = "1";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e && e.stack || e}`); failed++; }

try {
  await fs.rm(stateDir, { recursive: true, force: true });
  await bootstrapShellSession(root);
  await execInShellSession(process.platform === "win32" ? "cd src" : "cd src", root, 5000);

  const cwd1 = getShellStatus().cwd;
  if (!cwd1.replace(/\\/g, "/").endsWith("/src")) {
    throw new Error(`expected cwd in src, got ${cwd1}`);
  }
  ok(`cwd after cd: ${cwd1}`);

  await bootstrapShellSession(root);
  const cwd2 = getShellStatus().cwd;
  if (cwd2 !== cwd1) throw new Error(`persist failed: ${cwd1} -> ${cwd2}`);
  ok("cwd restored after re-bootstrap");

  resetShellSession(root);
  await execInShellSession("cd src", root, 5000);
  const persisted = await loadGlobalShellState(root, root, "__legacy__");
  if (!persisted?.cwd.replace(/\\/g, "/").endsWith("/src")) {
    throw new Error(`queued shell state write lost newest cwd: ${JSON.stringify(persisted)}`);
  }
  const residue = (await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp"));
  if (residue.length) throw new Error(`shell state temp residue: ${residue.join(", ")}`);
  ok("shell state writes are ordered and atomic");
} catch (e) {
  fail("shell persist", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);