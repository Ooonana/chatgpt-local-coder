import fs from "fs/promises";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import { getCodingLoop, listCodingLoops, saveCodingLoop } from "../dist/lib/coding-loop-store.js";
import { acceptEditTransaction, getEditTransaction } from "../dist/lib/edit-transaction-store.js";
import { shutdownLspSessions } from "../dist/lib/lsp-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, ".tool-test-tmp", "phase3-runtime");
const fixture = path.join(tmp, "fixture");
const gitFixture = path.join(tmp, "git-fixture");
process.env.MCP_CODING_LOOP_STATE_DIR = path.join(tmp, "loops");
process.env.MCP_EDIT_TRANSACTION_STATE_DIR = path.join(tmp, "transactions");
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

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(path.join(fixture, "src"), { recursive: true });
await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({
  name: "phase3-fixture",
  scripts: { build: "node -e \"console.log('BUILD_OK')\"" },
}, null, 2));
const sourcePath = path.join(fixture, "src", "marker.ts");
const originalSource = "export const marker = 'ORIGINAL';\n";
await fs.writeFile(sourcePath, originalSource);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(fixture, 30, [fixture], true);
const client = new Client({ name: "phase3-runtime-test", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);
const call = async (name, args) => client.callTool({ name, arguments: args });

await run("Phase 3 coding-loop tools are exposed in slim", async () => {
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of ["coding_loop", "coding_loop_status"]) {
    if (!names.has(name)) throw new Error(`${name} not exposed`);
  }
});

let completedLoopId;
await run("coding loop drives failure repair pass and accept", async () => {
  await fs.writeFile(sourcePath, originalSource);
  const verifier = `node -e \"const fs=require('fs');const s=fs.readFileSync('src/marker.ts','utf8');if(!s.includes('FIXED')){console.error('Error: expected FIXED marker');process.exit(1)};console.log('VERIFY_OK')\"`;
  const began = await call("coding_loop", {
    action: "begin",
    goal: "replace marker and verify",
    workspace: fixture,
    verification_preset: "custom",
    commands: [{ label: "marker-check", command: verifier, timeout_seconds: 30 }],
    max_attempts: 3,
  });
  const loop = began.structuredContent?.data?.loop;
  if (!loop?.id || !loop.transaction_id || loop.phase !== "editing") throw new Error(JSON.stringify(began));
  completedLoopId = loop.id;

  const firstVerify = await call("coding_loop", { action: "verify", id: loop.id });
  const first = firstVerify.structuredContent?.data;
  if (first?.loop?.phase !== "repair" || first?.verification?.failed !== 1) throw new Error(JSON.stringify(firstVerify));
  if (first?.verification?.failures?.[0]?.evidence?.join(" ").includes("FIXED") !== true) throw new Error("missing compact failure evidence");

  const edited = await call("edit_file", {
    path: sourcePath,
    old_text: "ORIGINAL",
    new_text: "FIXED",
    transaction_id: loop.transaction_id,
  });
  if (edited.structuredContent?.data?.transaction_id !== loop.transaction_id) throw new Error(JSON.stringify(edited));

  const secondVerify = await call("coding_loop", { action: "verify", id: loop.id });
  if (secondVerify.structuredContent?.data?.loop?.phase !== "ready" || secondVerify.structuredContent?.data?.verification?.failed !== 0) {
    throw new Error(JSON.stringify(secondVerify));
  }

  const finished = await call("coding_loop", { action: "finish", id: loop.id });
  if (finished.structuredContent?.data?.loop?.status !== "completed") throw new Error(JSON.stringify(finished));
  const transaction = await getEditTransaction(loop.transaction_id);
  if (transaction.status !== "accepted") throw new Error(`transaction=${transaction.status}`);
  if (!(await fs.readFile(sourcePath, "utf8")).includes("FIXED")) throw new Error("accepted edit missing");
});

await run("completed loop persists and read-only status can resume context", async () => {
  const stored = await getCodingLoop(completedLoopId);
  if (stored.status !== "completed" || stored.attempts.length !== 2) throw new Error(JSON.stringify(stored));
  const status = await call("coding_loop_status", { id: completedLoopId });
  if (status.structuredContent?.data?.loop?.status !== "completed") throw new Error(JSON.stringify(status));
  const listed = await listCodingLoops(20);
  if (!listed.some((item) => item.id === completedLoopId)) throw new Error("completed loop missing from durable list");
});

