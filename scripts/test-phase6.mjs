import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-phase6-"));
const state = path.join(temp, "state");
process.env.MCP_SHELL_STATE_DIR = path.join(state, "shell");
process.env.MCP_PROJECT_REGISTRY_PATH = path.join(state, "projects.json");
process.env.MCP_AGENT_TASK_STATE_DIR = path.join(state, "tasks");
process.env.MCP_EDIT_TRANSACTION_STATE_DIR = path.join(state, "edit-transactions");
process.env.MCP_CODING_LOOP_STATE_DIR = path.join(state, "coding-loops");
process.env.MCP_CONTEXT_CAPSULE_STATE_DIR = path.join(state, "capsules");
delete process.env.MCP_SHELL_PERSIST_CWD;

const sessionContext = await import("../dist/lib/session-context.js");
const shell = await import("../dist/lib/persistent-shell.js");
const affinity = await import("../dist/lib/project-affinity.js");
const tasks = await import("../dist/lib/agent-task-store.js");
const transactions = await import("../dist/lib/edit-transaction-store.js");
const capsules = await import("../dist/lib/context-capsule-store.js");
const { createTunnelSupervisor } = await import("../dist/lib/tunnel-supervisor.js");
const { SCHEMA_CONTRACT_VERSION } = await import("../dist/lib/runtime-identity.js");
const { SLIM_CHATGPT_TOOLS } = await import("../dist/lib/tool-profile.js");

const projectA = path.join(temp, "project-a");
const projectB = path.join(temp, "project-b");
await fs.mkdir(path.join(projectA, "sub"), { recursive: true });
await fs.mkdir(path.join(projectB, "sub"), { recursive: true });
await fs.writeFile(path.join(projectA, "package.json"), "{}");
await fs.writeFile(path.join(projectB, "package.json"), "{}");

function inSession(id, fn) {
  sessionContext.ensureSessionRuntimeState(id, temp);
  sessionContext.markSessionConnection(id, "connected", temp);
  return sessionContext.runWithSessionContext(id, fn);
}

await test("fresh MCP transports do not inherit hidden cwd by default", async () => {
  await inSession("phase6-a", async () => {
    await shell.bootstrapShellSession(projectA, "phase6-a");
    await shell.execInShellSession("cd sub", projectA, 5_000);
    assert.equal(path.resolve(shell.getShellStatus().cwd), path.resolve(projectA, "sub"));
  });
  await inSession("phase6-b", async () => {
    await shell.bootstrapShellSession(projectA, "phase6-b");
    assert.equal(path.resolve(shell.getShellStatus().cwd), path.resolve(projectA));
  });
});

await test("project execution scope is transport-local and not process-global", async () => {
  await inSession("phase6-a", async () => {
    await affinity.recordProjectAffinity(projectA);
    assert.equal((await affinity.getProjectAffinity()).active_root, path.resolve(projectA));
  });
  await inSession("phase6-b", async () => {
    await affinity.recordProjectAffinity(projectB);
    assert.equal((await affinity.getProjectAffinity()).active_root, path.resolve(projectB));
  });
  await inSession("phase6-a", async () => {
    assert.equal((await affinity.getProjectAffinity()).active_root, path.resolve(projectA));
  });
  await inSession("phase6-fresh", async () => {
    assert.equal((await affinity.getProjectAffinity()).active_root, null);
  });
});

await test("moved Git repo is reconciled by durable remote identity", async () => {
  const oldRoot = path.join(temp, "moved-old");
  const newRoot = path.join(temp, "moved-new");
  await fs.mkdir(oldRoot, { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: oldRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "git failed");
  };
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/Example/Move-Fixture.git");
  await inSession("phase6-move", async () => {
    await affinity.recordProjectAffinity(oldRoot);
  });
  await fs.rename(oldRoot, newRoot);
  affinity.clearProjectDetectionCache();
  await inSession("phase6-move", async () => {
    await affinity.recordProjectAffinity(newRoot);
    const state = await affinity.getProjectAffinity();
    const matches = state.recents.filter((entry) => entry.identity === "git:github.com/example/move-fixture");
    assert.equal(matches.length, 1);
    assert.equal(path.resolve(matches[0].root), path.resolve(newRoot));
    assert.ok((matches[0].previous_roots || []).some((candidate) => path.resolve(candidate) === path.resolve(oldRoot)));
  });
});

await test("project-bound sessions block cross-project mutation paths", async () => {
  await inSession("phase6-a", async () => {
    sessionContext.bindCurrentSessionProject(projectA, "A");
    assert.doesNotThrow(() => sessionContext.assertCurrentSessionMutationPath(path.join(projectA, "inside.txt"), "test"));
    assert.throws(
      () => sessionContext.assertCurrentSessionMutationPath(path.join(projectB, "outside.txt"), "test"),
      /Cross-workspace mutation blocked/
    );
    sessionContext.bindCurrentSessionMachine();
    assert.doesNotThrow(() => sessionContext.assertCurrentSessionMutationPath(path.join(projectB, "outside.txt"), "machine test"));
  });
});

