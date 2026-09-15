import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import {
  beginEditTransaction,
  captureTransactionPaths,
  recordTransactionEdit,
  previewEditTransaction,
  rollbackEditTransaction,
  getEditTransaction,
} from "../dist/lib/edit-transaction-store.js";
import { runRepositoryIntelligence } from "../dist/lib/repository-intelligence.js";
import { shutdownLspSessions } from "../dist/lib/lsp-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, ".tool-test-tmp", "phase2-runtime");
const fixture = path.join(tmp, "fixture");
const stateDir = path.join(tmp, "transactions");
process.env.MCP_EDIT_TRANSACTION_STATE_DIR = stateDir;
process.env.MCP_AGENT_TASK_STATE_DIR = path.join(tmp, "tasks");
process.env.MCP_OPERATION_STATE_DIR = path.join(tmp, "operations");
process.env.PERMISSIONS_CONFIG = path.join(tmp, "permissions.json");
process.env.LOCAL_HOOKS_CONFIG = path.join(tmp, "hooks.json");
process.env.SUBAGENT_CONFIG = path.join(tmp, "subagents.json");

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
function fail(name, error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (error) { fail(name, error); }
}

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(path.join(fixture, "src"), { recursive: true });
await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({
  name: "phase2-fixture",
  scripts: {
    build: "node -e \"console.log('BUILD_OK')\"",
    test: "node -e \"console.log('TEST_OK')\"",
  },
}, null, 2));
await fs.writeFile(path.join(fixture, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
  include: ["src/**/*.ts"],
}, null, 2));
const aPath = path.join(fixture, "src", "a.ts");
const bPath = path.join(fixture, "src", "b.ts");
await fs.writeFile(aPath, [
  "export function greet(name: string) {",
  "  return `hello ${name}`;",
  "}",
  "",
  "export const localMarker = greet('a');",
  "",
].join("\n"));
await fs.writeFile(bPath, [
  "import { greet } from './a.js';",
  "export const message = greet('b');",
  "",
].join("\n"));

await run("repository intelligence symbol search returns bounded matches", async () => {
  const result = await runRepositoryIntelligence({
    action: "symbol_search",
    workspace: fixture,
    defaultCwd: fixture,
    query: "greet",
    path: aPath,
    server: "typescript",
    maxResults: 20,
  });
  if (!["semantic", "lexical"].includes(result.mode)) throw new Error(JSON.stringify(result));
  if (!result.matches?.some((row) => row.path.endsWith("a.ts"))) throw new Error(JSON.stringify(result));
  if (result.matches.length > 20) throw new Error("result bound exceeded");
});

await run("repository intelligence references/impact span affected files", async () => {
  const references = await runRepositoryIntelligence({
    action: "references",
    workspace: fixture,
    defaultCwd: fixture,
    path: aPath,
    line: 1,
    column: 17,
    server: "typescript",
    maxResults: 50,
  });
  if (!references.references?.length) throw new Error(JSON.stringify(references));
  const impact = await runRepositoryIntelligence({
    action: "impact",
    workspace: fixture,
    defaultCwd: fixture,
    path: aPath,
    line: 1,
    column: 17,
    server: "typescript",
    maxResults: 50,
  });
  if (!impact.affected_files?.some((row) => row.path.endsWith("b.ts"))) {
    throw new Error(JSON.stringify(impact));
  }
});

await run("transaction store previews and rolls back only captured files", async () => {
  const original = await fs.readFile(aPath, "utf-8");
  const tx = await beginEditTransaction(fixture, "unit rollback");
  await captureTransactionPaths(tx.id, [aPath]);
  await fs.writeFile(aPath, original.replace("hello", "hi"));
  await recordTransactionEdit(tx.id, "unit", [aPath], null);
  const preview = await previewEditTransaction(tx.id);
  if (preview.changed_files !== 1 || preview.files[0]?.status !== "modified") throw new Error(JSON.stringify(preview));
  if (!preview.files[0]?.diff?.includes("hi")) throw new Error(JSON.stringify(preview.files[0]));
  const rollback = await rollbackEditTransaction(tx.id);
  if (!rollback.rolled_back || rollback.restored.length !== 1) throw new Error(JSON.stringify(rollback));
  if (await fs.readFile(aPath, "utf-8") !== original) throw new Error("baseline was not restored");
});