await run("coding loop refuses stale verification after external or transaction-linked edits", async () => {
  await fs.writeFile(sourcePath, originalSource);
  const began = await call("coding_loop", {
    action: "begin", goal: "reject stale green verification", workspace: fixture,
    verification_preset: "custom", max_attempts: 4,
    commands: [{ label: "pass", command: "node -e \"console.log('PASS')\"", timeout_seconds: 30 }],
  });
  const loop = began.structuredContent?.data?.loop;
  if (!loop?.id || !loop.transaction_id) throw new Error(JSON.stringify(began));
  const changed = await call("edit_file", {
    path: sourcePath, old_text: "ORIGINAL", new_text: "PASSED", transaction_id: loop.transaction_id,
  });
  if (changed.isError) throw new Error(JSON.stringify(changed));
  const first = await call("coding_loop", { action: "verify", id: loop.id });
  if (first.structuredContent?.data?.loop?.phase !== "ready") throw new Error(JSON.stringify(first));
  await fs.writeFile(sourcePath, "export const marker = 'OUTSIDE';\n");
  const staleStatus = await call("coding_loop_status", { id: loop.id });
  if (staleStatus.structuredContent?.data?.verification_current !== false
      || !/File changed/.test(staleStatus.structuredContent?.data?.verification_issue || "")) {
    throw new Error("status failed to surface out-of-band stale verification: " + JSON.stringify(staleStatus));
  }
  const stale = await call("coding_loop", { action: "finish", id: loop.id });
  if (!stale.isError || !/File changed after verification/.test(JSON.stringify(stale))) {
    throw new Error("out-of-band change incorrectly accepted: " + JSON.stringify(stale));
  }
  await fs.writeFile(sourcePath, "export const marker = 'PASSED';\n");
  const second = await call("coding_loop", { action: "verify", id: loop.id });
  if (second.structuredContent?.data?.loop?.phase !== "ready") throw new Error(JSON.stringify(second));
  const edited = await call("edit_file", {
    path: sourcePath, old_text: "PASSED", new_text: "LATER", transaction_id: loop.transaction_id,
  });
  if (edited.isError) throw new Error(JSON.stringify(edited));
  const rejected = await call("coding_loop", { action: "finish", id: loop.id });
  if (!rejected.isError || !/current verification/.test(JSON.stringify(rejected))) {
    throw new Error("tracked edit incorrectly reused old verification: " + JSON.stringify(rejected));
  }
  const again = await call("coding_loop", { action: "verify", id: loop.id });
  if (again.structuredContent?.data?.loop?.phase !== "ready") throw new Error(JSON.stringify(again));
  const freshStatus = await call("coding_loop_status", { id: loop.id });
  if (freshStatus.structuredContent?.data?.verification_current !== true) {
    throw new Error("status still reports stale verification after recheck: " + JSON.stringify(freshStatus));
  }
  const finish = await call("coding_loop", { action: "finish", id: loop.id });
  if (finish.structuredContent?.data?.loop?.status !== "completed") throw new Error(JSON.stringify(finish));
});

await run("finish reconciles a transaction accepted just before loop state persisted", async () => {
  const began = await call("coding_loop", {
    action: "begin",
    goal: "recover accepted transaction finish",
    workspace: fixture,
    verification_preset: "custom",
    commands: [{ label: "noop", command: "node -e \"console.log('OK')\"", timeout_seconds: 30 }],
  });
  const loop = began.structuredContent?.data?.loop;
  if (!loop?.id || !loop.transaction_id) throw new Error(JSON.stringify(began));
  // Simulate a crash in finish() after the transaction terminal state reached
  // disk but before the coding-loop record was marked completed.
  await acceptEditTransaction(loop.transaction_id);
  const finished = await call("coding_loop", { action: "finish", id: loop.id, allow_unverified: true });
  if (finished.structuredContent?.data?.loop?.status !== "completed") throw new Error(JSON.stringify(finished));
  const second = await call("coding_loop", { action: "finish", id: loop.id, allow_unverified: true });
  if (second.structuredContent?.data?.loop?.status !== "completed" || !second.structuredContent?.data?.reconciled) {
    throw new Error(`finish was not idempotent: ${JSON.stringify(second)}`);
  }
});

