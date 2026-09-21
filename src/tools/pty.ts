import { spawn } from "child_process";
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

interface ManagedPty {
  id: string;
  command?: string;
  cwd: string;
  startedAt: string;
  terminal: IPty;
  output: string[];
  outputChars: number;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
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
    const outcome = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        "taskkill.exe",
        ["/PID", String(item.terminal.pid), "/T", "/F"],
        { windowsHide: true }
      );
      let stderr = "";
      child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
      child.on("error", (error) => resolve({ code: null, stderr: error.message }));
      child.on("close", (code) => resolve({ code, stderr: stderr.trim() }));
    });
    if (outcome.code === 0 || item.exitCode !== null) return;

    // The shell can exit naturally between the last status check and taskkill.
    // Avoid falling back to node-pty.kill() on Windows because that is exactly
    // the ConPTY path with the AttachConsole race described above.
    try {
      process.kill(item.terminal.pid, 0);
    } catch {
      return;
    }
    throw new Error(`taskkill failed for PTY ${item.id}: ${outcome.stderr || `exit ${outcome.code}`}`);
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
    async ({ action, id, command, working_directory, input, append_newline, cols, rows, tail_chars, strip_ansi, wait_ms, wait_for }) => {
      if (action === "list") {
        const list = [...terminals.values()].map(statusOf);
        return toolResult("pty", { action, terminals: list }, { summary: `${list.length} PTY session(s)` });
      }

      if (action === "clear") {
        let cleared = 0;
        for (const [terminalId, item] of terminals) {
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
        item.terminal.resize(cols, rows);
        item.cols = cols;
        item.rows = rows;
        await audit({ tool: "pty", action: "resize", target: item.cwd, status: "ok", details: { id, cols, rows } });
        return toolResult("pty", { action, ...statusOf(item) }, { summary: `resized PTY ${id} to ${cols}x${rows}` });
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
