import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  createAgentTask,
  getAgentTask,
  getAgentTaskProgress,
  getResumableAgentTask,
  listAgentTasks,
  updateAgentTask,
  updateAgentTaskStep,
} from "../dist/lib/agent-task-store.js";
import { summarizeTaskActivity } from "../dist/lib/task-activity.js";
import { buildWorkspaceRecoveryReview } from "../dist/lib/recovery-review.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stateDir = path.join(root, ".tool-test-tmp", "agent-task");
process.env.MCP_AGENT_TASK_STATE_DIR = stateDir;

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
function fail(name, err) { console.error(`FAIL ${name}: ${err?.stack || err}`); failed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (err) { fail(name, err); }
}

await run("task status distinguishes saved plans, linked loops, and live workers", async () => {
  const source = { id: "task-a", status: "active" };
  const completedLoop = { id: "loop-a", task_id: "task-a", status: "completed", managed_task: false };
  const stored = summarizeTaskActivity(source, [completedLoop], []);
  if (stored.running_worker_count !== 0 || !stored.explanation.includes("externally managed")) {
    throw new Error("completed unmanaged loop was mistaken for an executing task");
  }
  const executing = summarizeTaskActivity(source, [completedLoop], [
    { id: "worker-a", task_id: "task-a", running: true },
    { id: "worker-b", task_id: "unrelated", running: true },
  ]);
  if (executing.running_worker_count !== 1 || executing.worker_ids[0] !== "worker-a") {
    throw new Error("live worker identification was not scoped to its task");
  }
  const pending = summarizeTaskActivity(source, [{ id: "loop-b", task_id: "task-a", status: "active" }], []);
  if (!pending.explanation.includes("no registered running worker")) {
    throw new Error("an active plan was mistaken for a running worker");
  }
  const mismatch = summarizeTaskActivity(source, [{ id: "loop-c", task_id: "task-a", status: "completed", managed_task: true }], []);
  if (!mismatch.explanation.includes("reconciliation")) throw new Error("missed managed-task lifecycle mismatch");
});

await run("recovery review isolates project records without exposing captured file contents", async () => {
  const age = 48 * 3_600_000;
  const now = Date.now();
  const stale = new Date(now - age).toISOString();
  const project = path.join(root, "fixture-project");
  const other = path.join(root, "other-project");
  const own = {
    id: "owned-task", title: "Inspect state", objective: "Never auto-delete",
    workspace: project, status: "active", updated_at: stale,
    plan: ["inspect"], steps: [{ id: "s", title: "inspect", status: "pending", updated_at: stale }],
    notes: [], created_at: stale,
  };
  const foreign = { ...own, id: "foreign-task", workspace: other };
  const loop = {
    id: "loop_owned", workspace: project, source_workspace: project,
    status: "active", phase: "editing", task_id: own.id,
    transaction_id: "tx_owned", updated_at: stale,
  };
  const foreignLoop = { ...loop, id: "loop_foreign", source_workspace: other,
    workspace: other, task_id: foreign.id, transaction_id: "tx_foreign" };
  const tx = {
    id: "tx_owned", workspace: project, status: "active", updated_at: stale,
    snapshots: [{ path: "SECRET_CAPTURED_FILE_NAME" }], edits: [{ paths: ["SECRET_EDIT"] }],
  };
  const foreignTx = { ...tx, id: "tx_foreign", workspace: other };
  const records = { tasks: [own, foreign], loops: [loop, foreignLoop], transactions: [tx, foreignTx] };
  const original = JSON.stringify(records);
  const review = buildWorkspaceRecoveryReview({
    workspace: project, ...records, workers: [], staleHours: 24, now,
  });
  if (review.counts.tasks !== 1 || review.counts.coding_loops !== 1 ||
      review.counts.edit_transactions !== 1) throw new Error(JSON.stringify(review));
  if (review.stale_transactions[0].suggested_action !== "inspect_active_loop_before_transaction_changes") {
    throw new Error("Review did not link active loop to its open transaction");
  }
  if (JSON.stringify(review).includes("SECRET") || JSON.stringify(review).includes("foreign-task")) {
    throw new Error("Review leaked another project or transaction snapshot contents");
  }
  const chosen = buildWorkspaceRecoveryReview({
    workspace: project, ...records, workers: [], staleHours: 24, now, taskId: "other-task",
  });
  if (chosen.counts.tasks || chosen.counts.coding_loops || chosen.counts.edit_transactions) {
    throw new Error("Review ignored explicit task selection");
  }
  const worktree = path.join(root, "temporary-worktree-for-fixture");
  const isolatedLoop = {
    ...loop, id: "loop_isolated", workspace: worktree,
    transaction_id: "tx_isolated", task_id: own.id,
  };
  const isolatedTransaction = {
    ...tx, id: "tx_isolated", workspace: worktree, snapshots: [], edits: [],
  };
  const withWorktree = buildWorkspaceRecoveryReview({
    workspace: project, tasks: [own, foreign],
    loops: [isolatedLoop, foreignLoop],
    transactions: [isolatedTransaction, foreignTx],
    workers: [], staleHours: 24, now,
  });
  if (withWorktree.counts.edit_transactions !== 1 ||
      withWorktree.stale_transactions[0].id !== "tx_isolated") {
    throw new Error("The isolated project worktree transaction was lost or a foreign one leaked");
  }
  if (JSON.stringify(records) !== original) throw new Error("Read-only review modified source objects");
});