await run("verification budget exhausts and can be explicitly extended", async () => {
  const alwaysFail = `node -e \"console.error('Error: deliberate phase3 failure');process.exit(2)\"`;
  const began = await call("coding_loop", {
    action: "begin",
    goal: "exercise retry budget",
    workspace: fixture,
    verification_preset: "custom",
    commands: [{ label: "always-fail", command: alwaysFail, timeout_seconds: 30 }],
    max_attempts: 1,
  });
  const loop = began.structuredContent?.data?.loop;
  const verified = await call("coding_loop", { action: "verify", id: loop.id });
  if (verified.structuredContent?.data?.loop?.status !== "failed") throw new Error(JSON.stringify(verified));
  const resumed = await call("coding_loop", { action: "resume", id: loop.id, extend_attempts: 2 });
  if (resumed.structuredContent?.data?.loop?.status !== "active" || resumed.structuredContent?.data?.loop?.max_attempts !== 3) {
    throw new Error(JSON.stringify(resumed));
  }
  const rolled = await call("coding_loop", { action: "rollback", id: loop.id });
  if (rolled.structuredContent?.data?.loop?.status !== "cancelled") throw new Error(JSON.stringify(rolled));
});

await run("failed loop at the hard retry cap cannot be reopened without budget", async () => {
  const began = await call("coding_loop", {
    action: "begin",
    goal: "retry cap guard",
    workspace: fixture,
    verification_preset: "custom",
    commands: [{ label: "noop", command: "node -e \"console.log('OK')\"", timeout_seconds: 30 }],
    max_attempts: 8,
  });
  const loop = await getCodingLoop(began.structuredContent?.data?.loop?.id);
  loop.status = "failed";
  loop.phase = "failed";
  loop.failed_at = new Date().toISOString();
  await saveCodingLoop(loop);
  const resumed = await call("coding_loop", { action: "resume", id: loop.id, extend_attempts: 1 });
  if (!resumed.isError || !/maximum verification budget/.test(JSON.stringify(resumed))) {
    throw new Error(`retry-cap reopen was not rejected: ${JSON.stringify(resumed)}`);
  }
  const rolled = await call("coding_loop", { action: "rollback", id: loop.id });
  if (rolled.structuredContent?.data?.loop?.status !== "cancelled") throw new Error(JSON.stringify(rolled));
});

await run("coding loop ids reject path traversal", async () => {
  let rejected = false;
  try {
    await getCodingLoop("../../outside");
  } catch (error) {
    rejected = /Invalid coding loop id/.test(String(error));
  }
  if (!rejected) throw new Error("path-traversal coding-loop id was not rejected");
});

await run("option-like Git base_ref values are rejected before worktree creation", async () => {
  const result = await call("coding_loop", {
    action: "begin",
    goal: "reject option-like git ref",
    workspace: fixture,
    isolation: "worktree",
    base_ref: "--help",
  });
  if (!result.isError || !/base_ref must be a Git revision/.test(JSON.stringify(result))) {
    throw new Error(`option-like base_ref was not rejected: ${JSON.stringify(result)}`);
  }
});

