import { z } from "zod";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed, requireUnsafeRuntimeAllowed } from "../lib/permissions.js";
import { getShellStatus, getWinShell } from "../lib/persistent-shell.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { canonicalProjectRootForPath, resolveWorkspaceScope, sameProjectRoot } from "../lib/workspace-scope.js";
import { terminateWindowsProcessTree } from "../lib/process-tree.js";

interface ManagedPty {
  id: string;
  command?: string;
  cwd: string;
  projectRoot?: string | null;
  startedAt: string;
  terminal: IPty;
  output: string[];
  outputChars: number;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
}

interface WindowsPtyAgentInternals {
  _inSocket?: { readable: boolean; destroy(): void };
  _outSocket?: { readable: boolean; destroy(): void };
  _conoutSocketWorker?: { dispose(): void };
  _ptyNative?: { kill(ptyId: number, useConptyDll: boolean): void };
  _pty?: number;
  _useConptyDll?: boolean;
}

interface WindowsPtyInternals extends IPty {
  _agent?: WindowsPtyAgentInternals;
}

const terminals = new Map<string, ManagedPty>();
const MAX_OUTPUT_CHARS = 500_000;
const MAX_RETAINED_PTYS = 48;
const MAX_INPUT_CHARS = 100_000;

function pruneFinishedPtys(): void {
  if (terminals.size <= MAX_RETAINED_PTYS) return;
  const finished = [...terminals.values()]
    .filter((item) => item.exitCode !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  while (terminals.size > MAX_RETAINED_PTYS && finished.length) {
    terminals.delete(finished.shift()!.id);
  }
}

export function getPtySessionSnapshot() {
  return [...terminals.values()].map(statusOf);
}

function appendOutput(item: ManagedPty, data: string): void {
  item.output.push(data);
  item.outputChars += data.length;
  while (item.outputChars > MAX_OUTPUT_CHARS && item.output.length > 1) {
    const removed = item.output.shift() || "";
    item.outputChars -= removed.length;
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function ptyEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  return env;
}

function shellSpec(command?: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const shell = getWinShell().shell;
    return {
      file: shell,
      args: command
        ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        : ["-NoLogo", "-NoProfile"],
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: command ? ["-lc", command] : ["-l"],
  };
}

function statusOf(item: ManagedPty) {
  return {
    id: item.id,
    pid: item.terminal.pid,
    command: item.command ?? null,
    cwd: item.cwd,
    project_root: item.projectRoot ?? null,
    started_at: item.startedAt,
    running: item.exitCode === null,
    exit_code: item.exitCode,
    signal: item.signal,
    cols: item.cols,
    rows: item.rows,
  };
}

async function waitForPtyExit(item: ManagedPty, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (item.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return item.exitCode !== null;
}

async function terminatePty(item: ManagedPty): Promise<void> {
  if (item.exitCode !== null) return;

  // node-pty 1.1.0 has a Windows ConPTY kill() race where its helper can lose
  // the console before AttachConsole runs, printing an uncaught stack trace and
  // delaying descendant cleanup. Kill the shell tree ourselves on Windows and
  // let ConPTY observe the process exit instead of entering that buggy path.
  if (process.platform === "win32" && item.terminal.pid) {
    await terminateWindowsProcessTree(item.terminal.pid, true);
    // node-pty's public Windows kill() first calls _getConsoleProcessList(),
    // which uses AttachConsole and can race after the shell has already died.
    // We have already terminated the real process tree, so close only the
    // remaining ConPTY resources directly: pseudo-console handle, pipes, and
    // conout worker. This also handles silent PTYs that never become "ready"
    // and therefore never execute node-pty's deferred kill().
    const agent = (item.terminal as WindowsPtyInternals)._agent;
    if (agent) {
      try {
        if (agent._inSocket) {
          agent._inSocket.readable = false;
        }
      } catch {}
      try {
        if (agent._outSocket) {
          agent._outSocket.readable = false;
        }
      } catch {}
      try {
        if (agent._ptyNative && typeof agent._pty === "number") {
          agent._ptyNative.kill(agent._pty, Boolean(agent._useConptyDll));
        }
      } catch {}
      try {
        agent._conoutSocketWorker?.dispose();
      } catch {}
    }
    return;
  }

  item.terminal.kill();
}

async function waitForOutput(item: ManagedPty, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (item.output.join("").includes(needle)) return true;
    if (item.exitCode !== null) return item.output.join("").includes(needle);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return item.output.join("").includes(needle);
}

async function waitForOutputGrowth(item: ManagedPty, baselineChars: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (item.outputChars > baselineChars) return true;
    if (item.exitCode !== null) return item.outputChars > baselineChars;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return item.outputChars > baselineChars;
}

export async function shutdownPtySessions(): Promise<number> {
  let stopped = 0;
  for (const item of terminals.values()) {
    if (item.exitCode !== null) continue;
    try {
      await terminatePty(item);
      await waitForPtyExit(item);
      stopped++;
    } catch {}
  }
  return stopped;
}

export function registerPtyTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "pty",
    {
      title: "Pseudo Terminal",
      description:
        "Manage real interactive terminal sessions backed by a PTY/ConPTY. Use this for TUIs, debuggers, interactive installers, shells, and CLIs that behave incorrectly with piped stdin. Actions: start, list, status, read, write, resize, stop, clear.",
      inputSchema: {
        action: z.enum(["start", "list", "status", "read", "write", "resize", "stop", "clear"]),
        id: z.string().optional(),
        command: z.string().max(500_000).optional(),
        working_directory: z.string().optional(),
        workspace: z.string().optional().describe("Project/machine scope for list/read/control after transport recreation"),
        input: z.string().max(MAX_INPUT_CHARS).optional(),
        append_newline: z.boolean().optional().default(true),
        cols: z.number().int().min(20).max(500).optional().default(120),
        rows: z.number().int().min(5).max(200).optional().default(30),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
        strip_ansi: z.boolean().optional().default(true),
        wait_ms: z.number().int().nonnegative().max(15000).optional().default(0),
        wait_for: z.string().max(500).optional().describe("For read: wait until this text appears or wait_ms expires"),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ action, id, command, working_directory, workspace, input, append_newline, cols, rows, tail_chars, strip_ansi, wait_ms, wait_for }) => {
      const scope = action === "start" ? null : await resolveWorkspaceScope(workspace);
      if (action === "list") {
        const list = [...terminals.values()]
          .filter((item) => !scope?.scoped || sameProjectRoot(item.projectRoot, scope.projectRoot))
          .map(statusOf);
        return toolResult("pty", { action, terminals: list }, { summary: `${list.length} PTY session(s)` });
      }

      if (action === "clear") {
        let cleared = 0;
        for (const [terminalId, item] of terminals) {
          if (scope?.scoped && !sameProjectRoot(item.projectRoot, scope.projectRoot)) continue;
          if (item.exitCode !== null) {
            terminals.delete(terminalId);
            cleared++;
          }
        }
        return toolResult("pty", { action, cleared }, { summary: `cleared ${cleared} PTY session(s)` });
      }

      if (action === "start") {
        requireUnsafeRuntimeAllowed("PTY/ConPTY session");
        const cwd = working_directory
          ? await validatePath(working_directory)
          : getShellStatus().cwd || defaultCwd;
        const projectRoot = await canonicalProjectRootForPath(cwd);
        if (command) requireCommandAllowed(command, cwd);
        const spec = shellSpec(command);
        const terminal = pty.spawn(spec.file, spec.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: ptyEnvironment(),
          useConpty: process.platform === "win32",
        });
        const terminalId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const item: ManagedPty = {
          id: terminalId,
          command,
          cwd,
          projectRoot,
          startedAt: new Date().toISOString(),
          terminal,
          output: [],
          outputChars: 0,
          exitCode: null,
          signal: null,
          cols,
          rows,
        };
        terminals.set(terminalId, item);
        terminal.onData((data) => appendOutput(item, data));
        terminal.onExit(({ exitCode, signal }) => {
          item.exitCode = exitCode;
          item.signal = signal ?? null;
          pruneFinishedPtys();
        });
        await audit({
          tool: "pty",
          action: "start",
          target: cwd,
          status: "ok",
          details: { id: terminalId, command: command ?? null, pid: terminal.pid, cols, rows },
        });
        return toolResult("pty", { action, ...statusOf(item) }, { summary: `started PTY ${terminalId}` });
      }

      if (!id) throw new Error(`id is required for PTY action '${action}'`);
      const item = terminals.get(id);
      if (!item) throw new Error(`Unknown PTY id: ${id}`);
      if (scope?.scoped && !sameProjectRoot(item.projectRoot, scope.projectRoot)) {
        throw new Error(`PTY ${id} is outside the requested workspace scope.`);
      }

      if (action === "status") {
        return toolResult("pty", { action, ...statusOf(item) }, { summary: `${id}: ${item.exitCode === null ? "running" : `exit ${item.exitCode}`}` });
      }

      if (action === "read") {
        const baselineChars = item.outputChars;
        if (wait_for) {
          await waitForOutput(item, wait_for, wait_ms || 3000);
        } else if (wait_ms > 0) {
          await waitForOutputGrowth(item, baselineChars, wait_ms);
        }
        const raw = item.output.join("").slice(-tail_chars);
        return toolResult(
          "pty",
          {
            action,
            ...statusOf(item),
            output: strip_ansi ? stripAnsi(raw) : raw,
            stripped_ansi: strip_ansi,
            wait_for: wait_for ?? null,
            matched: wait_for ? raw.includes(wait_for) : null,
          },
          { summary: `PTY output for ${id}` }
        );
      }

      if (action === "stop" && item.exitCode !== null) {
        return toolResult("pty", { action, id, already_exited: true, exit_code: item.exitCode }, { summary: `PTY ${id} already exited` });
      }
      if (item.exitCode !== null) throw new Error(`PTY ${id} has already exited with code ${item.exitCode}`);

      if (action === "write") {
        if (!scope?.scoped) {
          throw new Error(`workspace is required to control PTY ${id} from an unbound MCP transport.`);
        }
        requireUnsafeRuntimeAllowed("PTY/ConPTY input");
        if (input === undefined) throw new Error("input is required for PTY write");
        const payload = append_newline ? `${input}\r` : input;
        item.terminal.write(payload);
        await audit({
          tool: "pty",
          action: "write",
          target: item.cwd,
          status: "ok",
          details: { id, chars: input.length, append_newline },
        });
        return toolResult("pty", { action, id, chars: input.length, append_newline }, { summary: `sent ${input.length} char(s) to PTY ${id}` });
      }

      if (action === "resize") {
        if (!scope?.scoped) {
          throw new Error(`workspace is required to control PTY ${id} from an unbound MCP transport.`);
        }
        item.terminal.resize(cols, rows);
        item.cols = cols;
        item.rows = rows;
        await audit({ tool: "pty", action: "resize", target: item.cwd, status: "ok", details: { id, cols, rows } });
        return toolResult("pty", { action, ...statusOf(item) }, { summary: `resized PTY ${id} to ${cols}x${rows}` });
      }

      if (!scope?.scoped) {
        throw new Error(`workspace is required to control PTY ${id} from an unbound MCP transport.`);
      }
      await terminatePty(item);
      const exited = await waitForPtyExit(item);
      await audit({ tool: "pty", action: "stop", target: item.cwd, status: "ok", details: { id } });
      return toolResult(
        "pty",
        { action, id, exited, exit_code: item.exitCode, signal: item.signal },
        { summary: exited ? `stopped PTY ${id}` : `stop sent to PTY ${id}` }
      );
    }
  );
}
