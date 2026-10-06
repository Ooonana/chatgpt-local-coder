import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

export type SessionWorkspaceKind = "unbound" | "project" | "machine";
export type SessionConnectionState = "initializing" | "connected" | "disconnected" | "closed";

export interface SessionRuntimeState {
  session_id: string;
  default_workspace: string;
  workspace_kind: SessionWorkspaceKind;
  project_root: string | null;
  project_alias: string | null;
  connection: SessionConnectionState;
  created_at: string;
  last_client_activity_at: string;
  disconnected_at: string | null;
  closed_at: string | null;
}

interface SessionExecutionContext {
  session_id: string;
}

const storage = new AsyncLocalStorage<SessionExecutionContext>();
const states = new Map<string, SessionRuntimeState>();

function nowIso(): string {
  return new Date().toISOString();
}

function shortAlias(root: string): string {
  const normalized = root.replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized;
}

export function ensureSessionRuntimeState(sessionId: string, defaultWorkspace: string): SessionRuntimeState {
  const existing = states.get(sessionId);
  if (existing) return existing;
  const now = nowIso();
  const created: SessionRuntimeState = {
    session_id: sessionId,
    default_workspace: path.resolve(defaultWorkspace),
    workspace_kind: "unbound",
    project_root: null,
    project_alias: null,
    connection: "initializing",
    created_at: now,
    last_client_activity_at: now,
    disconnected_at: null,
    closed_at: null,
  };
  states.set(sessionId, created);
  return created;
}

export function runWithSessionContext<T>(sessionId: string, fn: () => T): T {
  return storage.run({ session_id: sessionId }, fn);
}

export function getCurrentSessionId(): string | undefined {
  return storage.getStore()?.session_id;
}

export function getCurrentSessionState(): SessionRuntimeState | undefined {
  const id = getCurrentSessionId();
  return id ? states.get(id) : undefined;
}

export function getSessionRuntimeState(sessionId: string): SessionRuntimeState | undefined {
  return states.get(sessionId);
}

export function touchSessionClient(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.last_client_activity_at = nowIso();
  if (state.connection !== "closed") {
    state.connection = "connected";
    state.disconnected_at = null;
  }
}

export function markSessionConnection(
  sessionId: string,
  connection: SessionConnectionState,
  defaultWorkspace?: string
): SessionRuntimeState {
  const state = ensureSessionRuntimeState(sessionId, defaultWorkspace || process.cwd());
  const now = nowIso();
  state.connection = connection;
  if (connection === "connected") {
    state.last_client_activity_at = now;
    state.disconnected_at = null;
    state.closed_at = null;
  } else if (connection === "disconnected") {
    state.disconnected_at = state.disconnected_at || now;
  } else if (connection === "closed") {
    state.closed_at = now;
  }
  return state;
}

export function bindCurrentSessionProject(root: string, alias?: string): SessionRuntimeState | undefined {
  const state = getCurrentSessionState();
  if (!state) return undefined;
  const resolved = path.resolve(root);
  state.workspace_kind = "project";
  state.project_root = resolved;
  state.project_alias = alias || shortAlias(resolved);
  return state;
}

export function bindCurrentSessionMachine(): SessionRuntimeState | undefined {
  const state = getCurrentSessionState();
  if (!state) return undefined;
  state.workspace_kind = "machine";
  state.project_root = null;
  state.project_alias = null;
  return state;
}

function normalizedForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInsideSessionProject(target: string): boolean {
  const state = getCurrentSessionState();
  if (!state || state.workspace_kind !== "project" || !state.project_root) return true;
  const root = normalizedForComparison(state.project_root);
  const candidate = normalizedForComparison(target);
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Protect project-bound sessions from silently mutating a different project.
 * Machine/unbound sessions intentionally retain broad host access.
 */
export function assertCurrentSessionMutationPath(target: string, operation = "mutation"): void {
  const state = getCurrentSessionState();
  if (!state || state.workspace_kind !== "project" || !state.project_root) return;
  if (isPathInsideSessionProject(target)) return;
  throw new Error(
    `Cross-workspace mutation blocked for ${operation}. This MCP session is bound to '${state.project_alias || state.project_root}' (${state.project_root}), but the target is '${path.resolve(target)}'. Use project_context to explicitly switch projects, or switch to machine context for deliberate host-wide work.`
  );
}

export function listSessionRuntimeStates(): SessionRuntimeState[] {
  return [...states.values()]
    .map((state) => ({ ...state }))
    .sort((a, b) => b.last_client_activity_at.localeCompare(a.last_client_activity_at));
}

export function pruneSessionRuntimeStates(keepIds: Set<string>, maxRetained = 64): void {
  const removable = [...states.values()]
    .filter((state) => !keepIds.has(state.session_id) && state.connection === "closed")
    .sort((a, b) => (a.closed_at || a.last_client_activity_at).localeCompare(b.closed_at || b.last_client_activity_at));
  while (states.size > maxRetained && removable.length) {
    states.delete(removable.shift()!.session_id);
  }
}

export function resetSessionContextForTests(): void {
  states.clear();
}