await run("coding-loop pruning preserves active loops under >500 record pressure", async () => {
  const pressureDir = path.join(tmp, "loop-retention");
  await fs.rm(pressureDir, { recursive: true, force: true });
  await fs.mkdir(pressureDir, { recursive: true });
  const now = Date.now();
  const activeId = "loop_aaaaaaaaaaaaaa";
  const records = [];
  for (let index = 0; index < 499; index++) {
    const id = `loop_${index.toString(16).padStart(14, "0")}`;
    const at = new Date(now - 1_000_000 + index).toISOString();
    records.push({
      version: 1,
      id,
      goal: "terminal history",
      status: "completed",
      phase: "completed",
      source_workspace: fixture,
      workspace: fixture,
      transaction_id: "tx_00000000000000",
      verification: { preset: "quick", stop_on_failure: false },
      max_attempts: 1,
      attempts: [],
      context: {},
      isolation: { mode: "none", source_workspace: fixture, workspace: fixture },
      notes: [],
      created_at: at,
      updated_at: at,
      completed_at: at,
    });
  }
  records.push({
    version: 1,
    id: activeId,
    goal: "protected active",
    status: "active",
    phase: "editing",
    source_workspace: fixture,
    workspace: fixture,
    transaction_id: "tx_00000000000000",
    verification: { preset: "quick", stop_on_failure: false },
    max_attempts: 1,
    attempts: [],
    context: {},
    isolation: { mode: "none", source_workspace: fixture, workspace: fixture },
    notes: [],
    created_at: new Date(now - 2_000_000).toISOString(),
    updated_at: new Date(now - 2_000_000).toISOString(),
  });
  await Promise.all(records.map((record) => fs.writeFile(path.join(pressureDir, `${record.id}.json`), JSON.stringify(record), "utf-8")));
  const previous = process.env.MCP_CODING_LOOP_STATE_DIR;
  process.env.MCP_CODING_LOOP_STATE_DIR = pressureDir;
  try {
    const began = await call("coding_loop", {
      action: "begin",
      goal: "pressure newcomer",
      workspace: fixture,
      verification_preset: "custom",
      commands: [{ label: "noop", command: "node -e \"console.log('OK')\"", timeout_seconds: 30 }],
    });
    const newId = began.structuredContent?.data?.loop?.id;
    if (!newId) throw new Error(JSON.stringify(began));
    if (!(await getCodingLoop(activeId))) throw new Error("existing active loop was pruned");
    if (!(await getCodingLoop(newId))) throw new Error("new active loop was pruned");
    const jsonFiles = (await fs.readdir(pressureDir)).filter((name) => /^loop_[0-9a-f]{14}\.json$/i.test(name));
    if (jsonFiles.length !== 500) throw new Error(`expected 500 retained coding-loop records, found ${jsonFiles.length}`);
    await call("coding_loop", { action: "rollback", id: newId, force: true });
  } finally {
    process.env.MCP_CODING_LOOP_STATE_DIR = previous;
    await fs.rm(pressureDir, { recursive: true, force: true });
  }
});

await run("coding loop rollback restores only transaction-owned edits", async () => {
  await fs.writeFile(sourcePath, originalSource);
  const began = await call("coding_loop", {
    action: "begin",
    goal: "rollback marker",
    workspace: fixture,
    verification_preset: "custom",
    commands: [{ label: "noop", command: "node -e \"console.log('OK')\"", timeout_seconds: 30 }],
  });
  const loop = began.structuredContent?.data?.loop;
  await call("edit_file", {
    path: sourcePath,
    old_text: "ORIGINAL",
    new_text: "TEMPORARY",
    transaction_id: loop.transaction_id,
  });
  const rolled = await call("coding_loop", { action: "rollback", id: loop.id });
  if (rolled.structuredContent?.data?.loop?.status !== "cancelled") throw new Error(JSON.stringify(rolled));
  if (await fs.readFile(sourcePath, "utf8") !== originalSource) throw new Error("coding-loop rollback did not restore baseline");
});

await run("coding loop refresh attaches bounded repository intelligence", async () => {
  const began = await call("coding_loop", {
    action: "begin",
    goal: "refresh context",
    workspace: fixture,
    verification_preset: "custom",
    commands: [{ label: "noop", command: "node -e \"console.log('OK')\"", timeout_seconds: 30 }],
  });
  const loop = began.structuredContent?.data?.loop;
  const refreshed = await call("coding_loop", {
    action: "refresh",
    id: loop.id,
    query: "marker",
    intel_action: "impact",
    max_results: 20,
  });
  const data = refreshed.structuredContent?.data;
  if (!data?.loop?.context?.intel || data.loop.context.intel.query !== "marker") throw new Error(JSON.stringify(refreshed));
  if (!data?.intel || !["semantic", "lexical"].includes(data.intel.mode)) throw new Error(JSON.stringify(refreshed));
  await call("coding_loop", { action: "rollback", id: loop.id });
});

