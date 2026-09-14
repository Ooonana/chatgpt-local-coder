import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";

export type AgentTaskStatus = "active" | "blocked" | "completed" | "cancelled";

export interface AgentTaskRecord {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  status: AgentTaskStatus;
  plan: string[];
  notes: string[];
  created_at: string;
  updated_at: string;
}

interface AgentTaskIndex {
  version: 1;
  tasks: AgentTaskRecord[];
}

const INDEX_VERSION = 1 as const;
const MAX_TASKS = 200;
const MAX_NOTES_PER_TASK = 100;

function storeRoot(): string {
  return process.env.MCP_AGENT_TASK_STATE_DIR || path.resolve(process.cwd(), ".mcp-state", "agent-tasks");
}

function indexPath(): string {
  return path.join(storeRoot(), "index.json");
}

async function readIndex(): Promise<AgentTaskIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(), "utf-8")) as AgentTaskIndex;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.tasks)) return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { version: INDEX_VERSION, tasks: [] };
}

async function writeIndex(index: AgentTaskIndex): Promise<void> {
  await fs.mkdir(storeRoot(), { recursive: true });
  const tmp = `${indexPath()}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), "utf-8");
  await fs.rename(tmp, indexPath());
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

export async function createAgentTask(input: {
  title?: string;
  objective: string;
  workspace: string;
  plan?: string[];
}): Promise<AgentTaskRecord> {
  const now = new Date().toISOString();
  const task: AgentTaskRecord = {
    id: randomUUID(),
    title: input.title?.trim() || input.objective.trim().slice(0, 80),
    objective: input.objective.trim(),
    workspace: path.resolve(input.workspace),
    status: "active",
    plan: (input.plan ?? []).map((item) => item.trim()).filter(Boolean),
    notes: [],
    created_at: now,
    updated_at: now,
  };
  const index = await readIndex();
  index.tasks.push(task);
  if (index.tasks.length > MAX_TASKS) {
    index.tasks.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    index.tasks.splice(0, index.tasks.length - MAX_TASKS);
  }
  await writeIndex(index);
  return task;
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
  const index = await readIndex();
  const task = index.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown agent task id: ${id}`);

  if (updates.title !== undefined) task.title = updates.title.trim();
  if (updates.objective !== undefined) task.objective = updates.objective.trim();
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.plan !== undefined) task.plan = updates.plan.map((item) => item.trim()).filter(Boolean);
  if (updates.note?.trim()) {
    task.notes.push(updates.note.trim());
    if (task.notes.length > MAX_NOTES_PER_TASK) {
      task.notes.splice(0, task.notes.length - MAX_NOTES_PER_TASK);
    }
  }
  task.updated_at = new Date().toISOString();
  await writeIndex(index);
  return task;
}
