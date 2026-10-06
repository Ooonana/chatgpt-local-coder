import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
const { createTunnelSupervisor, redactTunnelDiagnosticText } = await import("../dist/lib/tunnel-supervisor.js");
const { shutdownManagedProcesses } = await import("../dist/tools/shell.js");
const subagentManager = await import("../dist/lib/subagent-manager.js");
const { SCHEMA_CONTRACT_VERSION } = await import("../dist/lib/runtime-identity.js");
const { SLIM_CHATGPT_TOOLS } = await import("../dist/lib/tool-profile.js");
const { isPathInside } = await import("../dist/lib/path-identity.js");
const { createMcpServer } = await import("../dist/server-factory.js");

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

async function openMcp(label, defaultWorkspace = temp) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(defaultWorkspace, 20, [temp], true, undefined, undefined, label);
  const client = new Client({ name: label, version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
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

await test("two live clones of one remote remain distinct projects", async () => {
  const cloneA = path.join(temp, "clone-a");
  const cloneB = path.join(temp, "clone-b");
  for (const root of [cloneA, cloneB]) {
    await fs.mkdir(root, { recursive: true });
    const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    if (init.status !== 0) throw new Error(init.stderr || "git init failed");
    const remote = spawnSync("git", ["remote", "add", "origin", "https://github.com/Example/Live-Clone-Fixture.git"], { cwd: root, encoding: "utf8" });
    if (remote.status !== 0) throw new Error(remote.stderr || "git remote add failed");
  }
  await inSession("phase6-live-clones", async () => {
    await affinity.recordProjectAffinity(cloneA);
    await affinity.recordProjectAffinity(cloneB);
    const state = await affinity.getProjectAffinity();
    const matches = state.recents.filter((entry) => entry.identity === "git:github.com/example/live-clone-fixture");
    assert.equal(matches.length, 2);
    assert.ok(matches.some((entry) => path.resolve(entry.root) === path.resolve(cloneA)));
    assert.ok(matches.some((entry) => path.resolve(entry.root) === path.resolve(cloneB)));
  });
});

await test("project-bound sessions block cross-project mutation paths", async () => {
  await inSession("phase6-a", async () => {
    sessionContext.bindCurrentSessionProject(projectA, "A");
    await sessionContext.assertCurrentSessionMutationPath(path.join(projectA, "inside.txt"), "test");
    await assert.rejects(
      () => sessionContext.assertCurrentSessionMutationPath(path.join(projectB, "outside.txt"), "test"),
      /Cross-workspace mutation blocked/
    );
    sessionContext.bindCurrentSessionMachine();
    await sessionContext.assertCurrentSessionMutationPath(path.join(projectB, "outside.txt"), "machine test");
  });
});

await test("path containment accepts child names beginning with two dots", async () => {
  assert.equal(isPathInside(projectA, path.join(projectA, "..cache", "artifact.bin")), true);
  assert.equal(isPathInside(projectA, path.join(projectA, "..", "escaped.bin")), false);
});

await test("project mutation guard resolves symlink or junction escapes", async () => {
  const linkPath = path.join(projectA, "linked-project-b");
  let created = false;
  try {
    await fs.symlink(projectB, linkPath, process.platform === "win32" ? "junction" : "dir");
    created = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }
  if (!created) return;
  try {
    await inSession("phase6-symlink-guard", async () => {
      sessionContext.bindCurrentSessionProject(projectA, "A");
      await assert.rejects(
        () => sessionContext.assertCurrentSessionMutationPath(path.join(linkPath, "escape.txt"), "symlink test"),
        /Cross-workspace mutation blocked/
      );
    });
  } finally {
    await fs.rm(linkPath, { recursive: true, force: true });
  }
});

await test("task-linked process rejects a symlinked cwd into another project", async () => {
  const linkPath = path.join(projectA, "linked-task-project-b");
  let created = false;
  try {
    await fs.symlink(projectB, linkPath, process.platform === "win32" ? "junction" : "dir");
    created = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }
  if (!created) return;
  try {
    const task = await inSession("phase6-symlink-task", () => tasks.createAgentTask({
      title: "symlink task guard",
      objective: "reject canonical workspace escape",
      workspace: projectA,
      plan: ["wait"],
    }));
    const mcp = await openMcp("phase6-symlink-task-mcp", projectA);
    try {
      const result = await mcp.call("start_process", {
        command: "node -e \"setTimeout(() => {}, 1000)\"",
        working_directory: linkPath,
        task_id: task.id,
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /outside agent task/i);
    } finally {
      await mcp.close();
    }
  } finally {
    await fs.rm(linkPath, { recursive: true, force: true });
  }
});

await test("transaction-linked shell rejects a symlinked cwd into another project", async () => {
  const linkPath = path.join(projectA, "linked-transaction-project-b");
  let created = false;
  try {
    await fs.symlink(projectB, linkPath, process.platform === "win32" ? "junction" : "dir");
    created = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }
  if (!created) return;
  const tx = await inSession("phase6-symlink-tx", () => transactions.beginEditTransaction(projectA, "symlink tx guard"));
  const mcp = await openMcp("phase6-symlink-tx-mcp", projectA);
  try {
    const result = await mcp.call("run_command", {
      command: "echo should-not-run",
      working_directory: linkPath,
      transaction_id: tx.id,
      mutation_paths: [path.join(projectA, "symlink-guard.txt")],
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /outside edit transaction/i);
  } finally {
    await mcp.close();
    await transactions.abandonEditTransaction(tx.id).catch(() => {});
    await fs.rm(linkPath, { recursive: true, force: true });
  }
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

await test("background process cannot attach a foreign-project task", async () => {
  const mcp = await openMcp("phase6-process-link", projectB);
  try {
    const result = await mcp.call("start_process", {
      command: "node -e \"setTimeout(() => {}, 1000)\"",
      working_directory: projectB,
      task_id: taskId,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /outside agent task/i);
  } finally {
    await mcp.close();
  }
});

await test("verification cannot append results to a foreign-project task", async () => {
  const mcp = await openMcp("phase6-verify-link", projectB);
  try {
    const result = await mcp.call("verify_project", {
      path: projectB,
      preset: "custom",
      commands: [{ label: "noop", command: "node -e \"process.exit(0)\"", timeout_seconds: 30 }],
      task_id: taskId,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /not verification workspace/i);
  } finally {
    await mcp.close();
  }
});

await test("identical long processes for different tasks are not conflated", async () => {
  const secondTask = await inSession("phase6-second-task", () => tasks.createAgentTask({
    title: "second task",
    objective: "keep duplicate process ownership separate",
    workspace: projectA,
    plan: ["wait"],
  }));
  const mcp = await openMcp("phase6-process-duplicates", projectA);
  const command = "node -e \"setTimeout(() => {}, 20000)\"";
  let firstId;
  let secondId;
  try {
    const first = await mcp.call("start_process", {
      command,
      working_directory: projectA,
      task_id: taskId,
      label: "duplicate-fixture-a",
    });
    const second = await mcp.call("start_process", {
      command,
      working_directory: projectA,
      task_id: secondTask.id,
      label: "duplicate-fixture-b",
    });
    firstId = first.structuredContent?.data?.id;
    secondId = second.structuredContent?.data?.id;
    assert.ok(firstId && secondId);
    assert.notEqual(firstId, secondId);
    assert.equal(first.structuredContent?.data?.reused, false);
    assert.equal(second.structuredContent?.data?.reused, false);
  } finally {
    if (firstId) {
      const stopped = await mcp.call("stop_process", { id: firstId, workspace: projectA, force: true });
      assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
    }
    if (secondId) {
      const stopped = await mcp.call("stop_process", { id: secondId, workspace: projectA, force: true });
      assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
    }
    await mcp.close();
  }
});

await test("process control requires the matching project workspace after transport loss", async () => {
  const owner = await openMcp("phase6-process-control-owner", projectA);
  const command = "node -e \"setTimeout(() => {}, 20000)\"";
  let processId;
  try {
    const started = await owner.call("start_process", {
      command,
      working_directory: projectA,
      task_id: taskId,
      label: "control-fixture",
    });
    processId = started.structuredContent?.data?.id;
    assert.ok(processId);
    assert.equal(started.structuredContent?.data?.reused, false, JSON.stringify(started));
  } finally {
    await owner.close();
  }

  const fresh = await openMcp("phase6-process-control-fresh", temp);
  try {
    const unbound = await fresh.call("stop_process", { id: processId, force: true });
    assert.equal(unbound.isError, true);
    assert.match(JSON.stringify(unbound), /workspace is required/i);

    const wrong = await fresh.call("stop_process", { id: processId, workspace: projectB, force: true });
    assert.equal(wrong.isError, true);
    assert.match(JSON.stringify(wrong), /not requested workspace/i);

    const stopped = await fresh.call("stop_process", { id: processId, workspace: projectA, force: true });
    assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  } finally {
    await fresh.close();
  }
});

await test("PTY control requires the matching project workspace after transport loss", async () => {
  const owner = await openMcp("phase6-pty-control-owner", projectA);
  let ptyId;
  try {
    const started = await owner.call("pty", {
      action: "start",
      command: "node -e \"setTimeout(() => {}, 20000)\"",
      working_directory: projectA,
    });
    ptyId = started.structuredContent?.data?.id;
    assert.ok(ptyId, JSON.stringify(started));
  } finally {
    await owner.close();
  }

  const fresh = await openMcp("phase6-pty-control-fresh", temp);
  try {
    const unbound = await fresh.call("pty", { action: "stop", id: ptyId });
    assert.equal(unbound.isError, true);
    assert.match(JSON.stringify(unbound), /workspace is required/i);

    const wrong = await fresh.call("pty", { action: "stop", id: ptyId, workspace: projectB });
    assert.equal(wrong.isError, true);
    assert.match(JSON.stringify(wrong), /outside the requested workspace/i);

    const stopped = await fresh.call("pty", { action: "stop", id: ptyId, workspace: projectA });
    assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  } finally {
    await fresh.close();
  }
});

await test("subagent control requires the matching project workspace after transport loss", async () => {
  const previousConfig = process.env.SUBAGENT_CONFIG;
  const configPath = path.join(temp, "phase6-subagents.json");
  const runner = path.join(temp, "phase6-subagent-runner.mjs");
  await fs.writeFile(runner, "setTimeout(() => process.exit(0), 20000);\n", "utf8");
  process.env.SUBAGENT_CONFIG = configPath;
  await subagentManager.saveSubagentConfig({
    enabled: true,
    executable: process.execPath,
    args: [runner],
    prompt_via_stdin: true,
    timeout_ms: 30000,
    max_concurrency: 2,
    isolation: "none",
  });

  const owner = await openMcp("phase6-subagent-control-owner", projectA);
  let subagentId;
  try {
    const started = await owner.call("subagent", {
      action: "spawn",
      objective: "wait for explicit recovery stop",
      workspace: projectA,
      label: "phase6-scope-fixture",
    });
    subagentId = started.structuredContent?.data?.agent?.id;
    assert.ok(subagentId, JSON.stringify(started));
  } finally {
    await owner.close();
  }

  const fresh = await openMcp("phase6-subagent-control-fresh", temp);
  try {
    const unbound = await fresh.call("subagent", { action: "stop", id: subagentId });
    assert.equal(unbound.isError, true);
    assert.match(JSON.stringify(unbound), /workspace is required/i);

    const wrong = await fresh.call("subagent", { action: "stop", id: subagentId, workspace: projectB });
    assert.equal(wrong.isError, true);
    assert.match(JSON.stringify(wrong), /outside the requested workspace/i);

    const stopped = await fresh.call("subagent", { action: "stop", id: subagentId, workspace: projectA });
    assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
    assert.equal(stopped.structuredContent?.data?.agent?.running, false);
    const cleared = await fresh.call("subagent", {
      action: "clear",
      workspace: projectA,
      remove_worktrees: false,
    });
    assert.equal(cleared.isError, undefined, JSON.stringify(cleared));
  } finally {
    await fresh.close();
    if (previousConfig === undefined) delete process.env.SUBAGENT_CONFIG;
    else process.env.SUBAGENT_CONFIG = previousConfig;
  }
});

await test("run_command transaction cannot cross project workspace", async () => {
  const tx = await inSession("phase6-cross-tx", () => transactions.beginEditTransaction(projectA, "cross project guard"));
  const mcp = await openMcp("phase6-cross-tx-mcp", projectB);
  try {
    const result = await mcp.call("run_command", {
      command: "echo should-not-run",
      working_directory: projectB,
      transaction_id: tx.id,
      mutation_paths: [path.join(projectA, "guard.txt")],
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /outside edit transaction/i);
  } finally {
    await mcp.close();
    await transactions.abandonEditTransaction(tx.id);
  }
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

await test("capsule id cannot resume against a different workspace", async () => {
  const capsule = await inSession("phase6-capsule-owner", () => capsules.checkpointContextCapsule({
    workspace: projectB,
    summary: "workspace-bound capsule",
    semantic_mode: "replace",
  }));
  await assert.rejects(
    () => capsules.resumeContextCapsule({ id: capsule.id, workspace: projectA }),
    /different workspace/i
  );
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

await test("healthy endpoint with stale tunnel profile is not silently reused", async () => {
  const previous = {
    manage: process.env.LOCAL_CODER_MANAGE_TUNNEL,
    id: process.env.OPENAI_TUNNEL_ID,
    key: process.env.OPENAI_TUNNEL_API_KEY,
    health: process.env.OPENAI_TUNNEL_HEALTH_PORT,
  };
  const http = createHttpServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ready");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate health port");
  const tunnelRoot = path.join(temp, "stale-tunnel");
  await fs.mkdir(path.join(tunnelRoot, "profiles"), { recursive: true });
  await fs.writeFile(path.join(tunnelRoot, "profiles", "codex-local.yaml"), "stale-profile\n");
  try {
    process.env.LOCAL_CODER_MANAGE_TUNNEL = "1";
    process.env.OPENAI_TUNNEL_ID = "phase6-stale-profile";
    process.env.OPENAI_TUNNEL_API_KEY = "test-key";
    process.env.OPENAI_TUNNEL_HEALTH_PORT = String(address.port);
    const supervisor = createTunnelSupervisor({ root: tunnelRoot, mcpPort: 3000 });
    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    const snapshot = supervisor.snapshot();
    assert.equal(snapshot.status, "degraded");
    assert.equal(snapshot.reused_external, false);
    assert.match(String(snapshot.last_error), /profile does not match/i);
    await supervisor.stop();
  } finally {
    await new Promise((resolve) => http.close(resolve));
    if (previous.manage === undefined) delete process.env.LOCAL_CODER_MANAGE_TUNNEL;
    else process.env.LOCAL_CODER_MANAGE_TUNNEL = previous.manage;
    if (previous.id === undefined) delete process.env.OPENAI_TUNNEL_ID;
    else process.env.OPENAI_TUNNEL_ID = previous.id;
    if (previous.key === undefined) delete process.env.OPENAI_TUNNEL_API_KEY;
    else process.env.OPENAI_TUNNEL_API_KEY = previous.key;
    if (previous.health === undefined) delete process.env.OPENAI_TUNNEL_HEALTH_PORT;
    else process.env.OPENAI_TUNNEL_HEALTH_PORT = previous.health;
  }
});

await test("tunnel diagnostics redact MCP and API secrets", async () => {
  const previous = {
    token: process.env.MCP_TOKEN,
    apiKey: process.env.OPENAI_TUNNEL_API_KEY,
    controlPlaneKey: process.env.CONTROL_PLANE_API_KEY,
  };
  try {
    process.env.MCP_TOKEN = "phase6-secret-mcp-token";
    process.env.OPENAI_TUNNEL_API_KEY = "phase6-secret-api-key";
    process.env.CONTROL_PLANE_API_KEY = "phase6-secret-control-key";
    const redacted = redactTunnelDiagnosticText(
      "target=http://127.0.0.1:3000/mcp/phase6-secret-mcp-token " +
      "api=phase6-secret-api-key control=phase6-secret-control-key"
    );
    assert.doesNotMatch(redacted, /phase6-secret-mcp-token/);
    assert.doesNotMatch(redacted, /phase6-secret-api-key/);
    assert.doesNotMatch(redacted, /phase6-secret-control-key/);
    assert.match(redacted, /\[REDACTED\]/);
  } finally {
    if (previous.token === undefined) delete process.env.MCP_TOKEN;
    else process.env.MCP_TOKEN = previous.token;
    if (previous.apiKey === undefined) delete process.env.OPENAI_TUNNEL_API_KEY;
    else process.env.OPENAI_TUNNEL_API_KEY = previous.apiKey;
    if (previous.controlPlaneKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
    else process.env.CONTROL_PLANE_API_KEY = previous.controlPlaneKey;
  }
});

await test("Phase 6 schema/tool budget contract is explicit", async () => {
  assert.equal(SCHEMA_CONTRACT_VERSION, 7);
  assert.ok(SLIM_CHATGPT_TOOLS.size <= 40, `slim tools=${SLIM_CHATGPT_TOOLS.size}`);
});

await shutdownManagedProcesses().catch(() => {});
await fs.rm(temp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;