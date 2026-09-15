import { randomUUID } from "node:crypto";

export type RuntimeToolKind = "READ" | "EDIT" | "EXEC" | "MCP";

export interface ActiveToolCall {
  id: string;
  tool: string;
  kind: RuntimeToolKind;
  summary: string;
  started_at: string;
  started_ms: number;
}

export interface CompletedToolCall {
  id: string;
  tool: string;
  kind: RuntimeToolKind;
  summary: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
}

export interface ToolUsageStat {
  tool: string;
  calls: number;
  ok: number;
  errors: number;
  total_duration_ms: number;
  average_duration_ms: number;
}

export interface RuntimeSnapshot {
  started_at: string;
  active: ActiveToolCall[];
  recent: CompletedToolCall[];
  total_calls: number;
  total_ok: number;
  total_errors: number;
  usage: ToolUsageStat[];
}

const STARTED_AT = new Date().toISOString();
const MAX_RECENT = 100;
const active = new Map<string, ActiveToolCall>();
const recent: CompletedToolCall[] = [];
const usage = new Map<string, Omit<ToolUsageStat, "tool" | "average_duration_ms">>();
const listeners = new Set<() => void>();
let totalCalls = 0;
let totalOk = 0;
let totalErrors = 0;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

function trimOneLine(value: string, max = 180): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function beginToolCall(input: {
  tool: string;
  kind: RuntimeToolKind;
  summary?: string;
}): string {
  const id = randomUUID();
  const startedMs = Date.now();
  active.set(id, {
    id,
    tool: input.tool,
    kind: input.kind,
    summary: trimOneLine(input.summary || ""),
    started_at: new Date(startedMs).toISOString(),
    started_ms: startedMs,
  });
  notify();
  return id;
}

export function finishToolCall(
  id: string,
  status: "ok" | "error",
  error?: string
): CompletedToolCall | undefined {
  const item = active.get(id);
  if (!item) return undefined;
  active.delete(id);

  const finishedMs = Date.now();
  const durationMs = Math.max(0, finishedMs - item.started_ms);
  const completed: CompletedToolCall = {
    id: item.id,
    tool: item.tool,
    kind: item.kind,
    summary: item.summary,
    started_at: item.started_at,
    finished_at: new Date(finishedMs).toISOString(),
    duration_ms: durationMs,
    status,
    error: error ? trimOneLine(error, 220) : undefined,
  };
  recent.unshift(completed);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;

  totalCalls++;
  if (status === "ok") totalOk++;
  else totalErrors++;

  const stat = usage.get(item.tool) ?? {
    calls: 0,
    ok: 0,
    errors: 0,
    total_duration_ms: 0,
  };
  stat.calls++;
  if (status === "ok") stat.ok++;
  else stat.errors++;
  stat.total_duration_ms += durationMs;
  usage.set(item.tool, stat);

  notify();
  return completed;
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return {
    started_at: STARTED_AT,
    active: [...active.values()].sort((a, b) => a.started_ms - b.started_ms),
    recent: [...recent],
    total_calls: totalCalls,
    total_ok: totalOk,
    total_errors: totalErrors,
    usage: [...usage.entries()]
      .map(([tool, stat]) => ({
        tool,
        ...stat,
        average_duration_ms: stat.calls ? Math.round(stat.total_duration_ms / stat.calls) : 0,
      }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
  };
}

export function subscribeRuntimeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset. Kept out of normal runtime flows. */
export function resetRuntimeStateForTests(): void {
  active.clear();
  recent.length = 0;
  usage.clear();
  totalCalls = 0;
  totalOk = 0;
  totalErrors = 0;
  notify();
}