await fs.rm(stateDir, { recursive: true, force: true });
let task;

await run("create persistent agent task", async () => {
  task = await createAgentTask({
    title: "Fix auth flow",
    objective: "Reproduce and fix the authentication failure",
    workspace: root,
    plan: ["reproduce", "patch", "test"],
  });
  if (!task.id || task.status !== "active") throw new Error(JSON.stringify(task));
  if (task.steps.length !== 3 || task.steps.some((step) => step.status !== "pending")) {
    throw new Error(`structured steps missing: ${JSON.stringify(task)}`);
  }
});

await run("read and list agent task", async () => {
  const fetched = await getAgentTask(task.id);
  if (fetched?.title !== "Fix auth flow") throw new Error(JSON.stringify(fetched));
  const active = await listAgentTasks("active");
  if (!active.some((item) => item.id === task.id)) throw new Error("active task missing");
});

await run("update task plan and note", async () => {
  const updated = await updateAgentTask(task.id, {
    status: "blocked",
    plan: ["reproduce", "inspect logs", "patch", "test"],
    note: "Waiting on a reproducible failing case",
  });
  if (updated.status !== "blocked" || updated.notes.length !== 1 || updated.plan.length !== 4) {
    throw new Error(JSON.stringify(updated));
  }
  if (updated.steps.length !== 4) throw new Error("step reconciliation failed");
});

await run("structured plan step progress and resume", async () => {
  let updated = await updateAgentTaskStep(task.id, { step_index: 0 }, { status: "in_progress", note: "reproducing" });
  if (updated.steps[0].status !== "in_progress") throw new Error(JSON.stringify(updated.steps[0]));
  updated = await updateAgentTaskStep(task.id, { step_index: 0 }, { status: "completed", note: "reproduced" });
  if (!updated.steps[0].completed_at) throw new Error("Completed step missing completion timestamp");
  updated = await updateAgentTaskStep(task.id, { step_index: 0 }, { status: "in_progress" });
  if (updated.steps[0].completed_at !== undefined) {
    throw new Error("Reopened step incorrectly retains completed_at");
  }
  updated = await updateAgentTaskStep(task.id, { step_index: 0 }, { status: "completed" });
  updated = await updateAgentTaskStep(task.id, { step_index: 1 }, { status: "in_progress" });
  const progress = getAgentTaskProgress(updated);
  if (progress.completed !== 1 || progress.current_step?.title !== "inspect logs") throw new Error(JSON.stringify(progress));
  updated = await updateAgentTaskStep(task.id, { step_index: 1 }, { status: "blocked", note: "waiting" });
  updated = await updateAgentTaskStep(task.id, { step_index: 2 }, { status: "completed" });
  if (updated.status !== "blocked") throw new Error("task lost blocked state while another step remained blocked");
  updated = await updateAgentTaskStep(task.id, { step_index: 1 }, { status: "completed" });
  if (updated.status !== "active") throw new Error("task did not recover from resolved blocked step");
  const resumed = await getResumableAgentTask(task.id);
  if (!resumed || resumed.id !== task.id) throw new Error("task did not resume");
});