await run("transaction rollback blocks out-of-band changes unless forced", async () => {
  const original = await fs.readFile(aPath, "utf-8");
  const tx = await beginEditTransaction(fixture, "conflict rollback");
  await captureTransactionPaths(tx.id, [aPath]);
  await fs.writeFile(aPath, original.replace("hello", "transaction"));
  await recordTransactionEdit(tx.id, "unit", [aPath], null);
  await fs.writeFile(aPath, original.replace("hello", "external"));
  const blocked = await rollbackEditTransaction(tx.id);
  if (blocked.rolled_back || blocked.conflicts.length !== 1) throw new Error(JSON.stringify(blocked));
  if (!(await fs.readFile(aPath, "utf-8")).includes("external")) throw new Error("conflicting edit was unexpectedly overwritten");
  const forced = await rollbackEditTransaction(tx.id, true);
  if (!forced.rolled_back) throw new Error(JSON.stringify(forced));
  if (await fs.readFile(aPath, "utf-8") !== original) throw new Error("forced rollback did not restore baseline");
});

await run("transaction rollback resumes safely after a partial prior restore", async () => {
  const originalA = await fs.readFile(aPath, "utf-8");
  const originalB = await fs.readFile(bPath, "utf-8");
  const tx = await beginEditTransaction(fixture, "partial rollback recovery");
  await captureTransactionPaths(tx.id, [aPath, bPath]);
  await fs.writeFile(aPath, originalA.replace("hello", "partial-a"));
  await fs.writeFile(bPath, originalB.replace("greet('b')", "greet('partial-b')"));
  await recordTransactionEdit(tx.id, "unit", [aPath, bPath], null);

  // Simulate a process crash halfway through rollback: one file already made
  // it back to baseline while the other still contains transaction output.
  await fs.writeFile(aPath, originalA);
  const rollback = await rollbackEditTransaction(tx.id);
  if (!rollback.rolled_back || rollback.conflicts.length) throw new Error(JSON.stringify(rollback));
  if (await fs.readFile(aPath, "utf-8") !== originalA) throw new Error("already-restored file changed incorrectly");
  if (await fs.readFile(bPath, "utf-8") !== originalB) throw new Error("remaining file was not recovered");
});

await run("transaction state ids reject path traversal", async () => {
  let rejected = false;
  try {
    await getEditTransaction("../../outside");
  } catch (error) {
    rejected = /Invalid edit transaction id/.test(String(error));
  }
  if (!rejected) throw new Error("path-traversal transaction id was not rejected");
});

await run("repository intelligence rejects position paths outside the selected workspace", async () => {
  const outside = path.join(tmp, "outside.ts");
  await fs.writeFile(outside, "export const outsideSymbol = 1;\n");
  let rejected = false;
  try {
    await runRepositoryIntelligence({
      action: "references",
      workspace: fixture,
      defaultCwd: fixture,
      path: outside,
      line: 1,
      column: 14,
      server: "typescript",
      maxResults: 20,
    });
  } catch (error) {
    rejected = /outside selected workspace|escapes selected workspace/.test(String(error));
  }
  if (!rejected) throw new Error("repository intelligence accepted an outside-workspace position path");
});

await run("tampered transaction records cannot point snapshots outside the workspace", async () => {
  const id = "tx_deadbeefdeadbe";
  const now = new Date().toISOString();
  const outside = path.join(tmp, "tampered-outside.txt");
  await fs.writeFile(outside, "outside\n");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, `${id}.json`), JSON.stringify({
    version: 1,
    id,
    workspace: fixture,
    status: "active",
    created_at: now,
    updated_at: now,
    snapshots: [{ path: outside, existed: true, size: 8 }],
    edits: [],
  }), "utf-8");
  let rejected = false;
  try {
    await getEditTransaction(id);
  } catch (error) {
    rejected = /invalid transaction snapshot path/.test(String(error));
  }
  await fs.rm(path.join(stateDir, `${id}.json`), { force: true });
  if (!rejected) throw new Error("tampered outside-workspace snapshot was accepted");
});

await run("transaction snapshot payload cannot escape through a symlink or junction", async () => {
  const id = "tx_feedfacec0ffee";
  const now = new Date().toISOString();
  const payload = path.join(stateDir, id);
  const outsideDir = path.join(tmp, "payload-outside");
  const outsidePayload = path.join(outsideDir, "baseline.bin");
  const escapeDir = path.join(payload, "escape");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(outsidePayload, "outside baseline\n");
  await fs.mkdir(payload, { recursive: true });
  await fs.symlink(outsideDir, escapeDir, process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(stateDir, `${id}.json`), JSON.stringify({
    version: 1,
    id,
    workspace: fixture,
    status: "active",
    created_at: now,
    updated_at: now,
    snapshots: [{
      path: aPath,
      existed: true,
      size: 1,
      snapshot_file: path.join(escapeDir, "baseline.bin"),
    }],
    edits: [],
  }), "utf-8");
  let rejected = false;
  try {
    await getEditTransaction(id);
  } catch (error) {
    rejected = /snapshot payload escapes payload directory/.test(String(error));
  }
  await fs.rm(path.join(stateDir, `${id}.json`), { force: true });
  await fs.rm(payload, { recursive: true, force: true });
  if (!rejected) throw new Error("symlink/junction payload escape was accepted");
});

