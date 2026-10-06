import fs from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "node:crypto";
import { collectGitSnapshot, type GitSnapshot } from "./git-snapshot.js";
import { getRecentActivity } from "./activity-log.js";
import {
  getAgentTask,
  getAgentTaskProgress,
  listAgentTasks,
  type AgentTaskRecord,
} from "./agent-task-store.js";
import {
  getCodingLoop,
  listCodingLoops,
  type CodingLoopRecord,
} from "./coding-loop-store.js";
import { getEditTransaction } from "./edit-transaction-store.js";
import { getCurrentSessionId } from "./session-context.js";
import { sameResolvedPath } from "./path-identity.js";

export type ContextCapsuleCheckpointSource = "manual" | "auto";

export interface ContextCapsuleSemanticState {
  summary: string;
  decisions: string[];
  findings: string[];
  blockers: string[];
  next_steps: string[];
  files: Array<{ path: string; note?: string }>;
}

export interface ContextCapsuleMachineState {
  captured_at: string;
  git: {
    is_repo: boolean;
    branch?: string;
    status_short?: string;
    recent_commits?: string[];
  };
  task?: {
    id: string;
    title: string;
    objective: string;
    status: string;
    progress: ReturnType<typeof getAgentTaskProgress>;
  };
  coding_loop?: {
    id: string;
    goal: string;
    status: string;
    phase: string;
    task_id?: string;
    transaction_id: string;
    attempts: number;
    max_attempts: number;
    last_attempt: unknown;
  };
  transaction?: {
    id: string;
    status: string;
    files: number;
    edits: number;
    verification: null | {
      at: string;
      preset: string;
      passed: number;
      failed: number;
    };
  };
  recent_activity: Array<{
    time: string;
    tool?: string;
    action?: string;
    status?: string;
    summary?: string;
  }>;
}

export interface ContextCapsuleRecord {
  version: 1;
  id: string;
  workspace: string;
  objective: string;
  task_id?: string;
  coding_loop_id?: string;
  session_id?: string;
  semantic: ContextCapsuleSemanticState;
  machine: ContextCapsuleMachineState;
  checkpoint_count: number;
  auto_checkpoint_count: number;
  last_checkpoint_source: ContextCapsuleCheckpointSource;
  last_auto_reason?: string;
  machine_fingerprint?: string;
  created_at: string;
  updated_at: string;
}

const VERSION = 1 as const;
const MAX_CAPSULES = 200;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 600;
const MAX_FILES = 24;
const MAX_FILE_PATH_CHARS = 700;
const MAX_FILE_NOTE_CHARS = 300;
const MAX_ACTIVITY = 16;
const MAX_RECORD_BYTES = 64 * 1024;
let mutationQueue: Promise<void> = Promise.resolve();
let lastReadErrors: string[] = [];

function boundedPositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function stateRoot(): string {
  return path.resolve(
    process.env.MCP_CONTEXT_CAPSULE_STATE_DIR || path.join(process.cwd(), ".mcp-state", "context-capsules")
  );
}

function toolCallThreshold(): number {
  return boundedPositiveInt(process.env.MCP_CONTEXT_CAPSULE_TOOL_CALLS, 12, 4, 100);
}

function resultByteThreshold(): number {
  return boundedPositiveInt(process.env.MCP_CONTEXT_CAPSULE_RESULT_BYTES, 64 * 1024, 8 * 1024, 1024 * 1024);
}

