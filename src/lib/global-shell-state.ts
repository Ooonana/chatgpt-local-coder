import { createHash, randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";

export interface GlobalShellState {
  workspace_key: string;
  session_key?: string;
  cwd: string;
  updated_at: string;
  recent_commands: string[];
}

function getStateDir(): string {
  return process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state");
}
const MAX_RECENT = 20;
const stateWriteQueues = new Map<string, Promise<void>>();

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function sessionKey(sessionId?: string): string | null {
  if (!sessionId) return null;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function statePath(workspaceRoot: string, sessionId?: string): string {
  const scoped = sessionKey(sessionId);
  return path.join(
    getStateDir(),
    scoped
      ? `shell-${workspaceKey(workspaceRoot)}-${scoped}.json`
      : `shell-${workspaceKey(workspaceRoot)}.json`
  );
}

export async function loadGlobalShellState(
  workspaceRoot: string,
  defaultCwd: string,
  sessionId?: string
): Promise<GlobalShellState | null> {
  const target = statePath(workspaceRoot, sessionId);
  await stateWriteQueues.get(target)?.catch(() => undefined);
  try {
    const raw = await fs.readFile(target, "utf-8");
    const parsed = JSON.parse(raw) as GlobalShellState;
    if (!parsed.cwd) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveGlobalShellState(
  workspaceRoot: string,
  cwd: string,
  command?: string,
  previous?: GlobalShellState | null,
  sessionId?: string
): Promise<void> {
  const recent = [...(previous?.recent_commands ?? [])];
  if (command) {
    recent.push(command);
    while (recent.length > MAX_RECENT) recent.shift();
  }

  const state: GlobalShellState = {
    workspace_key: workspaceKey(workspaceRoot),
    ...(sessionKey(sessionId) ? { session_key: sessionKey(sessionId)! } : {}),
    cwd: path.resolve(cwd),
    updated_at: new Date().toISOString(),
    recent_commands: recent,
  };

  const target = statePath(workspaceRoot, sessionId);
  const previousWrite = stateWriteQueues.get(target) ?? Promise.resolve();
  const write = previousWrite.catch(() => undefined).then(async () => {
    await fs.mkdir(getStateDir(), { recursive: true });
    const temp = `${target}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf-8");
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  });
  stateWriteQueues.set(target, write);
  try {
    await write;
  } finally {
    if (stateWriteQueues.get(target) === write) stateWriteQueues.delete(target);
  }
}

export async function restoreShellFromDisk(
  workspaceRoot: string,
  defaultCwd: string,
  sessionId?: string
): Promise<string> {
  const saved = await loadGlobalShellState(workspaceRoot, defaultCwd, sessionId);
  return saved?.cwd ?? path.resolve(defaultCwd);
}