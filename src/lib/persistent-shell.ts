import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import { getCurrentSessionId } from "./session-context.js";
import { terminateChildProcessTree } from "./process-tree.js";
import { getWinShell } from "./win-shell.js";
export { getWinShell } from "./win-shell.js";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";

interface ShellSessionState {
  cwd: string | null;
  initializedAt: string | null;
  persistenceRoot: string | null;
  history: string[];
}

const shellSessions = new Map<string, ShellSessionState>();
const LEGACY_SESSION = "__legacy__";
const MAX_HISTORY = 50;
const MAX_SHELL_OUTPUT_CHARS = 400_000;

function persistShellCwd(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.MCP_SHELL_PERSIST_CWD || "").trim().toLowerCase());
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  await terminateChildProcessTree(child, true);
}

function shellKey(explicitSessionId?: string): string {
  return explicitSessionId || getCurrentSessionId() || LEGACY_SESSION;
}

function state(explicitSessionId?: string): ShellSessionState {
  const key = shellKey(explicitSessionId);
  let current = shellSessions.get(key);
  if (!current) {
    current = { cwd: null, initializedAt: null, persistenceRoot: null, history: [] };
    shellSessions.set(key, current);
  }
  return current;
}

export function setShellPersistenceRoot(workspaceRoot: string, sessionId?: string): void {
  state(sessionId).persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string, sessionId?: string): void {
  const current = state(sessionId);
  current.cwd = path.resolve(defaultCwd);
  current.initializedAt = new Date().toISOString();
  current.history.length = 0;
}

/** Restore cwd from disk for one MCP session. */
export async function bootstrapShellSession(defaultCwd: string, sessionId?: string): Promise<void> {
  const current = state(sessionId);
  setShellPersistenceRoot(defaultCwd, sessionId);
  if (!persistShellCwd()) {
    initShellSession(defaultCwd, sessionId);
    return;
  }
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd, shellKey(sessionId));
  if (saved?.cwd) {
    current.cwd = path.resolve(saved.cwd);
    current.initializedAt = saved.updated_at;
    if (saved.recent_commands?.length) {
      current.history.length = 0;
      current.history.push(...saved.recent_commands.slice(-MAX_HISTORY));
    }
    return;
  }
  initShellSession(defaultCwd, sessionId);
}

export function getShellCwd(): string {
  const current = state();
  if (!current.cwd) throw new Error("Shell session not initialized");
  return current.cwd;
}

export function resetShellSession(cwd: string): void {
  const current = state();
  current.cwd = path.resolve(cwd);
  current.initializedAt = new Date().toISOString();
  if (persistShellCwd() && current.persistenceRoot) {
    void saveGlobalShellState(current.persistenceRoot, current.cwd, undefined, null, shellKey());
  }
}

export function getShellStatus() {
  const current = state();
  return {
    active: current.cwd !== null,
    cwd: current.cwd,
    started_at: current.initializedAt,
    recent_commands: [...current.history].slice(-10),
    session_id: getCurrentSessionId() || null,
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Update cwd when a command starts with cd / Set-Location, matching persistent-shell behavior. */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd" };
}

export function transpileCompoundOperators(cmd: string): string {
  if (!cmd.includes("&&") && !cmd.includes("||")) return cmd;

  const tokens: { type: "text" | "&&" | "||"; value: string }[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < cmd.length) {
    const char = cmd[i];
    const nextChar = cmd[i + 1];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
    } else if (!inSingleQuote && !inDoubleQuote && char === "&" && nextChar === "&") {
      if (current.trim()) tokens.push({ type: "text", value: current.trim() });
      tokens.push({ type: "&&", value: "&&" });
      current = "";
      i += 2;
    } else if (!inSingleQuote && !inDoubleQuote && char === "|" && nextChar === "|") {
      if (current.trim()) tokens.push({ type: "text", value: current.trim() });
      tokens.push({ type: "||", value: "||" });
      current = "";
      i += 2;
    } else {
      current += char;
      i++;
    }
  }

  if (current.trim()) tokens.push({ type: "text", value: current.trim() });
  if (tokens.length <= 1) return cmd;

  let result = `${tokens[0].value}; $__localCoderSuccess = $?`;

  for (let j = 1; j < tokens.length; j += 2) {
    const op = tokens[j];
    const nextCmd = tokens[j + 1]?.value;
    if (!nextCmd) break;

    if (op.type === "&&") {
      result += `; if ($__localCoderSuccess) { ${nextCmd}; $__localCoderSuccess = $? }`;
    } else if (op.type === "||") {
      result += `; if (-not $__localCoderSuccess) { ${nextCmd}; $__localCoderSuccess = $? }`;
    }
  }

  return result;
}

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  return new Promise((resolve, reject) => {
    let effectiveCommand = command;
    let shell = "bash";
    let args: string[] = ["-lc", effectiveCommand];

    if (process.platform === "win32") {
      const winShellInfo = getWinShell();
      shell = winShellInfo.shell;
      if (!winShellInfo.isPwsh) {
        effectiveCommand = transpileCompoundOperators(command);
      }
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
    }

    const child = spawn(shell, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CI: "true",
        PAGER: "cat",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
        npm_config_yes: "true",
      },
    });

    if (child.stdin) {
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendBounded = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString();
      return next.length > MAX_SHELL_OUTPUT_CHARS ? next.slice(-MAX_SHELL_OUTPUT_CHARS) : next;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child).catch(() => child.kill("SIGKILL"));
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => (stdout = appendBounded(stdout, d)));
    child.stderr?.on("data", (d: Buffer) => (stderr = appendBounded(stderr, d)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
        return;
      }
      resolve({
        command,
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
        timed_out: false,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  const current = state();
  if (!current.cwd) initShellSession(defaultCwd);

  if (workingDirectory) {
    current.cwd = path.resolve(await Promise.resolve(workingDirectory));
  }

  const { cwd, command: effective } = applyCwdDirectives(current.cwd!, command);
  current.cwd = cwd;

  current.history.push(effective);
  if (current.history.length > MAX_HISTORY) current.history.shift();

  const result = await runOnce(effective, cwd, timeoutMs);
  current.cwd = cwd;

  if (persistShellCwd() && current.persistenceRoot) {
    const sessionId = shellKey();
    const prev = await loadGlobalShellState(current.persistenceRoot, defaultCwd, sessionId);
    await saveGlobalShellState(current.persistenceRoot, cwd, effective, prev, sessionId);
  }

  return result;
}

export function clearShellSession(sessionId: string): void {
  shellSessions.delete(sessionId);
}
