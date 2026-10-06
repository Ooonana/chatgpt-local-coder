import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { getCurrentSessionId } from "./session-context.js";
import { sameResolvedPath } from "./path-identity.js";

export type AgentTaskStatus = "active" | "blocked" | "completed" | "cancelled" | "abandoned" | "archived";
export type AgentTaskStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";

export interface AgentTaskStep {
  id: string;
  title: string;
  status: AgentTaskStepStatus;
  note?: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;
}

export interface AgentTaskRecord {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  session_id?: string;
  status: AgentTaskStatus;
  /** Backward-compatible flat plan used by older clients. */
  plan: string[];
  /** Structured plan state used by the coding-agent loop. */
  steps: AgentTaskStep[];
  notes: string[];
  created_at: string;
  updated_at: string;
}

interface AgentTaskIndexV1 {
  version: 1;
  tasks: Array<Omit<AgentTaskRecord, "steps"> & { steps?: never }>;
}

interface AgentTaskIndexV2 {
  version: 2;
  tasks: AgentTaskRecord[];
}

type AgentTaskIndex = AgentTaskIndexV2;

const INDEX_VERSION = 2 as const;
const MAX_TASKS = 200;
const MAX_NOTES_PER_TASK = 100;
let mutationQueue: Promise<void> = Promise.resolve();
let cachedIndex: { path: string; value: AgentTaskIndex } | null = null;

function pruneAgentTasks(tasks: AgentTaskRecord[]): AgentTaskRecord[] {
  if (tasks.length <= MAX_TASKS) return tasks;
  const protectedTasks = tasks.filter((task) => task.status === "active" || task.status === "blocked");
  const terminalTasks = tasks
    .filter((task) => task.status !== "active" && task.status !== "blocked")
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  // Never evict resumable work just to satisfy the history target. If the
  // system genuinely has >MAX_TASKS active/blocked tasks, retain them all and
  // prune terminal history as aggressively as possible.
  const terminalBudget = Math.max(0, MAX_TASKS - protectedTasks.length);
  return [...protectedTasks, ...terminalTasks.slice(0, terminalBudget)];
}

function storeRoot(): string {
  return process.env.MCP_AGENT_TASK_STATE_DIR || path.resolve(process.cwd(), ".mcp-state", "agent-tasks");
}

function indexPath(): string {
  return path.join(storeRoot(), "index.json");
}

function cleanPlan(plan: string[] | undefined): string[] {
  return (plan ?? []).map((item) => item.trim()).filter(Boolean);
}

function newStep(title: string, now: string, status: AgentTaskStepStatus = "pending"): AgentTaskStep {
  return {
    id: randomUUID(),
    title,
    status,
    updated_at: now,
    ...(status === "in_progress" ? { started_at: now } : {}),
    ...(status === "completed" || status === "skipped" ? { completed_at: now } : {}),
  };
}

function migrateV1(index: AgentTaskIndexV1): AgentTaskIndexV2 {
  return {
    version: INDEX_VERSION,
    tasks: index.tasks.map((task) => {
      const now = task.updated_at || task.created_at || new Date().toISOString();
      const plan = cleanPlan(task.plan);
      return {
        ...task,
        plan,
        steps: plan.map((title, stepIndex) => ({
          ...newStep(title, now, task.status === "completed" ? "completed" : "pending"),
          id: `${task.id}:legacy:${stepIndex}`,
        })),
      };
    }),
  };
}

function normalizeV2(index: AgentTaskIndexV2): AgentTaskIndexV2 {
  for (const task of index.tasks) {
    task.plan = cleanPlan(task.plan);
    if (!Array.isArray(task.steps)) {
      task.steps = task.plan.map((title) => newStep(title, task.updated_at || new Date().toISOString()));
    }
  }
  return index;
}

