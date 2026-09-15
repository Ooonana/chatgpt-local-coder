import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./free-port.mjs";
import { parseMcpResponseText } from "./mcp-test-response.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-phase4-"));
const workspace = path.join(scratch, "fixture");
const stateRoot = path.join(scratch, "state");
const metrics = [];
let rpcCalls = 0;
let nextId = 1;

function metric(name, value, unit = "") {
  metrics.push({ name, value, unit });
  console.log(`METRIC ${name}=${value}${unit}`);
}

async function writeFixture() {
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "phase4-fixture",
    version: "1.0.0",
    type: "module",
    scripts: { check: "node verify.mjs", test: "node verify.mjs" },
  }, null, 2));
  await fs.writeFile(path.join(workspace, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  await fs.writeFile(path.join(workspace, "src", "consumer.js"), "import { add } from './math.js';\nexport const answer = add(20, 22);\n");
  await fs.writeFile(path.join(workspace, "verify.mjs"), [
    "import fs from 'node:fs';",
    "const text = fs.readFileSync(new URL('./src/math.js', import.meta.url), 'utf8');",
    "if (!text.includes('return a + b + 0;')) { console.error('ERROR expected repaired marker'); process.exit(1); }",
    "console.log('verification ok');",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(workspace, "noisy.mjs"), [
    "for (let i = 0; i < 5000; i++) console.error(`ERROR synthetic failure ${i} ${'x'.repeat(40)}`);",
    "process.exit(1);",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(workspace, "src", "repair.js"), "export const state = 'broken';\n");
  await fs.writeFile(path.join(workspace, "repair-verify.mjs"), [
    "import fs from 'node:fs';",
    "const text = fs.readFileSync(new URL('./src/repair.js', import.meta.url), 'utf8');",
    "if (!text.includes(\"state = 'fixed'\")) { console.error('ERROR repair fixture is still broken'); process.exit(1); }",
    "console.log('repair verification ok');",
    "",
  ].join("\n"));

  const git = (args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["config", "user.email", "phase4@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Phase4 Test"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-m", "fixture baseline"]).status, 0);
}

async function waitFor(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function stopTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("close", () => resolve());
    setTimeout(resolve, 3000).unref?.();
  });
}

async function startServer() {
  const [mcpPort, adminPort] = await getFreePorts(2);
  const env = {
    ...process.env,
    WORKSPACE_PATH: workspace,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    MCP_TOKEN: "",
    ADMIN_TOKEN: "",
    LOCAL_CODER_TUI: "off",
    CHATGPT_TOOL_PROFILE: "slim",
    MCP_AGENT_TASK_STATE_DIR: path.join(stateRoot, "agent-tasks"),
    MCP_OPERATION_STATE_DIR: path.join(stateRoot, "operations"),
    MCP_EDIT_TRANSACTION_STATE_DIR: path.join(stateRoot, "edit-transactions"),
    MCP_CODING_LOOP_STATE_DIR: path.join(stateRoot, "coding-loops"),
    MCP_CODING_LOOP_WORKTREE_ROOT: path.join(stateRoot, "worktrees"),
    MCP_SHELL_STATE_DIR: path.join(stateRoot, "shell"),
    CHECKPOINT_PATH: path.join(stateRoot, "checkpoints"),
    AUDIT_LOG_PATH: path.join(stateRoot, "audit.log"),
    MCP_UPSTREAM_CONFIG: path.join(stateRoot, "upstream.json"),
    PERMISSIONS_CONFIG: path.join(stateRoot, "permissions.json"),
    LOCAL_HOOKS_CONFIG: path.join(stateRoot, "hooks.json"),
    SUBAGENT_CONFIG: path.join(stateRoot, "subagents.json"),
    MCP_JSON_RESPONSE: "false",
    MCP_SSE_KEEPALIVE_MS: "1000",
  };
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { log += chunk.toString(); });
  child.once("error", (error) => { log += `\n${error.stack || error}`; });
  try {
    await waitFor(`http://127.0.0.1:${mcpPort}/health`);
    await waitFor(`http://127.0.0.1:${adminPort}/health`);
  } catch (error) {
    await stopTree(child);
    throw new Error(`${error.message}\n${log.slice(-4000)}`);
  }
  return { child, mcpPort, adminPort, log: () => log };
}

async function initialize(server) {
  const response = await fetch(`http://127.0.0.1:${server.mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "phase4-benchmark", version: "1" } },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`initialize HTTP ${response.status}: ${text.slice(0, 1000)}`);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize missing mcp-session-id");
  return sessionId;
}

async function rpc(server, sessionId, method, params) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${server.mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  const durationMs = Math.round(performance.now() - started);
  const bytes = Buffer.byteLength(text);
  const json = parseMcpResponseText(text, response.headers.get("content-type") || "");
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return { json, text, bytes, durationMs };
}

function payloadOf(result) {
  const rpcResult = result?.json?.result;
  if (rpcResult?.structuredContent) return rpcResult.structuredContent;
  const text = rpcResult?.content?.find?.((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function tool(server, sessionId, name, args = {}) {
  rpcCalls++;
  const result = await rpc(server, sessionId, "tools/call", { name, arguments: args });
  const payload = payloadOf(result);
  if (result.json?.error) throw new Error(`${name}: ${JSON.stringify(result.json.error)}`);
  if (result.json?.result?.isError) throw new Error(`${name}: ${payload?.summary || result.text.slice(0, 1000)}`);
  return { ...result, payload };
}

await writeFixture();
let server;
try {
  server = await startServer();
  let sessionId = await initialize(server);

  const list = await rpc(server, sessionId, "tools/list", {});
  const tools = list.json?.result?.tools || [];
  metric("slim_tools", tools.length, " tools");
  metric("tools_list_bytes", list.bytes, " bytes");
  const largestToolSchemas = tools
    .map((toolDef) => ({ name: toolDef.name, bytes: Buffer.byteLength(JSON.stringify(toolDef)) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);
  console.log(`METRIC largest_tool_schemas=${JSON.stringify(largestToolSchemas)}`);
  assert.ok(tools.length <= 50, `slim profile exceeds 50-tool discovery budget: ${tools.length}`);
  assert.ok(list.bytes <= 64 * 1024, `tools/list exceeds 64 KiB budget: ${list.bytes}`);

  const instructions = await (await fetch(`http://127.0.0.1:${server.adminPort}/api/instructions/preview`)).json();
  metric("instruction_chars", instructions.total_chars, " chars");
  assert.ok(instructions.total_chars <= 12_000, `instructions exceed 12k budget: ${instructions.total_chars}`);

  const beforeInspectCalls = rpcCalls;
  const inspect = await tool(server, sessionId, "inspect_project", { path: workspace, max_depth: 4 });
  metric("inspect_project_ms", inspect.durationMs, "ms");
  metric("inspect_project_bytes", inspect.bytes, " bytes");
  assert.equal(inspect.payload?.ok, true);
  assert.equal(rpcCalls - beforeInspectCalls, 1);
  assert.ok(inspect.bytes < 16 * 1024, `inspect_project response too large: ${inspect.bytes}`);

  const primitiveStart = rpcCalls;
  const primitiveBytes = [];
  for (const [name, args] of [
    ["list_directory", { path: workspace, ignore: [".git"] }],
    ["read_text_file", { path: path.join(workspace, "package.json"), head: 80 }],
    ["git_status", { path: workspace }],
  ]) {
    const out = await tool(server, sessionId, name, args);
    primitiveBytes.push(out.bytes);
  }
  metric("primitive_repo_inspection_calls", rpcCalls - primitiveStart, " calls");
  metric("compound_repo_inspection_calls", 1, " call");
  assert.equal(rpcCalls - primitiveStart, 3);

  const batchStart = rpcCalls;
  const batch = await tool(server, sessionId, "read_files", {
    files: [
      { path: path.join(workspace, "package.json"), head: 80, max_chars: 10_000 },
      { path: path.join(workspace, "src", "math.js"), head: 80, max_chars: 10_000 },
      { path: path.join(workspace, "src", "consumer.js"), head: 80, max_chars: 10_000 },
    ],
  });
  metric("read_files_bytes", batch.bytes, " bytes");
  assert.equal(rpcCalls - batchStart, 1);
  assert.equal(batch.payload?.data?.count, 3);

  const serialStart = rpcCalls;
  for (const file of ["package.json", "src/math.js", "src/consumer.js"]) {
    await tool(server, sessionId, "read_text_file", { path: path.join(workspace, ...file.split("/")), head: 80 });
  }
  metric("serial_read_calls", rpcCalls - serialStart, " calls");
  assert.equal(rpcCalls - serialStart, 3);

  const intel = await tool(server, sessionId, "repo_intel", {
    action: "symbol_search",
    workspace,
    query: "add",
    max_results: 40,
  });
  metric("repo_intel_ms", intel.durationMs, "ms");
  metric("repo_intel_bytes", intel.bytes, " bytes");
  assert.equal(intel.payload?.ok, true);
  assert.ok(intel.bytes < 32 * 1024, `repo_intel response too large: ${intel.bytes}`);

  const discover = await tool(server, sessionId, "verify_project", { path: workspace, preset: "discover" });
  assert.equal(discover.payload?.ok, true);
  assert.ok(discover.payload?.data?.commands?.length >= 1);

  const noisy = await tool(server, sessionId, "verify_project", {
    path: workspace,
    preset: "custom",
    commands: [{ label: "noisy failure", command: "node noisy.mjs", timeout_seconds: 30 }],
    stop_on_failure: true,
  });
  metric("noisy_raw_chars", noisy.payload?.data?.results?.[0]?.output_chars || 0, " chars");
  metric("noisy_compact_response_bytes", noisy.bytes, " bytes");
  assert.equal(noisy.payload?.ok, false);
  assert.ok((noisy.payload?.data?.results?.[0]?.output_chars || 0) > 100_000);
  assert.ok(noisy.bytes < 16 * 1024, `verification compaction response too large: ${noisy.bytes}`);

  const task = await tool(server, sessionId, "agent_task", {
    action: "start",
    title: "phase4 benchmark repair",
    objective: "Modify the arithmetic fixture and verify it through a durable coding loop.",
    workspace,
    plan: ["inspect", "edit", "verify"],
  });
  const taskId = task.payload?.data?.task?.id;
  assert.ok(taskId);

  const begin = await tool(server, sessionId, "coding_loop", {
    action: "begin",
    goal: "repair benchmark fixture",
    workspace,
    task_id: taskId,
    verification_preset: "custom",
    commands: [{ label: "fixture verify", command: "node verify.mjs", timeout_seconds: 30 }],
    max_attempts: 2,
  });
  const loopId = begin.payload?.data?.loop?.id;
  const transactionId = begin.payload?.data?.loop?.transaction_id;
  assert.ok(loopId && transactionId);

  await tool(server, sessionId, "edit_file", {
    path: path.join(workspace, "src", "math.js"),
    old_text: "return a + b;",
    new_text: "return a + b + 0;",
    transaction_id: transactionId,
  });

  // Simulate ChatGPT/MCP interruption after edits but before verification.
  await stopTree(server.child);
  server = await startServer();
  sessionId = await initialize(server);

  const resumed = await tool(server, sessionId, "coding_loop", { action: "resume", id: loopId });
  assert.equal(resumed.payload?.data?.reopened, true);
  const verified = await tool(server, sessionId, "coding_loop", { action: "verify", id: loopId });
  assert.equal(verified.payload?.ok, true);
  assert.equal(verified.payload?.data?.verification?.failed, 0);
  const finished = await tool(server, sessionId, "coding_loop", { action: "finish", id: loopId });
  assert.equal(finished.payload?.ok, true);
  assert.equal(finished.payload?.data?.loop?.status, "completed");
  metric("durable_loop_attempts", finished.payload?.data?.loop?.attempts || 0, " attempts");
  assert.equal(finished.payload?.data?.loop?.attempts, 1, "successful resumed loop should need one verification attempt");

  // Real repair cycle: first verification fails, ChatGPT edits from evidence,
  // second verification passes, and finish accepts the same transaction.
  const repairBegin = await tool(server, sessionId, "coding_loop", {
    action: "begin",
    goal: "repair an initially failing fixture",
    workspace,
    verification_preset: "custom",
    commands: [{ label: "repair test", command: "node repair-verify.mjs", timeout_seconds: 30 }],
    max_attempts: 3,
  });
  const repairLoopId = repairBegin.payload?.data?.loop?.id;
  const repairTx = repairBegin.payload?.data?.loop?.transaction_id;
  assert.ok(repairLoopId && repairTx);
  const failedAttempt = await tool(server, sessionId, "coding_loop", { action: "verify", id: repairLoopId });
  assert.equal(failedAttempt.payload?.ok, false);
  assert.equal(failedAttempt.payload?.data?.loop?.phase, "repair");
  assert.equal(failedAttempt.payload?.data?.verification?.failed, 1);
  assert.ok(failedAttempt.payload?.data?.verification?.failures?.[0]?.evidence?.length >= 1);
  await tool(server, sessionId, "edit_file", {
    path: path.join(workspace, "src", "repair.js"),
    old_text: "state = 'broken'",
    new_text: "state = 'fixed'",
    transaction_id: repairTx,
  });
  const repairedAttempt = await tool(server, sessionId, "coding_loop", { action: "verify", id: repairLoopId });
  assert.equal(repairedAttempt.payload?.ok, true);
  assert.equal(repairedAttempt.payload?.data?.loop?.phase, "ready");
  const repairFinished = await tool(server, sessionId, "coding_loop", { action: "finish", id: repairLoopId });
  assert.equal(repairFinished.payload?.ok, true);
  assert.equal(repairFinished.payload?.data?.loop?.attempts, 2);
  metric("repair_loop_attempts", repairFinished.payload?.data?.loop?.attempts, " attempts");

  // Fault injection: a malformed, correctly-shaped filename must not poison listing/health.
  const corruptId = "loop_deadbeefdeadbe";
  await fs.mkdir(path.join(stateRoot, "coding-loops"), { recursive: true });
  await fs.writeFile(path.join(stateRoot, "coding-loops", `${corruptId}.json`), "{not-json", "utf8");
  const status = await tool(server, sessionId, "coding_loop_status", { limit: 20 });
  assert.equal(status.payload?.ok, true);
  assert.ok(Array.isArray(status.payload?.data?.loops));
  const health = await (await fetch(`http://127.0.0.1:${server.mcpPort}/health`)).json();
  assert.equal(health.status, "ok");
  const adminRuntime = await (await fetch(`http://127.0.0.1:${server.adminPort}/api/runtime`)).json();
  assert.ok(
    adminRuntime.state_errors?.some?.((entry) => String(entry).includes(corruptId)),
    "Admin runtime should surface malformed durable loop state without failing the endpoint"
  );

  metric("total_benchmark_tool_calls", rpcCalls, " calls");
  metric("primitive_repo_bytes", primitiveBytes.reduce((sum, value) => sum + value, 0), " bytes");
  console.log("PHASE4_PRODUCTION_BENCHMARK_OK");
  console.log(JSON.stringify({ metrics }, null, 2));
} finally {
  await stopTree(server?.child).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
