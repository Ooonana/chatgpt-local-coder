import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

export type CodingLoopStatus = "active" | "completed" | "cancelled" | "failed";
export type CodingLoopPhase = "editing" | "repair" | "ready" | "blocked" | "completed" | "cancelled" | "failed";

export interface CodingLoopFailure {
  label: string;
  command: string;
  category: "timeout" | "typecheck" | "test" | "lint" | "build" | "runtime" | "unknown";
  exit_code: number;
  evidence: string[];
}

export interface CodingLoopAttempt {
  number: number;
  started_at: string;
  finished_at: string;
  passed: number;
  failed: number;
  duration_ms: number;
  failures: CodingLoopFailure[];
}

export interface CodingLoopContext {
  refreshed_at: string;
  fingerprint: string;
  project: {
    name: string;
    root: string;
    git: {
      is_repo: boolean;
      branch?: string;
      head?: string;
      changed_files?: number;
      status?: string;
    };
    package?: {
      name?: string;
      version?: string;
      manager?: string;
      scripts: string[];
    };
    languages: Array<{ extension: string; files: number }>;
    important_files: string[];
    scanned_files: number;
    scan_truncated: boolean;
  };
  intel?: {
    action: string;
    mode: string;
    query: string;
    result_count: number;
    affected_files: Array<{ path: string; references: number }>;
    fallback_reason?: string;
  };
}

export interface CodingLoopIsolation {
  mode: "none" | "worktree";
  source_workspace: string;
  workspace: string;
  worktree_path?: string;
  branch?: string;
  base_ref?: string;
  cleaned_at?: string;
}

export interface CodingLoopRecord {
  version: 1;
  id: string;
  goal: string;
  task_id?: string;
  status: CodingLoopStatus;
  phase: CodingLoopPhase;
  source_workspace: string;
  workspace: string;
  transaction_id: string;
  verification: {
    preset: "quick" | "full" | "custom";
    commands?: Array<{ label: string; command: string; timeout_seconds: number }>;
    stop_on_failure: boolean;
  };
  max_attempts: number;
  attempts: CodingLoopAttempt[];
  context: CodingLoopContext;
  isolation: CodingLoopIsolation;
  notes: Array<{ at: string; text: string }>;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  cancelled_at?: string;
  failed_at?: string;
}

const VERSION = 1 as const;
const MAX_LOOPS = 500;
const MAX_NOTES = 100;
const MAX_ATTEMPTS_RECORDED = 32;
const loopLocks = new Map<string, Promise<void>>();

function stateRoot(): string {
  return path.resolve(process.env.MCP_CODING_LOOP_STATE_DIR || path.join(process.cwd(), ".mcp-state", "coding-loops"));
}

function assertCodingLoopId(id: string): void {
  if (!/^loop_[0-9a-f]{14}$/i.test(id)) throw new Error(`Invalid coding loop id: ${id}`);
}

function recordPath(id: string): string {
  assertCodingLoopId(id);
  return path.join(stateRoot(), `${id}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureStore(): Promise<void> {
  await fs.mkdir(stateRoot(), { recursive: true });
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(temp, filePath);
}

function normalizeRecord(value: CodingLoopRecord): CodingLoopRecord {
  if (value?.version !== VERSION || typeof value.id !== "string") throw new Error("invalid coding loop record");
  value.notes = Array.isArray(value.notes) ? value.notes.slice(-MAX_NOTES) : [];
  value.attempts = Array.isArray(value.attempts) ? value.attempts.slice(-MAX_ATTEMPTS_RECORDED) : [];
  return value;
}

export function newCodingLoopId(): string {
  return `loop_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export function getCodingLoopConfig(): Record<string, unknown> {
  return {
    state_dir: stateRoot(),
    max_loops: MAX_LOOPS,
    max_attempts_per_loop: 8,
    worktree_root: process.env.MCP_CODING_LOOP_WORKTREE_ROOT || null,
  };
}

export async function withCodingLoopLock<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
  if (!id) return work();
  const previous = loopLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  loopLocks.set(id, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (loopLocks.get(id) === current) loopLocks.delete(id);
  }
}

export async function createCodingLoop(record: Omit<CodingLoopRecord, "version" | "created_at" | "updated_at">): Promise<CodingLoopRecord> {
  await ensureStore();
  const created = nowIso();
  const next: CodingLoopRecord = normalizeRecord({
    version: VERSION,
    ...record,
    created_at: created,
    updated_at: created,
  });
  await atomicWriteJson(recordPath(next.id), next);
  await pruneCodingLoops();
  return next;
}

export async function getCodingLoop(id: string): Promise<CodingLoopRecord> {
  assertCodingLoopId(id);
  try {
    const parsed = JSON.parse(await fs.readFile(recordPath(id), "utf-8")) as CodingLoopRecord;
    if (parsed.id !== id) throw new Error("coding loop id mismatch");
    return normalizeRecord(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown coding loop: ${id}`);
    throw error;
  }
}

export async function saveCodingLoop(record: CodingLoopRecord): Promise<CodingLoopRecord> {
  assertCodingLoopId(record.id);
  const next = normalizeRecord({ ...record, updated_at: nowIso() });
  await atomicWriteJson(recordPath(next.id), next);
  return next;
}

async function readAllCodingLoops(): Promise<CodingLoopRecord[]> {
  await ensureStore();
  const entries = await fs.readdir(stateRoot(), { withFileTypes: true });
  const records: CodingLoopRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const id = entry.name.slice(0, -5);
      if (!/^loop_[0-9a-f]{14}$/i.test(id)) continue;
      const parsed = JSON.parse(await fs.readFile(recordPath(id), "utf-8")) as CodingLoopRecord;
      if (parsed?.version === VERSION && parsed.id === id) records.push(normalizeRecord(parsed));
    } catch {}
  }
  return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function listCodingLoops(limit = 20): Promise<CodingLoopRecord[]> {
  const records = await readAllCodingLoops();
  return records.slice(0, Math.min(Math.max(1, limit), 100));
}

export async function appendCodingLoopNote(id: string, text: string): Promise<CodingLoopRecord> {
  return withCodingLoopLock(id, async () => {
    const record = await getCodingLoop(id);
    record.notes.push({ at: nowIso(), text: text.slice(0, 10_000) });
    if (record.notes.length > MAX_NOTES) record.notes.splice(0, record.notes.length - MAX_NOTES);
    return saveCodingLoop(record);
  });
}

async function pruneCodingLoops(): Promise<void> {
  const records = await readAllCodingLoops();
  if (records.length <= MAX_LOOPS) return;
  const terminal = records
    .filter((record) => record.status !== "active")
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  let removeCount = records.length - MAX_LOOPS;
  for (const record of terminal) {
    if (removeCount <= 0) break;
    await fs.rm(recordPath(record.id), { force: true });
    removeCount--;
  }
}
