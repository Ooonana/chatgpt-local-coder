import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import {
  bootstrapShellSession,
  execInShellSession,
  getShellStatus,
  resetShellSession,
  getWinShell,
  transpileCompoundOperators,
} from "../lib/persistent-shell.js";

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface OneShotCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = 400_000;
const MAX_PROCESS_INPUT_CHARS = 100_000;

function getShellInvocation(command: string): { shell: string; args: string[]; effectiveCommand: string } {
  let shell = "bash";
  let effectiveCommand = command;
  let args = ["-lc", effectiveCommand];

  if (process.platform === "win32") {
    const winShellInfo = getWinShell();
    shell = winShellInfo.shell;
    if (!winShellInfo.isPwsh) effectiveCommand = transpileCompoundOperators(command);
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
  }

  return { shell, args, effectiveCommand };
}

async function killChildProcessTree(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
  if (process.platform !== "win32" || !child.pid) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const args = ["/PID", String(child.pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill.exe", args, { windowsHide: true });
    let stderr = "";
    killer.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    killer.on("error", reject);
    killer.on("close", (code) => {
      if (code === 0 || child.exitCode !== null) resolve();
      else reject(new Error(`taskkill failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

export async function runOneShotCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<OneShotCommandResult> {
  const started = Date.now();
  const { shell, args } = getShellInvocation(command);

  return await new Promise<OneShotCommandResult>((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        CI: "true",
        PAGER: "cat",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const trimLogs = () => {
      if (stdout.length > MAX_LOG_CHARS) stdout = stdout.slice(-MAX_LOG_CHARS);
      if (stderr.length > MAX_LOG_CHARS) stderr = stderr.slice(-MAX_LOG_CHARS);
    };

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      trimLogs();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      trimLogs();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void killChildProcessTree(child, true).catch(() => child.kill("SIGKILL"));
    }, timeoutMs);
    timer.unref?.();

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        stdout,
        stderr,
        exit_code: code ?? (timedOut ? 124 : 1),
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function appendLog(lines: string[], data: Buffer): void {
  lines.push(data.toString());
  let total = lines.reduce((sum, item) => sum + item.length, 0);
  while (total > MAX_LOG_CHARS && lines.length > 1) {
    const removed = lines.shift();
    total -= removed?.length || 0;
  }
}

async function terminateProcessTree(item: ManagedProcess, force: boolean): Promise<void> {
  await killChildProcessTree(item.child, force);
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run shell commands to verify work (tests, build, lint). Cwd persists across ChatGPT tool calls (saved to disk). Use shell_status to check cwd. Use start_process for long jobs.",
      inputSchema: {
        command: z.string(),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const result = await execInShellSession(command, defaultCwd, timeoutSec * 1000, cwdOverride);
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: result.exit_code === 0 ? "ok" : "error",
        details: { command, exit_code: result.exit_code },
      });
      return toolResult("run_command", result, {
        ok: result.exit_code === 0,
        summary: `exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "run_commands_parallel",
    {
      title: "Run Commands in Parallel",
      description:
        "Run independent shell commands concurrently in isolated processes. Use for builds/tests/searches that can safely run at the same time. Does not change the persistent run_command cwd.",
      inputSchema: {
        commands: z.array(z.object({
          command: z.string(),
          working_directory: z.string().optional(),
          timeout_seconds: z.number().int().positive().max(3600).optional(),
        })).min(1).max(16),
        concurrency: z.number().int().min(1).max(8).optional().default(4),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ commands, concurrency }) => {
      const defaultParallelCwd = getShellStatus().cwd || defaultCwd;
      const results: Array<OneShotCommandResult & { index: number; error?: string }> = new Array(commands.length);
      let nextIndex = 0;

      const worker = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= commands.length) return;
          const spec = commands[index];
          const started = Date.now();
          try {
            requireCommandAllowed(spec.command);
            const cwd = spec.working_directory ? await validatePath(spec.working_directory) : defaultParallelCwd;
            const result = await runOneShotCommand(
              spec.command,
              cwd,
              (spec.timeout_seconds ?? timeoutSec) * 1000
            );
            results[index] = { index, ...result };
            await audit({
              tool: "run_commands_parallel",
              action: "command",
              target: cwd,
              status: result.exit_code === 0 ? "ok" : "error",
              details: { index, command: spec.command, exit_code: result.exit_code, timed_out: result.timed_out },
            });
          } catch (error) {
            results[index] = {
              index,
              command: spec.command,
              cwd: spec.working_directory || defaultParallelCwd,
              stdout: "",
              stderr: "",
              exit_code: 1,
              signal: null,
              timed_out: false,
              duration_ms: Date.now() - started,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, commands.length) }, () => worker()));
      const failed = results.filter((result) => result.exit_code !== 0 || result.error).length;
      return toolResult(
        "run_commands_parallel",
        { results, count: results.length, failed, concurrency: Math.min(concurrency, commands.length) },
        { ok: failed === 0, summary: `${results.length - failed}/${results.length} command(s) succeeded` }
      );
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", status, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath) : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
      inputSchema: { command: z.string(), working_directory: z.string().optional() },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      const { shell, args } = getShellInvocation(command);

      const child = spawn(shell, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          CI: "true",
          PAGER: "cat",
          GIT_PAGER: "cat",
          NO_COLOR: "1",
        },
      });
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        id,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: [],
        stderr: [],
        exitCode: null,
        signal: null,
      };
      processes.set(id, item);
      child.stdout.on("data", (d: Buffer) => appendLog(item.stdout, d));
      child.stderr.on("data", (d: Buffer) => appendLog(item.stderr, d));
      child.on("close", (code, signal) => {
        item.exitCode = code;
        item.signal = signal;
      });
      await audit({ tool: "start_process", action: "start", target: cwd, status: "ok", details: { id, command } });
      return toolResult("start_process", { id, pid: child.pid, command, cwd, started_at: item.startedAt }, {
        summary: `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const processes_list = [...processes.values()]
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.child.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: p.exitCode === null && p.signal === null,
          stdin_writable: p.child.stdin.writable && !p.child.stdin.destroyed,
          exit_code: p.exitCode,
          signal: p.signal,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read stdout/stderr logs for a background process.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      const data = {
        id,
        pid: item.child.pid,
        command: item.command,
        cwd: item.cwd,
        running: item.exitCode === null && item.signal === null,
        stdin_writable: item.child.stdin.writable && !item.child.stdin.destroyed,
        exit_code: item.exitCode,
        signal: item.signal,
        stdout: item.stdout.join("").slice(-tail_chars),
        stderr: item.stderr.join("").slice(-tail_chars),
      };
      return toolResult("process_output", data, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "process_input",
    {
      title: "Send Process Input",
      description:
        "Send text to stdin of a running background process. Useful for prompts, REPLs, and dev tools that wait for input. This is piped stdin, not a full PTY.",
      inputSchema: {
        id: z.string(),
        input: z.string().max(MAX_PROCESS_INPUT_CHARS),
        append_newline: z.boolean().optional().default(true),
        close_stdin: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ id, input, append_newline, close_stdin }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (item.exitCode !== null || item.signal !== null) {
        throw new Error(`Process ${id} has already exited`);
      }
      if (!item.child.stdin.writable || item.child.stdin.destroyed) {
        throw new Error(`Process ${id} stdin is not writable`);
      }

      const payload = append_newline ? `${input}${process.platform === "win32" ? "\r\n" : "\n"}` : input;
      await new Promise<void>((resolve, reject) => {
        item.child.stdin.write(payload, (err) => (err ? reject(err) : resolve()));
      });
      if (close_stdin) item.child.stdin.end();

      await audit({
        tool: "process_input",
        action: "input",
        target: item.cwd,
        status: "ok",
        details: { id, chars: input.length, append_newline, close_stdin },
      });
      return toolResult(
        "process_input",
        { id, chars: input.length, append_newline, close_stdin },
        { summary: `sent ${input.length} char(s) to ${id}` }
      );
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (item.exitCode !== null || item.signal !== null) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      await terminateProcessTree(item, force);
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: "ok", details: { id, force } });
      return toolResult("stop_process", { id, force }, { summary: `stop sent to ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      let cleared = 0;
      for (const [id, item] of processes) {
        if (item.exitCode !== null || item.signal !== null) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}