await test("transport connection state remains diagnostic-only", async () => {
  sessionContext.ensureSessionRuntimeState("phase6-heartbeat", projectA);
  sessionContext.markSessionConnection("phase6-heartbeat", "connected", projectA);
  assert.equal(sessionContext.getSessionRuntimeState("phase6-heartbeat").connection, "connected");
  sessionContext.markSessionConnection("phase6-heartbeat", "disconnected", projectA);
  const disconnected = sessionContext.getSessionRuntimeState("phase6-heartbeat");
  assert.equal(disconnected.connection, "disconnected");
  assert.ok(disconnected.disconnected_at);
  sessionContext.markSessionConnection("phase6-heartbeat", "connected", projectA);
  assert.equal(sessionContext.getSessionRuntimeState("phase6-heartbeat").connection, "connected");
});

let taskId;
await test("durable task is resumable across changing MCP transports", async () => {
  await inSession("phase6-owner", async () => {
    const task = await tasks.createAgentTask({
      title: "owned task",
      objective: "verify session ownership",
      workspace: projectA,
      plan: ["one"],
    });
    taskId = task.id;
    assert.equal(task.session_id, "phase6-owner");
  });
  await inSession("phase6-other", async () => {
    const visible = await tasks.listAgentTasks();
    assert.equal(visible.some((task) => task.id === taskId), true);
    const resumed = await tasks.getResumableAgentTask(taskId, projectA);
    assert.equal(resumed?.id, taskId);
    assert.equal(resumed?.session_id, "phase6-owner");
  });
});

await test("abandoning an edit transaction preserves current files", async () => {
  const file = path.join(projectA, "abandon.txt");
  await fs.writeFile(file, "baseline\n");
  await inSession("phase6-tx", async () => {
    const tx = await transactions.beginEditTransaction(projectA, "phase6 abandon");
    await transactions.captureTransactionPaths(tx.id, [file]);
    await fs.writeFile(file, "keep-this-change\n");
    await transactions.recordTransactionEdit(tx.id, "phase6-test", [file]);
    const abandoned = await transactions.abandonEditTransaction(tx.id);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(await fs.readFile(file, "utf8"), "keep-this-change\n");
  });
});

await test("semantic replace clears stale blockers", async () => {
  await inSession("phase6-capsule", async () => {
    const first = await capsules.checkpointContextCapsule({
      workspace: projectB,
      summary: "old state",
      blockers: ["stale blocker"],
      semantic_mode: "replace",
    });
    const second = await capsules.checkpointContextCapsule({
      id: first.id,
      workspace: projectB,
      summary: "new state",
      semantic_mode: "replace",
    });
    assert.equal(second.semantic.summary, "new state");
    assert.deepEqual(second.semantic.blockers, []);
  });
});

await test("automatic capsule skips unchanged machine state", async () => {
  let autoTaskId;
  await inSession("phase6-auto-owner", async () => {
    const task = await tasks.createAgentTask({
      title: "auto checkpoint task",
      objective: "exercise machine-state fingerprint dedupe",
      workspace: projectB,
      plan: ["wait"],
    });
    autoTaskId = task.id;
    const first = await capsules.autoCheckpointContextCapsule({
      workspace: projectB,
      reason: "first",
      task_id: task.id,
    });
    assert.ok(first);
  });
  await inSession("phase6-auto-other", async () => {
    const second = await capsules.autoCheckpointContextCapsule({
      workspace: projectB,
      reason: "same machine state",
      task_id: autoTaskId,
    });
    assert.equal(second, null);
  });
});

await test("tunnel supervisor reports disabled and unconfigured without spawning", async () => {
  const previous = {
    manage: process.env.LOCAL_CODER_MANAGE_TUNNEL,
    id: process.env.OPENAI_TUNNEL_ID,
    key: process.env.OPENAI_TUNNEL_API_KEY,
  };
  try {
    process.env.LOCAL_CODER_MANAGE_TUNNEL = "0";
    delete process.env.OPENAI_TUNNEL_ID;
    delete process.env.OPENAI_TUNNEL_API_KEY;
    const disabled = createTunnelSupervisor({ root: temp, mcpPort: 3000 });
    await disabled.start();
    assert.equal(disabled.snapshot().status, "disabled");
    await disabled.stop();

    process.env.LOCAL_CODER_MANAGE_TUNNEL = "1";
    const unconfigured = createTunnelSupervisor({ root: temp, mcpPort: 3000 });
    await unconfigured.start();
    assert.equal(unconfigured.snapshot().status, "not_configured");
    await unconfigured.stop();
  } finally {
    if (previous.manage === undefined) delete process.env.LOCAL_CODER_MANAGE_TUNNEL;
    else process.env.LOCAL_CODER_MANAGE_TUNNEL = previous.manage;
    if (previous.id === undefined) delete process.env.OPENAI_TUNNEL_ID;
    else process.env.OPENAI_TUNNEL_ID = previous.id;
    if (previous.key === undefined) delete process.env.OPENAI_TUNNEL_API_KEY;
    else process.env.OPENAI_TUNNEL_API_KEY = previous.key;
  }
});

await test("Phase 6 schema/tool budget contract is explicit", async () => {
  assert.equal(SCHEMA_CONTRACT_VERSION, 6);
  assert.ok(SLIM_CHATGPT_TOOLS.size <= 40, `slim tools=${SLIM_CHATGPT_TOOLS.size}`);
});

await fs.rm(temp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;