async function readIndex(): Promise<AgentTaskIndex> {
  const currentPath = indexPath();
  if (cachedIndex?.path === currentPath) return structuredClone(cachedIndex.value);
  try {
    const parsed = JSON.parse(await fs.readFile(currentPath, "utf-8")) as AgentTaskIndexV1 | AgentTaskIndexV2;
    const value = parsed.version === 2 && Array.isArray(parsed.tasks)
      ? normalizeV2(parsed)
      : parsed.version === 1 && Array.isArray(parsed.tasks)
        ? migrateV1(parsed)
        : null;
    if (value) {
      cachedIndex = { path: currentPath, value: structuredClone(value) };
      return value;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const empty: AgentTaskIndex = { version: INDEX_VERSION, tasks: [] };
  cachedIndex = { path: currentPath, value: structuredClone(empty) };
  return empty;
}

async function writeIndex(index: AgentTaskIndex): Promise<void> {
  const currentPath = indexPath();
  await fs.mkdir(storeRoot(), { recursive: true });
  const tmp = `${currentPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), "utf-8");
  await fs.rename(tmp, currentPath);
  cachedIndex = { path: currentPath, value: structuredClone(index) };
}

async function mutate<T>(fn: () => Promise<T>): Promise<T> {
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const previous = mutationQueue;
  mutationQueue = previous.then(() => gate, () => gate);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    resolveGate();
  }
}

function reconcileSteps(existing: AgentTaskStep[], titles: string[], now: string): AgentTaskStep[] {
  const used = new Set<string>();
  return titles.map((title, index) => {
    const sameIndex = existing[index];
    if (sameIndex && sameIndex.title === title && !used.has(sameIndex.id)) {
      used.add(sameIndex.id);
      return sameIndex;
    }
    const sameTitle = existing.find((step) => step.title === title && !used.has(step.id));
    if (sameTitle) {
      used.add(sameTitle.id);
      return sameTitle;
    }
    return newStep(title, now);
  });
}

function findTask(index: AgentTaskIndex, id: string): AgentTaskRecord {
  const task = index.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown agent task id: ${id}`);
  return task;
}

export function getAgentTaskProgress(task: AgentTaskRecord) {
  const completed = task.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const active = task.steps.find((step) => step.status === "in_progress" || step.status === "blocked") ?? null;
  const next = active ?? task.steps.find((step) => step.status === "pending") ?? null;
  return {
    total: task.steps.length,
    completed,
    percent: task.steps.length ? Math.round((completed / task.steps.length) * 100) : 0,
    current_step: active,
    next_step: next,
  };
}

export async function listAgentTasks(status?: AgentTaskStatus): Promise<AgentTaskRecord[]> {
  const index = await readIndex();
  return index.tasks
    .filter((task) => !status || task.status === status)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export async function getAgentTask(id: string): Promise<AgentTaskRecord | null> {
  const index = await readIndex();
  return index.tasks.find((task) => task.id === id) ?? null;
}

export async function getResumableAgentTask(id?: string, workspace?: string): Promise<AgentTaskRecord | null> {
  if (id) {
    const task = await getAgentTask(id);
    return task && (task.status === "active" || task.status === "blocked") ? task : null;
  }
  const tasks = await listAgentTasks();
  return tasks.find((task) =>
    (task.status === "active" || task.status === "blocked") &&
    (!workspace || sameResolvedPath(task.workspace, workspace))
  ) ?? null;
}

export async function createAgentTask(input: {
  title?: string;
  objective: string;
  workspace: string;
  plan?: string[];
}): Promise<AgentTaskRecord> {
  return mutate(async () => {
    const now = new Date().toISOString();
    const plan = cleanPlan(input.plan);
    const task: AgentTaskRecord = {
      id: randomUUID(),
      title: input.title?.trim() || input.objective.trim().slice(0, 80),
      objective: input.objective.trim(),
      workspace: path.resolve(input.workspace),
      session_id: getCurrentSessionId(),
      status: "active",
      plan,
      steps: plan.map((title) => newStep(title, now)),
      notes: [],
      created_at: now,
      updated_at: now,
    };
    const index = await readIndex();
    index.tasks.push(task);
    index.tasks = pruneAgentTasks(index.tasks);
    await writeIndex(index);
    return task;
  });
}


export async function updateAgentTask(
  id: string,
  updates: {
    title?: string;
    objective?: string;
    status?: AgentTaskStatus;
    plan?: string[];
    note?: string;
  }
): Promise<AgentTaskRecord> {
  return mutate(async () => {
    const index = await readIndex();
    const task = findTask(index, id);
    const now = new Date().toISOString();

    if (updates.title !== undefined) task.title = updates.title.trim();
    if (updates.objective !== undefined) task.objective = updates.objective.trim();
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.plan !== undefined) {
      task.plan = cleanPlan(updates.plan);
      task.steps = reconcileSteps(task.steps, task.plan, now);
    }
    if (updates.note?.trim()) {
      task.notes.push(updates.note.trim());
      if (task.notes.length > MAX_NOTES_PER_TASK) {
        task.notes.splice(0, task.notes.length - MAX_NOTES_PER_TASK);
      }
    }
    if (updates.status === "completed") {
      for (const step of task.steps) {
        if (step.status === "skipped") continue;
        step.status = "completed";
        step.updated_at = now;
        step.completed_at ??= now;
      }
    }
    task.updated_at = now;
    await writeIndex(index);
    return task;
  });
}

export async function updateAgentTaskStep(
  id: string,
  selector: { step_id?: string; step_index?: number },
  updates: { status: AgentTaskStepStatus; note?: string }
): Promise<AgentTaskRecord> {
  return mutate(async () => {
    const index = await readIndex();
    const task = findTask(index, id);
    if (["completed", "cancelled", "abandoned", "archived"].includes(task.status)) {
      throw new Error(`Agent task ${id} is ${task.status}; reactivate it explicitly before changing plan steps`);
    }
    const step = selector.step_id
      ? task.steps.find((candidate) => candidate.id === selector.step_id)
      : selector.step_index !== undefined
        ? task.steps[selector.step_index]
        : undefined;
    if (!step) throw new Error(`Unknown plan step for agent task ${id}`);

    const now = new Date().toISOString();
    step.status = updates.status;
    step.updated_at = now;
    if (updates.note?.trim()) step.note = updates.note.trim();
    if (updates.status === "in_progress" && !step.started_at) step.started_at = now;
    if (updates.status === "completed" || updates.status === "skipped") step.completed_at = now;
    if (updates.status === "pending" || updates.status === "blocked") step.completed_at = undefined;
    if (task.steps.some((candidate) => candidate.status === "blocked")) task.status = "blocked";
    else if (task.status === "blocked") task.status = "active";
    task.updated_at = now;
    await writeIndex(index);
    return task;
  });
}
