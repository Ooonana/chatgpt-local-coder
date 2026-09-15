import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tool-test-tmp", "context-capsule");
const fixture = path.join(tmp, "fixture");
const state = path.join(tmp, "state");

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.MCP_AGENT_TASK_STATE_DIR = path.join(state, "tasks");
process.env.MCP_OPERATION_STATE_DIR = path.join(state, "operations");
process.env.MCP_EDIT_TRANSACTION_STATE_DIR = path.join(state, "edit-transactions");
process.env.MCP_CODING_LOOP_STATE_DIR = path.join(state, "coding-loops");
process.env.MCP_CONTEXT_CAPSULE_STATE_DIR = path.join(state, "context-capsules");
process.env.MCP_CONTEXT_CAPSULE_TOOL_CALLS = "4";
process.env.MCP_CONTEXT_CAPSULE_RESULT_BYTES = String(1024 * 1024);
process.env.MCP_CONTEXT_CAPSULE_ROLLOVER_CYCLES = "3";
process.env.PERMISSIONS_CONFIG = path.join(state, "permissions.json");
process.env.LOCAL_HOOKS_CONFIG = path.join(state, "hooks.json");
process.env.SUBAGENT_CONFIG = path.join(state, "subagents.json");

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
function fail(name, error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (error) { fail(name, error); }
}

