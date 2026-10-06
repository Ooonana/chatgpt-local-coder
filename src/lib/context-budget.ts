import { normalizedPathIdentity } from "./path-identity.js";

interface ContextBudgetState {
  tool_calls: number;
  result_bytes: number;
  cycles: number;
  updated_at_ms: number;
}

export interface ContextBudgetSnapshot {
  workspace: string;
  tool_calls: number;
  result_bytes: number;
  cycles: number;
  due: boolean;
}

const states = new Map<string, ContextBudgetState>();
const MAX_STATES = 256;

function idleResetMs(): number {
  const parsed = Number(process.env.MCP_CONTEXT_BUDGET_IDLE_RESET_MS || 2 * 60 * 60 * 1000);
  if (!Number.isFinite(parsed) || parsed < 60_000) return 2 * 60 * 60 * 1000;
  return Math.min(Math.trunc(parsed), 24 * 60 * 60 * 1000);
}

function keyFor(workspace: string): string {
  return normalizedPathIdentity(workspace);
}

function stateFor(workspace: string): ContextBudgetState {
  const key = keyFor(workspace);
  const now = Date.now();
  const existing = states.get(key);
  if (existing && now - existing.updated_at_ms <= idleResetMs()) {
    existing.updated_at_ms = now;
    return existing;
  }
  const fresh: ContextBudgetState = { tool_calls: 0, result_bytes: 0, cycles: 0, updated_at_ms: now };
  states.set(key, fresh);
  prune();
  return fresh;
}

function prune(): void {
  if (states.size <= MAX_STATES) return;
  const oldest = [...states.entries()].sort((a, b) => a[1].updated_at_ms - b[1].updated_at_ms);
  while (states.size > MAX_STATES && oldest.length) states.delete(oldest.shift()![0]);
}

export function recordContextBudgetActivity(
  workspace: string,
  resultBytes: number,
  thresholds: { tool_calls: number; result_bytes: number }
): ContextBudgetSnapshot {
  const state = stateFor(workspace);
  state.tool_calls++;
  state.result_bytes += Math.max(0, resultBytes);
  state.updated_at_ms = Date.now();
  return {
    workspace,
    tool_calls: state.tool_calls,
    result_bytes: state.result_bytes,
    cycles: state.cycles,
    due: state.tool_calls >= thresholds.tool_calls || state.result_bytes >= thresholds.result_bytes,
  };
}

export function resetContextBudgetWindow(workspace: string): void {
  const state = stateFor(workspace);
  state.tool_calls = 0;
  state.result_bytes = 0;
  state.updated_at_ms = Date.now();
}

export function incrementContextBudgetCycle(workspace: string): number {
  const state = stateFor(workspace);
  state.cycles++;
  state.updated_at_ms = Date.now();
  return state.cycles;
}

export function getContextBudgetSnapshot(workspace: string): ContextBudgetSnapshot {
  const state = stateFor(workspace);
  return {
    workspace,
    tool_calls: state.tool_calls,
    result_bytes: state.result_bytes,
    cycles: state.cycles,
    due: false,
  };
}

export function clearContextBudget(workspace: string): void {
  states.delete(keyFor(workspace));
}

export function resetContextBudgetStateForTests(): void {
  states.clear();
}