await run("transaction capture rejects workspace symlink or junction escapes", async () => {
  const outsideDir = path.join(tmp, "workspace-outside");
  const outsideFile = path.join(outsideDir, "outside.ts");
  const linkDir = path.join(fixture, "linked-outside");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(outsideFile, "export const escaped = true;\n");
  await fs.rm(linkDir, { recursive: true, force: true });
  await fs.symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");
  const tx = await beginEditTransaction(fixture, "junction escape");
  let rejected = false;
  try {
    await captureTransactionPaths(tx.id, [path.join(linkDir, "outside.ts")]);
  } catch (error) {
    rejected = /escapes workspace through a symlink\/junction/.test(String(error));
  }
  await rollbackEditTransaction(tx.id, true);
  await fs.rm(linkDir, { recursive: true, force: true });
  if (!rejected) throw new Error("workspace symlink/junction escape was accepted");
});

await run("Windows path-case aliases share one transaction snapshot", async () => {
  if (process.platform !== "win32") return;
  const tx = await beginEditTransaction(fixture, "case alias");
  const captured = await captureTransactionPaths(tx.id, [aPath, aPath.toUpperCase()]);
  if (captured.snapshots.length !== 1) throw new Error(`case aliases created ${captured.snapshots.length} snapshots`);
  await rollbackEditTransaction(tx.id, true);
});