function rolloverCycles(): number {
  return boundedPositiveInt(process.env.MCP_CONTEXT_CAPSULE_ROLLOVER_CYCLES, 3, 2, 20);
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertCapsuleId(id: string): void {
  if (!/^ctx_[0-9a-f]{14}$/i.test(id)) throw new Error(`Invalid context capsule id: ${id}`);
}

function recordPath(id: string): string {
  assertCapsuleId(id);
  return path.join(stateRoot(), `${id}.json`);
}

function trimText(value: string | undefined, max: number): string {
  return (value || "").trim().slice(0, max);
}

function trimList(values: string[] | undefined): string[] {
  return (values || [])
    .map((value) => trimText(value, MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function trimFiles(values: Array<{ path: string; note?: string }> | undefined): Array<{ path: string; note?: string }> {
  return (values || [])
    .map((entry) => ({
      path: trimText(entry.path, MAX_FILE_PATH_CHARS),
      ...(trimText(entry.note, MAX_FILE_NOTE_CHARS) ? { note: trimText(entry.note, MAX_FILE_NOTE_CHARS) } : {}),
    }))
    .filter((entry) => entry.path)
    .slice(0, MAX_FILES);
}

function emptySemantic(): ContextCapsuleSemanticState {
  return { summary: "", decisions: [], findings: [], blockers: [], next_steps: [], files: [] };
}

function normalizeSemantic(value: ContextCapsuleSemanticState | undefined): ContextCapsuleSemanticState {
  return {
    summary: trimText(value?.summary, MAX_SUMMARY_CHARS),
    decisions: trimList(value?.decisions),
    findings: trimList(value?.findings),
    blockers: trimList(value?.blockers),
    next_steps: trimList(value?.next_steps),
    files: trimFiles(value?.files),
  };
}

function compactAttempt(attempt: CodingLoopRecord["attempts"][number] | undefined): unknown {
  if (!attempt) return null;
  return {
    number: attempt.number,
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    passed: attempt.passed,
    failed: attempt.failed,
    duration_ms: attempt.duration_ms,
    failures: attempt.failures.slice(0, 6).map((failure) => ({
      label: trimText(failure.label, 200),
      category: failure.category,
      exit_code: failure.exit_code,
      evidence: failure.evidence.slice(0, 4).map((line) => trimText(line, 300)),
    })),
  };
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

async function mutate<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const previous = mutationQueue;
  mutationQueue = previous.catch(() => undefined).then(() => gate);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

function fitRecord(record: ContextCapsuleRecord): ContextCapsuleRecord {
  record.semantic = normalizeSemantic(record.semantic);
  record.machine.recent_activity = record.machine.recent_activity.slice(0, MAX_ACTIVITY);
  if (Buffer.byteLength(JSON.stringify(record), "utf-8") <= MAX_RECORD_BYTES) return record;

  record.semantic.summary = record.semantic.summary.slice(0, 3_000);
  record.semantic.decisions = record.semantic.decisions.slice(0, 8);
  record.semantic.findings = record.semantic.findings.slice(0, 8);
  record.semantic.blockers = record.semantic.blockers.slice(0, 8);
  record.semantic.next_steps = record.semantic.next_steps.slice(0, 8);
  record.semantic.files = record.semantic.files.slice(0, 12);
  record.machine.recent_activity = record.machine.recent_activity.slice(0, 8);
  return record;
}

function normalizeRecord(value: ContextCapsuleRecord): ContextCapsuleRecord {
  if (value?.version !== VERSION || typeof value.id !== "string") throw new Error("invalid context capsule record");
  assertCapsuleId(value.id);
  value.workspace = path.resolve(value.workspace);
  value.objective = trimText(value.objective, 4_000);
  value.semantic = normalizeSemantic(value.semantic || emptySemantic());
  value.checkpoint_count = Math.max(0, Number(value.checkpoint_count) || 0);
  value.auto_checkpoint_count = Math.max(0, Number(value.auto_checkpoint_count) || 0);
  value.last_checkpoint_source = value.last_checkpoint_source === "manual" ? "manual" : "auto";
  return fitRecord(value);
}

async function readAll(): Promise<ContextCapsuleRecord[]> {
  await ensureStore();
  const entries = await fs.readdir(stateRoot(), { withFileTypes: true });
  const records: ContextCapsuleRecord[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!/^ctx_[0-9a-f]{14}$/i.test(id)) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(recordPath(id), "utf-8")) as ContextCapsuleRecord;
      if (parsed.id !== id) throw new Error("context capsule id mismatch");
      records.push(normalizeRecord(parsed));
    } catch (error) {
      errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  lastReadErrors = errors.slice(0, 20);
  return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function save(record: ContextCapsuleRecord): Promise<ContextCapsuleRecord> {
  const next = normalizeRecord({ ...record, updated_at: nowIso() });
  await atomicWriteJson(recordPath(next.id), next);
  await prune();
  return next;
}

async function prune(): Promise<void> {
  const records = await readAll();
  for (const record of records.slice(MAX_CAPSULES)) {
    await fs.rm(recordPath(record.id), { force: true });
  }
}

async function resolveTask(
  workspace: string,
  taskId?: string,
  loop?: CodingLoopRecord
): Promise<AgentTaskRecord | undefined> {
  const effectiveTaskId = taskId || loop?.task_id;
  if (effectiveTaskId) {
    const task = await getAgentTask(effectiveTaskId);
    if (!task) throw new Error(`Unknown agent task id: ${effectiveTaskId}`);
    const workspaceMatch = sameResolvedPath(task.workspace, workspace);
    const sourceMatch = Boolean(loop && sameResolvedPath(task.workspace, loop.source_workspace));
    if (!workspaceMatch && !sourceMatch) {
      throw new Error(
        `Agent task ${effectiveTaskId} belongs to '${task.workspace}', not context workspace '${workspace}'.`
      );
    }
    return task;
  }
  const candidates = (await listAgentTasks())
    .filter((task) => sameResolvedPath(task.workspace, workspace))
    .filter((task) => task.status === "active" || task.status === "blocked");
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function resolveLoop(workspace: string, loopId?: string): Promise<CodingLoopRecord | undefined> {
  if (loopId) {
    const loop = await getCodingLoop(loopId);
    if (!sameResolvedPath(loop.workspace, workspace) && !sameResolvedPath(loop.source_workspace, workspace)) {
      throw new Error(
        `Coding loop ${loopId} belongs to '${loop.workspace}' (source '${loop.source_workspace}'), not context workspace '${workspace}'.`
      );
    }
    return loop;
  }
  const candidates = (await listCodingLoops(100))
    .filter((loop) => loop.status === "active")
    .filter((loop) => sameResolvedPath(loop.workspace, workspace) || sameResolvedPath(loop.source_workspace, workspace));
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function buildMachineState(
  workspace: string,
  taskId?: string,
  loopId?: string
): Promise<{ machine: ContextCapsuleMachineState; task?: AgentTaskRecord; loop?: CodingLoopRecord }> {
  const loop = await resolveLoop(workspace, loopId);
  if (loop && taskId && loop.task_id && loop.task_id !== taskId) {
    throw new Error(`Agent task ${taskId} is not the task linked to coding loop ${loop.id} (${loop.task_id}).`);
  }
  const task = await resolveTask(workspace, taskId, loop);
  const git = await collectGitSnapshot(workspace).catch((): GitSnapshot => ({ is_repo: false }));
  const transaction = loop
    ? await getEditTransaction(loop.transaction_id).catch(() => null)
    : null;
  const machine: ContextCapsuleMachineState = {
    captured_at: nowIso(),
    git: {
      is_repo: git.is_repo,
      branch: git.branch,
      status_short: trimText(git.status_short, 1_200),
      recent_commits: git.recent_commits?.slice(0, 3),
    },
    ...(task ? {
      task: {
        id: task.id,
        title: trimText(task.title, 300),
        objective: trimText(task.objective, 1_200),
        status: task.status,
        progress: getAgentTaskProgress(task),
      },
    } : {}),
    ...(loop ? {
      coding_loop: {
        id: loop.id,
        goal: trimText(loop.goal, 1_200),
        status: loop.status,
        phase: loop.phase,
        task_id: loop.task_id,
        transaction_id: loop.transaction_id,
        attempts: loop.attempts.length,
        max_attempts: loop.max_attempts,
        last_attempt: compactAttempt(loop.attempts.at(-1)),
      },
    } : {}),
    ...(transaction ? {
      transaction: {
        id: transaction.id,
        status: transaction.status,
        files: transaction.snapshots.length,
        edits: transaction.edits.length,
        verification: transaction.verification
          ? {
              at: transaction.verification.at,
              preset: transaction.verification.preset,
              passed: transaction.verification.passed,
              failed: transaction.verification.failed,
            }
          : null,
      },
    } : {}),
    recent_activity: getRecentActivity(MAX_ACTIVITY).map((entry) => ({
      time: entry.time,
      tool: entry.tool,
      action: entry.action,
      status: entry.status,
      summary: trimText(entry.summary || entry.target, 180),
    })),
  };
  return { machine, task, loop };
}

function newId(): string {
  return `ctx_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

function matches(
  record: ContextCapsuleRecord,
  workspace: string,
  taskId?: string,
  loopId?: string
): boolean {
  if (!sameResolvedPath(record.workspace, workspace)) return false;
  if (loopId) return record.coding_loop_id === loopId;
  if (taskId) return record.task_id === taskId;
  return true;
}

function promotableTaskCapsule(
  records: ContextCapsuleRecord[],
  workspace: string,
  taskId?: string,
  loopId?: string
): ContextCapsuleRecord | undefined {
  if (!taskId || !loopId) return undefined;
  return records.find((record) =>
    sameResolvedPath(record.workspace, workspace) &&
    record.task_id === taskId &&
    !record.coding_loop_id
  );
}

async function resolveAutoCheckpointTarget(
  workspace: string,
  taskId?: string,
  loopId?: string
): Promise<{
  built: Awaited<ReturnType<typeof buildMachineState>>;
  taskId?: string;
  loopId?: string;
  existing?: ContextCapsuleRecord;
}> {
  const built = await buildMachineState(workspace, taskId, loopId);
  if (!built.task && !built.loop) return { built };
  const effectiveTaskId = taskId || built.task?.id || built.loop?.task_id;
  const effectiveLoopId = loopId || built.loop?.id;
  const all = await readAll();
  const existing = all.find((record) => matches(record, workspace, effectiveTaskId, effectiveLoopId))
    || promotableTaskCapsule(all, workspace, effectiveTaskId, effectiveLoopId);
  return {
    built,
    taskId: effectiveTaskId,
    loopId: effectiveLoopId,
    existing,
  };
}

function machineFingerprint(machine: ContextCapsuleMachineState): string {
  const stable = {
    git: machine.git,
    task: machine.task,
    coding_loop: machine.coding_loop,
    transaction: machine.transaction,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 24);
}

export function getContextCapsuleConfig(): Record<string, unknown> {
  return {
    state_dir: stateRoot(),
    max_capsules: MAX_CAPSULES,
    max_record_bytes: MAX_RECORD_BYTES,
    auto_tool_call_threshold: toolCallThreshold(),
    auto_result_byte_threshold: resultByteThreshold(),
    rollover_recommendation_cycles: rolloverCycles(),
  };
}

export function getContextCapsuleHeuristicConfig(): { tool_calls: number; result_bytes: number; rollover_cycles: number } {
  return {
    tool_calls: toolCallThreshold(),
    result_bytes: resultByteThreshold(),
    rollover_cycles: rolloverCycles(),
  };
}

export function getContextCapsuleStateErrors(): string[] {
  return [...lastReadErrors];
}

export async function listContextCapsules(limit = 20): Promise<ContextCapsuleRecord[]> {
  return (await readAll()).slice(0, Math.min(Math.max(1, limit), MAX_CAPSULES));
}

export async function getContextCapsule(id: string): Promise<ContextCapsuleRecord> {
  assertCapsuleId(id);
  try {
    const parsed = JSON.parse(await fs.readFile(recordPath(id), "utf-8")) as ContextCapsuleRecord;
    if (parsed.id !== id) throw new Error("context capsule id mismatch");
    return normalizeRecord(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown context capsule: ${id}`);
    throw error;
  }
}

export async function checkpointContextCapsule(input: {
  id?: string;
  workspace: string;
  task_id?: string;
  coding_loop_id?: string;
  objective?: string;
  summary?: string;
  decisions?: string[];
  findings?: string[];
  blockers?: string[];
  next_steps?: string[];
  files?: Array<{ path: string; note?: string }>;
  semantic_mode?: "merge" | "replace";
  session_id?: string;
}): Promise<ContextCapsuleRecord> {
  return mutate(async () => {
    const workspace = path.resolve(input.workspace);
    const all = await readAll();
    let existing = input.id ? await getContextCapsule(input.id) : undefined;
    if (existing && !sameResolvedPath(existing.workspace, workspace)) {
      throw new Error(`Context capsule ${existing.id} belongs to a different workspace: ${existing.workspace}`);
    }
    if (existing?.task_id && input.task_id && existing.task_id !== input.task_id) {
      throw new Error(`Context capsule ${existing.id} is already linked to agent task ${existing.task_id}`);
    }
    if (existing?.coding_loop_id && input.coding_loop_id && existing.coding_loop_id !== input.coding_loop_id) {
      throw new Error(`Context capsule ${existing.id} is already linked to coding loop ${existing.coding_loop_id}`);
    }
    const built = await buildMachineState(workspace, input.task_id || existing?.task_id, input.coding_loop_id || existing?.coding_loop_id);
    const effectiveTaskId = input.task_id || existing?.task_id || built.task?.id || built.loop?.task_id;
    const effectiveLoopId = input.coding_loop_id || existing?.coding_loop_id || built.loop?.id;
    if (!existing) {
      if (effectiveTaskId || effectiveLoopId) {
        existing = all.find((record) => matches(record, workspace, effectiveTaskId, effectiveLoopId))
          || promotableTaskCapsule(all, workspace, effectiveTaskId, effectiveLoopId);
      } else {
        const workspaceRecords = all.filter((record) => sameResolvedPath(record.workspace, workspace));
        if (workspaceRecords.length === 1) existing = workspaceRecords[0];
      }
    }
    const createdAt = existing?.created_at || nowIso();
    const mergeSemantic = input.semantic_mode !== "replace";
    const semantic = normalizeSemantic({
      summary: input.summary !== undefined ? input.summary : mergeSemantic ? existing?.semantic.summary || "" : "",
      decisions: input.decisions !== undefined ? input.decisions : mergeSemantic ? existing?.semantic.decisions || [] : [],
      findings: input.findings !== undefined ? input.findings : mergeSemantic ? existing?.semantic.findings || [] : [],
      blockers: input.blockers !== undefined ? input.blockers : mergeSemantic ? existing?.semantic.blockers || [] : [],
      next_steps: input.next_steps !== undefined ? input.next_steps : mergeSemantic ? existing?.semantic.next_steps || [] : [],
      files: input.files !== undefined ? input.files : mergeSemantic ? existing?.semantic.files || [] : [],
    });
    const record: ContextCapsuleRecord = {
      version: VERSION,
      id: existing?.id || newId(),
      workspace,
      objective: trimText(
        input.objective || existing?.objective || built.task?.objective || built.loop?.goal || semantic.summary,
        4_000
      ),
      task_id: effectiveTaskId,
      coding_loop_id: effectiveLoopId,
      session_id: existing?.session_id || input.session_id || getCurrentSessionId(),
      semantic,
      machine: built.machine,
      checkpoint_count: (existing?.checkpoint_count || 0) + 1,
      auto_checkpoint_count: existing?.auto_checkpoint_count || 0,
      last_checkpoint_source: "manual",
      last_auto_reason: existing?.last_auto_reason,
      machine_fingerprint: machineFingerprint(built.machine),
      created_at: createdAt,
      updated_at: nowIso(),
    };
    return save(record);
  });
}

export async function autoCheckpointContextCapsule(input: {
  workspace: string;
  reason: string;
  task_id?: string;
  coding_loop_id?: string;
  session_id?: string;
}): Promise<ContextCapsuleRecord | null> {
  return mutate(async () => {
    const workspace = path.resolve(input.workspace);
    const target = await resolveAutoCheckpointTarget(workspace, input.task_id, input.coding_loop_id);
    const { built } = target;
    if (!built.task && !built.loop) return null;
    const taskId = target.taskId;
    const loopId = target.loopId;
    const existing = target.existing;
    const fingerprint = machineFingerprint(built.machine);
    const existingFingerprint = existing?.machine_fingerprint || (existing ? machineFingerprint(existing.machine) : null);
    if (existing && existingFingerprint === fingerprint) return null;
    const createdAt = existing?.created_at || nowIso();
    const record: ContextCapsuleRecord = {
      version: VERSION,
      id: existing?.id || newId(),
      workspace,
      objective: trimText(existing?.objective || built.task?.objective || built.loop?.goal, 4_000),
      task_id: taskId,
      coding_loop_id: loopId,
      session_id: existing?.session_id || input.session_id || getCurrentSessionId(),
      semantic: normalizeSemantic(existing?.semantic || emptySemantic()),
      machine: built.machine,
      checkpoint_count: existing?.checkpoint_count || 0,
      auto_checkpoint_count: (existing?.auto_checkpoint_count || 0) + 1,
      last_checkpoint_source: "auto",
      last_auto_reason: trimText(input.reason, 300),
      machine_fingerprint: fingerprint,
      created_at: createdAt,
      updated_at: nowIso(),
    };
    return save(record);
  });
}

/**
 * Resolve only the capsule associated with the active durable task/loop state.
 * Unlike manual resume, this never falls back to a workspace-only capsule and
 * therefore never becomes ambiguous merely because a project has history from
 * multiple completed tasks.
 */
export async function getAutoCheckpointContextCapsule(input: {
  workspace: string;
  task_id?: string;
  coding_loop_id?: string;
}): Promise<ContextCapsuleRecord | null> {
  const workspace = path.resolve(input.workspace);
  const target = await resolveAutoCheckpointTarget(workspace, input.task_id, input.coding_loop_id);
  if (!target.existing || (!target.built.task && !target.built.loop)) return null;
  return fitRecord({
    ...target.existing,
    task_id: target.taskId || target.existing.task_id,
    coding_loop_id: target.loopId || target.existing.coding_loop_id,
    machine: target.built.machine,
  });
}

export async function resumeContextCapsule(input: {
  workspace: string;
  id?: string;
  task_id?: string;
  coding_loop_id?: string;
  session_id?: string;
}): Promise<ContextCapsuleRecord | null> {
  const workspace = path.resolve(input.workspace);
  const initialBuilt = await buildMachineState(workspace, input.task_id, input.coding_loop_id);
  const effectiveTaskId = input.task_id || initialBuilt.task?.id || initialBuilt.loop?.task_id;
  const effectiveLoopId = input.coding_loop_id || initialBuilt.loop?.id;
  let record: ContextCapsuleRecord | undefined;
  if (input.id) {
    record = await getContextCapsule(input.id);
  } else {
    const all = await readAll();
    if (effectiveTaskId || effectiveLoopId) {
      record = all.find((candidate) => matches(candidate, workspace, effectiveTaskId, effectiveLoopId))
        || promotableTaskCapsule(all, workspace, effectiveTaskId, effectiveLoopId);
    } else {
      const workspaceRecords = all.filter((candidate) => sameResolvedPath(candidate.workspace, workspace));
      if (workspaceRecords.length > 1) {
        throw new Error(`Multiple context capsules exist for '${workspace}'. Provide an explicit capsule, task, or coding-loop id.`);
      }
      record = workspaceRecords[0];
    }
  }
  if (!record) return null;
  if (!sameResolvedPath(record.workspace, workspace)) {
    throw new Error(`Context capsule ${record.id} belongs to a different workspace: ${record.workspace}`);
  }
  if (record.task_id && input.task_id && record.task_id !== input.task_id) {
    throw new Error(`Context capsule ${record.id} is linked to agent task ${record.task_id}, not ${input.task_id}`);
  }
  if (record.coding_loop_id && input.coding_loop_id && record.coding_loop_id !== input.coding_loop_id) {
    throw new Error(`Context capsule ${record.id} is linked to coding loop ${record.coding_loop_id}, not ${input.coding_loop_id}`);
  }
  const built = await buildMachineState(workspace, input.task_id || record.task_id, input.coding_loop_id || record.coding_loop_id);
  return fitRecord({
    ...record,
    task_id: input.task_id || record.task_id || built.task?.id,
    coding_loop_id: input.coding_loop_id || record.coding_loop_id || built.loop?.id,
    session_id: record.session_id || input.session_id || getCurrentSessionId(),
    machine: built.machine,
  });
}

export async function deleteContextCapsule(id: string): Promise<void> {
  await mutate(async () => {
    assertCapsuleId(id);
    await fs.rm(recordPath(id), { force: true });
  });
}

export function compactContextCapsule(record: ContextCapsuleRecord) {
  return {
    id: record.id,
    workspace: record.workspace,
    objective: record.objective,
    task_id: record.task_id,
    coding_loop_id: record.coding_loop_id,
    session_id: record.session_id,
    checkpoint_count: record.checkpoint_count,
    auto_checkpoint_count: record.auto_checkpoint_count,
    last_checkpoint_source: record.last_checkpoint_source,
    last_auto_reason: record.last_auto_reason,
    has_semantic_summary: Boolean(
      record.semantic.summary ||
      record.semantic.decisions.length ||
      record.semantic.findings.length ||
      record.semantic.blockers.length ||
      record.semantic.next_steps.length ||
      record.semantic.files.length
    ),
    task_status: record.machine.task?.status ?? null,
    loop_status: record.machine.coding_loop?.status ?? null,
    loop_phase: record.machine.coding_loop?.phase ?? null,
    updated_at: record.updated_at,
  };
}