import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  createAgentTask,
  getAgentTask,
  listAgentTasks,
  updateAgentTask,
} from "../dist/lib/agent-task-store.js";

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
});

await run("complete persisted task", async () => {
  const completed = await updateAgentTask(task.id, { status: "completed", note: "All tests pass" });
  if (completed.status !== "completed") throw new Error(JSON.stringify(completed));
  const active = await listAgentTasks("active");
  if (active.some((item) => item.id === task.id)) throw new Error("completed task still active");
});

await fs.rm(stateDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