await run("transaction pruning preserves active transactions under >500 record pressure", async () => {
  const pressureDir = path.join(tmp, "transaction-retention");
  await fs.rm(pressureDir, { recursive: true, force: true });
  await fs.mkdir(pressureDir, { recursive: true });
  const now = Date.now();
  const activeId = "tx_aaaaaaaaaaaaaa";
  const records = [];
  for (let index = 0; index < 499; index++) {
    const id = `tx_${index.toString(16).padStart(14, "0")}`;
    const at = new Date(now - 1_000_000 + index).toISOString();
    records.push({ version: 1, id, workspace: fixture, status: "accepted", created_at: at, updated_at: at, snapshots: [], edits: [] });
  }
  records.push({
    version: 1,
    id: activeId,
    workspace: fixture,
    status: "active",
    created_at: new Date(now - 2_000_000).toISOString(),
    updated_at: new Date(now - 2_000_000).toISOString(),
    snapshots: [],
    edits: [],
  });
  await Promise.all(records.map((record) => fs.writeFile(path.join(pressureDir, `${record.id}.json`), JSON.stringify(record), "utf-8")));
  const previous = process.env.MCP_EDIT_TRANSACTION_STATE_DIR;
  process.env.MCP_EDIT_TRANSACTION_STATE_DIR = pressureDir;
  try {
    const newest = await beginEditTransaction(fixture, "pressure newcomer");
    if (!(await getEditTransaction(activeId))) throw new Error("existing active transaction was pruned");
    if (!(await getEditTransaction(newest.id))) throw new Error("new active transaction was pruned");
    const jsonFiles = (await fs.readdir(pressureDir)).filter((name) => /^tx_[0-9a-f]{14}\.json$/i.test(name));
    if (jsonFiles.length !== 500) throw new Error(`expected 500 retained transaction records, found ${jsonFiles.length}`);
  } finally {
    process.env.MCP_EDIT_TRANSACTION_STATE_DIR = previous;
    await fs.rm(pressureDir, { recursive: true, force: true });
  }
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(fixture, 30, [fixture], true);
const client = new Client({ name: "phase2-runtime-test", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);
const call = async (name, args) => client.callTool({ name, arguments: args });

await run("Phase 2 tools are exposed in slim profile", async () => {
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of ["repo_intel", "edit_transaction"]) {
    if (!names.has(name)) throw new Error(`${name} not exposed`);
  }
});

await run("transaction-aware edit tool supports preview and rollback", async () => {
  const original = await fs.readFile(bPath, "utf-8");
  const began = await call("edit_transaction", { action: "begin", workspace: fixture, label: "tool rollback" });
  const txId = began.structuredContent?.data?.transaction?.id;
  if (!txId) throw new Error(JSON.stringify(began));

  const edited = await call("edit_file", {
    path: bPath,
    old_text: "greet('b')",
    new_text: "greet('tool')",
    transaction_id: txId,
  });
  if (edited.structuredContent?.data?.transaction_id !== txId) throw new Error(JSON.stringify(edited));

  const preview = await call("edit_transaction", { action: "preview", id: txId });
  if (preview.structuredContent?.data?.changed_files !== 1) throw new Error(JSON.stringify(preview));

  const rolledBack = await call("edit_transaction", { action: "rollback", id: txId });
  if (!rolledBack.structuredContent?.data?.rolled_back) throw new Error(JSON.stringify(rolledBack));
  if (await fs.readFile(bPath, "utf-8") !== original) throw new Error("tool rollback did not restore file");
});

await run("parallel transaction-aware edits preserve every baseline", async () => {
  const originalA = await fs.readFile(aPath, "utf-8");
  const originalB = await fs.readFile(bPath, "utf-8");
  const began = await call("edit_transaction", { action: "begin", workspace: fixture, label: "parallel edits" });
  const txId = began.structuredContent?.data?.transaction?.id;
  if (!txId) throw new Error(JSON.stringify(began));

  await Promise.all([
    call("edit_file", {
      path: aPath,
      old_text: "hello ${name}",
      new_text: "parallel-a ${name}",
      transaction_id: txId,
    }),
    call("edit_file", {
      path: bPath,
      old_text: "greet('b')",
      new_text: "greet('parallel-b')",
      transaction_id: txId,
    }),
  ]);

  const status = await call("edit_transaction", { action: "status", id: txId });
  const transaction = status.structuredContent?.data?.transaction;
  if (transaction?.snapshots?.length !== 2 || transaction?.edits?.length !== 2) {
    throw new Error(JSON.stringify(status));
  }
  const preview = await call("edit_transaction", { action: "preview", id: txId });
  if (preview.structuredContent?.data?.changed_files !== 2) throw new Error(JSON.stringify(preview));

  const rolledBack = await call("edit_transaction", { action: "rollback", id: txId });
  if (!rolledBack.structuredContent?.data?.rolled_back) throw new Error(JSON.stringify(rolledBack));
  if (await fs.readFile(aPath, "utf-8") !== originalA) throw new Error("parallel rollback did not restore a.ts");
  if (await fs.readFile(bPath, "utf-8") !== originalB) throw new Error("parallel rollback did not restore b.ts");
});

await run("transaction verify records evidence before accept", async () => {
  const began = await call("edit_transaction", { action: "begin", workspace: fixture, label: "verify accept" });
  const txId = began.structuredContent?.data?.transaction?.id;
  if (!txId) throw new Error(JSON.stringify(began));
  await call("edit_file", {
    path: bPath,
    old_text: "greet('b')",
    new_text: "greet('accepted')",
    transaction_id: txId,
  });
  const verified = await call("edit_transaction", {
    action: "verify",
    id: txId,
    preset: "custom",
    commands: [{ label: "marker", command: "node -e \"console.log('TX_VERIFY_OK')\"", timeout_seconds: 30 }],
  });
  if (verified.structuredContent?.data?.failed !== 0) throw new Error(JSON.stringify(verified));
  if (!verified.structuredContent?.data?.results?.[0]?.excerpt?.includes("TX_VERIFY_OK")) throw new Error(JSON.stringify(verified));
  const accepted = await call("edit_transaction", { action: "accept", id: txId });
  if (accepted.structuredContent?.data?.transaction?.status !== "accepted") throw new Error(JSON.stringify(accepted));
  const stored = await getEditTransaction(txId);
  if (stored.status !== "accepted" || stored.verification?.failed !== 0) throw new Error(JSON.stringify(stored));
});

await run("repo_intel MCP tool returns impact summary", async () => {
  const result = await call("repo_intel", {
    action: "impact",
    workspace: fixture,
    path: aPath,
    line: 1,
    column: 17,
    server: "typescript",
    max_results: 50,
  });
  const data = result.structuredContent?.data;
  if (!Array.isArray(data?.affected_files) || !data.affected_files.length) throw new Error(JSON.stringify(result));
});

await run("repo_intel resolves relative source paths against its selected workspace", async () => {
  const result = await call("repo_intel", {
    action: "references",
    workspace: fixture,
    path: path.join("src", "a.ts"),
    line: 1,
    column: 17,
    server: "typescript",
    max_results: 20,
  });
  if (result.isError) throw new Error(JSON.stringify(result));
  const source = result.structuredContent?.data?.symbol?.path;
  if (!source || path.resolve(source) !== path.resolve(aPath)) throw new Error(JSON.stringify(result));
});

await client.close().catch(() => {});
await server.close().catch(() => {});
await shutdownLspSessions().catch(() => {});
// LspClient sends a graceful exit then schedules a hard kill after 250 ms.
// Give Windows time to release the language-server workspace handle.
await new Promise((resolve) => setTimeout(resolve, 500));
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