await run("worktree-isolated loop never mutates source checkout and exposes handoff", async () => {
  await fs.mkdir(gitFixture, { recursive: true });
  git(gitFixture, ["init"]);
  git(gitFixture, ["config", "user.email", "phase3@example.invalid"]);
  git(gitFixture, ["config", "user.name", "Phase3 Test"]);
  await fs.writeFile(path.join(gitFixture, "package.json"), JSON.stringify({ name: "phase3-git" }, null, 2));
  const trackedPath = path.join(gitFixture, "tracked.txt");
  await fs.writeFile(trackedPath, "SOURCE\n");
  git(gitFixture, ["add", "."]);
  git(gitFixture, ["commit", "-m", "fixture"]);

  const worktreePath = path.join(tmp, "isolated-worktree");
  const began = await call("coding_loop", {
    action: "begin",
    goal: "edit isolated checkout",
    workspace: gitFixture,
    isolation: "worktree",
    worktree_path: worktreePath,
    verification_preset: "custom",
    commands: [{ label: "isolated-check", command: "node -e \"const fs=require('fs');process.exit(fs.readFileSync('tracked.txt','utf8').includes('ISOLATED')?0:1)\"", timeout_seconds: 30 }],
  });
  const loop = began.structuredContent?.data?.loop;
  if (loop?.isolation?.mode !== "worktree" || loop.workspace !== path.resolve(worktreePath)) throw new Error(JSON.stringify(began));
  const worktreeFile = path.join(loop.workspace, "tracked.txt");
  await call("edit_file", {
    path: worktreeFile,
    old_text: "SOURCE",
    new_text: "ISOLATED",
    transaction_id: loop.transaction_id,
  });
  const verified = await call("coding_loop", { action: "verify", id: loop.id });
  if (verified.structuredContent?.data?.verification?.failed !== 0) throw new Error(JSON.stringify(verified));
  const finished = await call("coding_loop", { action: "finish", id: loop.id });
  const handoff = finished.structuredContent?.data?.handoff;
  if (!handoff?.branch || handoff.worktree_path !== path.resolve(worktreePath)) throw new Error(JSON.stringify(finished));
  if (handoff.auto_commit !== false || !/commit them inside the worktree first/i.test(handoff.merge_hint || "")) {
    throw new Error(`worktree handoff could imply uncommitted changes are mergeable: ${JSON.stringify(handoff)}`);
  }
  if (await fs.readFile(trackedPath, "utf8") !== "SOURCE\n") throw new Error("source checkout was mutated by isolated loop");
  if (!(await fs.readFile(worktreeFile, "utf8")).includes("ISOLATED")) throw new Error("isolated edit missing");

  const cleaned = await call("coding_loop", { action: "cleanup", id: loop.id, force: true });
  if (!cleaned.structuredContent?.data?.loop?.isolation?.cleaned_at) throw new Error(JSON.stringify(cleaned));
  try {
    await fs.access(worktreePath);
    throw new Error("worktree path still exists after cleanup");
  } catch (error) {
    if ((error).code !== "ENOENT") throw error;
  }
  const branches = git(gitFixture, ["branch", "--list", handoff.branch]);
  if (!branches.includes(handoff.branch.split("/").pop()) && !branches.includes(handoff.branch)) throw new Error("handoff branch was unexpectedly deleted");
});

await run("manually deleted worktree still converges to cleaned loop state", async () => {
  const worktreePath = path.join(tmp, "manually-deleted-worktree");
  const began = await call("coding_loop", {
    action: "begin",
    goal: "manual worktree deletion recovery",
    workspace: gitFixture,
    isolation: "worktree",
    worktree_path: worktreePath,
    verification_preset: "custom",
    commands: [{ label: "noop", command: "node -e \"console.log('OK')\"", timeout_seconds: 30 }],
  });
  const loop = began.structuredContent?.data?.loop;
  if (!loop?.id || loop.isolation?.mode !== "worktree") throw new Error(JSON.stringify(began));
  const verified = await call("coding_loop", { action: "verify", id: loop.id });
  if (verified.structuredContent?.data?.verification?.failed !== 0) throw new Error(JSON.stringify(verified));
  const finished = await call("coding_loop", { action: "finish", id: loop.id });
  if (finished.structuredContent?.data?.loop?.status !== "completed") throw new Error(JSON.stringify(finished));

  await fs.rm(worktreePath, { recursive: true, force: true });
  const cleaned = await call("coding_loop", { action: "cleanup", id: loop.id, force: true });
  if (!cleaned.structuredContent?.data?.loop?.isolation?.cleaned_at) throw new Error(JSON.stringify(cleaned));
  const worktreeList = git(gitFixture, ["worktree", "list", "--porcelain"]);
  if (worktreeList.includes(path.resolve(worktreePath))) throw new Error("stale worktree metadata remained after manual deletion recovery");
});

await client.close().catch(() => {});
await server.close().catch(() => {});
await shutdownLspSessions().catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 500));
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