await run("v1 task index migrates to structured plan", async () => {
  const legacyDir = path.join(root, ".tool-test-tmp", "agent-task-legacy");
  await fs.rm(legacyDir, { recursive: true, force: true });
  await fs.mkdir(legacyDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(legacyDir, "index.json"), JSON.stringify({
    version: 1,
    tasks: [{
      id: "legacy-task",
      title: "Legacy",
      objective: "migrate",
      workspace: root,
      status: "active",
      plan: ["one", "two"],
      notes: [],
      created_at: now,
      updated_at: now,
    }],
  }), "utf-8");
  const previous = process.env.MCP_AGENT_TASK_STATE_DIR;
  process.env.MCP_AGENT_TASK_STATE_DIR = legacyDir;
  try {
    const migrated = await getAgentTask("legacy-task");
    if (!migrated || migrated.steps.length !== 2 || migrated.steps[0].title !== "one") {
      throw new Error(JSON.stringify(migrated));
    }
  } finally {
    process.env.MCP_AGENT_TASK_STATE_DIR = previous;
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});

await run("stale completion timestamps normalize on read without rewriting historic state", async () => {
  const fixtureDir = path.join(root, ".tool-test-tmp", "agent-task-reopened-v2");
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  const now = new Date().toISOString();
  const file = path.join(fixtureDir, "index.json");
  const original = JSON.stringify({
    version: 2,
    tasks: [{
      id: "legacy-reopened", title: "Legacy reopened", objective: "test",
      workspace: root, status: "active", plan: ["reopen"],
      steps: [{
        id: "one", title: "reopen", status: "in_progress",
        started_at: now, completed_at: now, updated_at: now,
      }],
      notes: [], created_at: now, updated_at: now,
    }],
  });
  await fs.writeFile(file, original, "utf8");
  const previous = process.env.MCP_AGENT_TASK_STATE_DIR;
  process.env.MCP_AGENT_TASK_STATE_DIR = fixtureDir;
  try {
    const fetched = await getAgentTask("legacy-reopened");
    if (fetched?.steps[0]?.completed_at !== undefined) {
      throw new Error("Legacy reopened step still reports completed_at");
    }
    if (await fs.readFile(file, "utf8") !== original) {
      throw new Error("Read-only historical normalization rewrote the original index");
    }
  } finally {
    process.env.MCP_AGENT_TASK_STATE_DIR = previous;
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

await run("complete persisted task", async () => {
  const completed = await updateAgentTask(task.id, { status: "completed", note: "All tests pass" });
  if (completed.status !== "completed") throw new Error(JSON.stringify(completed));
  const active = await listAgentTasks("active");
  if (active.some((item) => item.id === task.id)) throw new Error("completed task still active");
});

await run("completed task plan steps cannot be mutated without reactivation", async () => {
  let rejected = false;
  try {
    await updateAgentTaskStep(task.id, { step_index: 0 }, { status: "pending" });
  } catch (error) {
    rejected = /completed.*reactivate/i.test(String(error));
  }
  if (!rejected) throw new Error("completed task accepted a plan-step mutation");
});

await run("task retention never evicts active or blocked work", async () => {
  const pressureDir = path.join(root, ".tool-test-tmp", "agent-task-retention");
  await fs.rm(pressureDir, { recursive: true, force: true });
  await fs.mkdir(pressureDir, { recursive: true });
  const now = Date.now();
  const makeTask = (id, status, age) => ({
    id,
    title: id,
    objective: id,
    workspace: root,
    status,
    plan: ["step"],
    steps: [{ id: `${id}-step`, title: "step", status: status === "completed" ? "completed" : "pending", updated_at: new Date(now - age).toISOString() }],
    notes: [],
    created_at: new Date(now - age).toISOString(),
    updated_at: new Date(now - age).toISOString(),
  });
  const seeded = [
    makeTask("protected-active", "active", 500_000),
    makeTask("protected-blocked", "blocked", 490_000),
    ...Array.from({ length: 198 }, (_, index) => makeTask(`terminal-${index}`, "completed", 480_000 - index)),
  ];
  await fs.writeFile(path.join(pressureDir, "index.json"), JSON.stringify({ version: 2, tasks: seeded }), "utf-8");
  const previous = process.env.MCP_AGENT_TASK_STATE_DIR;
  process.env.MCP_AGENT_TASK_STATE_DIR = pressureDir;
  try {
    await createAgentTask({ objective: "new active task", workspace: root, plan: ["step"] });
    if (!(await getAgentTask("protected-active"))) throw new Error("old active task was evicted");
    if (!(await getAgentTask("protected-blocked"))) throw new Error("old blocked task was evicted");
    const tasks = await listAgentTasks();
    if (tasks.length > 200) throw new Error(`terminal history was not pruned: ${tasks.length}`);
  } finally {
    process.env.MCP_AGENT_TASK_STATE_DIR = previous;
    await fs.rm(pressureDir, { recursive: true, force: true });
  }
});

await fs.rm(stateDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