async function openSession(label, defaultWorkspace = fixture) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const roots = [...new Set([fixture, defaultWorkspace])];
  const server = createMcpServer(defaultWorkspace, 20, roots, true);
  const client = new Client({ name: label, version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server,
    client,
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(fixture, { recursive: true });
await fs.writeFile(path.join(fixture, "note.txt"), "durable context marker\n", "utf-8");

let session = await openSession("context-capsule-first");
let taskId;
let capsuleId;

await run("context capsule is exposed in slim", async () => {
  const names = new Set((await session.client.listTools()).tools.map((tool) => tool.name));
  if (!names.has("context_capsule")) throw new Error("context_capsule missing from slim tools");
});

await run("task phase boundary automatically snapshots machine state", async () => {
  const task = await session.call("agent_task", {
    action: "start",
    title: "context loss fixture",
    objective: "Preserve working state across a lost ChatGPT conversation.",
    workspace: fixture,
    plan: ["inspect", "decide", "implement", "verify"],
  });
  taskId = task.structuredContent?.data?.task?.id;
  if (!taskId) throw new Error(JSON.stringify(task));

  const status = await session.call("context_capsule", { action: "status", workspace: fixture });
  const capsules = status.structuredContent?.data?.capsules;
  if (!Array.isArray(capsules) || !capsules.some((capsule) => capsule.task_id === taskId && capsule.auto_checkpoint_count >= 1)) {
    throw new Error(JSON.stringify(status));
  }
});

await run("manual semantic checkpoint persists decisions and next action", async () => {
  const result = await session.call("context_capsule", {
    action: "checkpoint",
    workspace: fixture,
    task_id: taskId,
    summary: "The repo was inspected. We chose the bounded capsule design and the next action is verification.",
    decisions: [
      "Do not assume ChatGPT auto-compacts conversation history.",
      "Keep ChatGPT as the reasoning model and persist only compact task state locally.",
    ],
    findings: ["agent_task survives reconnects but does not preserve detailed semantic working context."],
    blockers: [],
    next_steps: ["Run the verification step without rediscovering the design."],
    files: [{ path: path.join(fixture, "note.txt"), note: "fixture evidence already inspected" }],
  });
  const capsule = result.structuredContent?.data?.capsule;
  capsuleId = capsule?.id;
  if (!capsuleId || capsule.semantic?.decisions?.length !== 2) throw new Error(JSON.stringify(result));
  if (capsule.last_checkpoint_source !== "manual") throw new Error(`source=${capsule.last_checkpoint_source}`);
});

await session.close();
const unrelatedDefault = path.join(tmp, "unrelated-default");
await fs.mkdir(unrelatedDefault, { recursive: true });
session = await openSession("context-capsule-restarted", unrelatedDefault);

await run("new MCP/chat session resumes by id from stored workspace", async () => {
  const resumed = await session.call("context_capsule", {
    action: "resume",
    id: capsuleId,
  });
  const capsule = resumed.structuredContent?.data?.capsule;
  if (!capsule) throw new Error(JSON.stringify(resumed));
  if (capsule.workspace !== path.resolve(fixture)) throw new Error(`wrong workspace: ${capsule.workspace}`);
  if (!capsule.semantic?.summary?.includes("bounded capsule design")) throw new Error("semantic summary was lost");
  if (capsule.semantic?.next_steps?.[0] !== "Run the verification step without rediscovering the design.") {
    throw new Error(JSON.stringify(capsule.semantic?.next_steps));
  }
  if (capsule.machine?.task?.id !== taskId || capsule.machine?.task?.status !== "active") {
    throw new Error(`live task state missing: ${JSON.stringify(capsule.machine?.task)}`);
  }
});

await run("tool-budget heuristic emits semantic checkpoint hint", async () => {
  let fourth;
  for (let i = 0; i < 4; i++) {
    fourth = await session.call("read_text_file", { path: path.join(fixture, "note.txt"), head: 10 });
  }
  const hint = fourth?.structuredContent?.data?.context_checkpoint_hint;
  if (!hint?.due || !hint?.capsule_id || !String(hint.reason).includes("context budget")) {
    throw new Error(JSON.stringify(fourth));
  }
  if (hint.budget_cycles !== 1 || hint.rollover_recommended !== false) {
    throw new Error(`unexpected first-cycle hint: ${JSON.stringify(hint)}`);
  }
});

await run("repeated context budgets recommend safe fresh-chat rollover", async () => {
  let final;
  for (let i = 0; i < 8; i++) {
    final = await session.call("read_text_file", { path: path.join(fixture, "note.txt"), head: 10 });
  }
  const hint = final?.structuredContent?.data?.context_checkpoint_hint;
  if (!hint?.due || hint.budget_cycles !== 3 || hint.rollover_recommended !== true) {
    throw new Error(`rollover was not recommended on cycle 3: ${JSON.stringify(hint)}`);
  }
  if (!/fresh ChatGPT chat/i.test(String(hint.instruction || ""))) {
    throw new Error(`rollover instruction missing fresh-chat guidance: ${JSON.stringify(hint)}`);
  }
});

await run("status is workspace-scoped", async () => {
  const foreign = await session.call("context_capsule", {
    action: "checkpoint",
    workspace: unrelatedDefault,
    summary: "This capsule belongs to the unrelated default workspace.",
  });
  const foreignId = foreign.structuredContent?.data?.capsule?.id;
  if (!foreignId) throw new Error(JSON.stringify(foreign));

  const fixtureStatus = await session.call("context_capsule", { action: "status", workspace: fixture });
  const fixtureCapsules = fixtureStatus.structuredContent?.data?.capsules || [];
  if (fixtureCapsules.some((capsule) => capsule.id === foreignId)) throw new Error("foreign capsule leaked into fixture status");
  if (!fixtureCapsules.some((capsule) => capsule.id === capsuleId)) throw new Error("fixture capsule missing from scoped status");

  const foreignStatus = await session.call("context_capsule", { action: "status", workspace: unrelatedDefault });
  if (!(foreignStatus.structuredContent?.data?.capsules || []).some((capsule) => capsule.id === foreignId)) {
    throw new Error("foreign capsule missing from its own workspace status");
  }
});

await run("existing capsule cannot be retargeted to another workspace", async () => {
  const result = await session.call("context_capsule", {
    action: "checkpoint",
    id: capsuleId,
    workspace: unrelatedDefault,
    summary: "must not replace the fixture capsule",
  });
  if (!result.isError || !/different workspace/i.test(JSON.stringify(result))) {
    throw new Error(JSON.stringify(result));
  }
});

await run("oversized semantic input is bounded on disk", async () => {
  const result = await session.call("context_capsule", {
    action: "checkpoint",
    id: capsuleId,
    workspace: fixture,
    summary: "s".repeat(20_000),
    decisions: Array.from({ length: 30 }, (_, index) => `decision-${index}-${"x".repeat(1_500)}`),
    findings: Array.from({ length: 30 }, (_, index) => `finding-${index}-${"y".repeat(1_500)}`),
    next_steps: Array.from({ length: 30 }, (_, index) => `next-${index}-${"z".repeat(1_500)}`),
  });
  const capsule = result.structuredContent?.data?.capsule;
  if (capsule.semantic.summary.length > 6_000) throw new Error(`summary=${capsule.semantic.summary.length}`);
  if (capsule.semantic.decisions.length > 12 || capsule.semantic.decisions.some((entry) => entry.length > 600)) {
    throw new Error("semantic list bounds failed");
  }
  const stat = await fs.stat(path.join(state, "context-capsules", `${capsuleId}.json`));
  if (stat.size > 64 * 1024) throw new Error(`capsule file too large: ${stat.size}`);
});

await run("corrupt capsule file is isolated instead of poisoning status", async () => {
  const corruptId = "ctx_deadbeefdeadbe";
  await fs.writeFile(path.join(state, "context-capsules", `${corruptId}.json`), "{bad-json", "utf-8");
  const status = await session.call("context_capsule", { action: "status", workspace: fixture, limit: 20 });
  if (status.structuredContent?.ok !== true) throw new Error(JSON.stringify(status));
  const errors = status.structuredContent?.data?.state_errors || [];
  if (!errors.some((entry) => String(entry).includes(corruptId))) throw new Error(JSON.stringify(errors));
});

await session.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);