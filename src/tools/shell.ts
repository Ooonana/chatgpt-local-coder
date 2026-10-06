import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "node:path";
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
import {
  getOperationRecord,
  listOperationHistory,
  recordOperationFinish,
  recordOperationStart,
} from "../lib/operation-store.js";
import { getAgentTask } from "../lib/agent-task-store.js";
import { classifyToolFailure } from "../lib/error-model.js";
import { compactOrStoreText, readTextResult } from "../lib/result-store.js";
import {
  loadParallelBatch,
  newParallelBatchId,
  saveParallelBatch,
  type ParallelBatchRecord,
  type ParallelCommandResult,
  type ParallelCommandSpec,
} from "../lib/parallel-batch-store.js";
import { detectProjectRoot, isProjectRoot } from "../lib/project-affinity.js";
import { captureWorkingTree, commandMayMutate, compareWorkingTrees } from "../lib/shell-mutation.js";
import { loadIdempotent, requestFingerprint, saveIdempotent, withIdempotencyKeyLock } from "../lib/idempotency-store.js";
import { captureTransactionPaths, getEditTransaction, recordTransactionEdit, withEditTransactionLock } from "../lib/edit-transaction-store.js";
import {
  getCurrentSessionId,
  getCurrentSessionState,
} from "../lib/session-context.js";

interface ManagedProcess {
  id: string;
  label?: string;
  taskId?: string;
  sessionId?: string;
  projectRoot?: string | null;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  stopRequested?: boolean;
  startWrite?: Promise<void>;
  historyWrite?: Promise<void>;
  historyError?: string;
  lastActivityAt: string;
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
const MAX_RETAINED_PROCESSES = 64;
const MAX_PROCESS_INPUT_CHARS = 100_000;
const MAX_COMMAND_CHARS = 500_000;

function pruneFinishedProcesses(): void {
  if (processes.size <= MAX_RETAINED_PROCESSES) return;
  const finished = [...processes.values()]
    .filter((item) => item.exitCode !== null || item.signal !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  while (processes.size > MAX_RETAINED_PROCESSES && finished.length) {
    const item = finished.shift()!;
    processes.delete(item.id);
  }
}

export function getManagedProcessSnapshot() {
  const now = Date.now();
  return [...processes.values()].map((item) => ({
    id: item.id,
    label: item.label,
    task_id: item.taskId,
    session_id: item.sessionId,
    project_root: item.projectRoot,
    pid: item.child.pid,
    command: item.command,
    cwd: item.cwd,
    started_at: item.startedAt,
    running: item.exitCode === null && item.signal === null,
    exit_code: item.exitCode,
    signal: item.signal,
    last_activity_at: item.lastActivityAt,
    liveness: !processRunning(item)
      ? "exited"
      : now - Date.parse(item.lastActivityAt) > 10 * 60_000
        ? "possibly_stalled"
        : now - Date.parse(item.lastActivityAt) > 2 * 60_000
          ? "silent"
          : "active",
  }));
}

function sameRoot(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return left == null && right == null;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function projectRootForCwd(cwd: string): Promise<string | null> {
  const root = await detectProjectRoot(cwd).catch(() => cwd);
  return await isProjectRoot(root).catch(() => false) ? root : null;
}

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
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {}
  }
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
      detached: process.platform !== "win32",
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
    let timer: NodeJS.Timeout | undefined;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    timer = setTimeout(() => {
      timedOut = true;
      void killChildProcessTree(child, true).catch(() => child.kill("SIGKILL"));
    }, timeoutMs);
    timer.unref?.();

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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

function processRunning(item: ManagedProcess): boolean {
  return item.exitCode === null && item.signal === null && !item.spawnError;
}

async function waitForProcessCondition(
  item: ManagedProcess,
  options: { waitFor: "exit" | "text"; waitText?: string; timeoutMs: number }
): Promise<{ condition_met: boolean; timed_out: boolean; waited_ms: number }> {
  const started = Date.now();
  const matches = () => {
    if (options.waitFor === "exit") return !processRunning(item);
    const needle = options.waitText || "";
    return Boolean(needle) && `${item.stdout.join("")}\n${item.stderr.join("")}`.includes(needle);
  };
  if (matches()) return { condition_met: true, timed_out: false, waited_ms: 0 };
  if (!processRunning(item)) return { condition_met: false, timed_out: false, waited_ms: 0 };

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (conditionMet: boolean, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      item.child.off("close", onChange);
      item.child.stdout.off("data", onChange);
      item.child.stderr.off("data", onChange);
      resolve({ condition_met: conditionMet, timed_out: timedOut, waited_ms: Date.now() - started });
    };
    const onChange = () => {
      if (matches()) finish(true, false);
      else if (!processRunning(item)) finish(false, false);
    };
    const timer = setTimeout(() => finish(matches(), true), Math.max(0, options.timeoutMs));
    timer.unref?.();
    item.child.once("close", onChange);
    item.child.stdout.on("data", onChange);
    item.child.stderr.on("data", onChange);
  });
}

async function compactCommandResult<T extends { stdout: string; stderr: string }>(result: T, prefix: string): Promise<T & {
  output_handle?: string | null;
  output_chars?: number;
  truncated?: boolean;
}> {
  const combined = `STDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}`;
  const compact = await compactOrStoreText(combined, { inline_chars: 32_000, prefix });
  if (!compact.truncated) return { ...result, output_handle: null, output_chars: combined.length, truncated: false };
  return {
    ...result,
    stdout: result.stdout.slice(-16_000),
    stderr: result.stderr.slice(-16_000),
    output_handle: compact.output_handle,
    output_chars: compact.output_chars,
    truncated: true,
  };
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

async function waitForManagedProcessExit(item: ManagedProcess, timeoutMs = 2_000): Promise<void> {
  if (item.exitCode !== null || item.signal !== null || item.spawnError) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    item.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function shutdownManagedProcesses(): Promise<void> {
  const active = [...processes.values()].filter(
    (item) => item.exitCode === null && item.signal === null && !item.spawnError
  );
  for (const item of active) item.stopRequested = true;
  await Promise.allSettled(active.map((item) => terminateProcessTree(item, true)));
  await Promise.all(active.map((item) => waitForManagedProcessExit(item)));
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number, sessionId = "legacy"): void {
  void bootstrapShellSession(defaultCwd, sessionId);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run a short bounded shell command in this MCP session's cwd. For long work use start_process + process_status/process_output; do not build Start-Sleep polling loops. success_exit_codes marks expected domain exits as successful.",
      inputSchema: {
        command: z.string().max(MAX_COMMAND_CHARS),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
        timeout_seconds: z.number().int().positive().max(3600).optional()
          .describe("Per-call timeout in seconds. Defaults to SHELL_TIMEOUT (300s by default). Use start_process for continuous jobs."),
        success_exit_codes: z.array(z.number().int()).min(1).max(16).optional().default([0]),
        idempotency_key: z.string().min(1).max(200).optional(),
        track_changes: z.boolean().optional().default(true),
        transaction_id: z.string().optional(),
        mutation_paths: z.array(z.string().min(1).max(4000)).max(128).optional(),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory, timeout_seconds, success_exit_codes, idempotency_key, track_changes, transaction_id, mutation_paths }) => {
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const policyCwd = cwdOverride ?? getShellStatus().cwd ?? defaultCwd;
      requireCommandAllowed(command, policyCwd);
      const fingerprint = idempotency_key ? requestFingerprint({ command, cwd: policyCwd, timeout_seconds, success_exit_codes, transaction_id, mutation_paths }) : undefined;
      const txPaths = mutation_paths?.length
        ? await Promise.all(mutation_paths.map((item) => validatePath(path.isAbsolute(item) ? item : path.resolve(policyCwd, item))))
        : [];

      const executeOnce = async () => {
        const shouldTrack = track_changes && commandMayMutate(command);
        const beforeTree = shouldTrack ? await captureWorkingTree(policyCwd) : undefined;
        if (transaction_id) {
          if (!txPaths.length) throw new Error("mutation_paths is required when run_command uses transaction_id");
          await getEditTransaction(transaction_id);
          await captureTransactionPaths(transaction_id, txPaths);
        }
        const rawResult = await execInShellSession(command, defaultCwd, (timeout_seconds ?? timeoutSec) * 1000, cwdOverride);
        if (transaction_id) await recordTransactionEdit(transaction_id, "run_command", txPaths);
        const result = await compactCommandResult(rawResult, "command");
        const mutation = beforeTree ? compareWorkingTrees(beforeTree, await captureWorkingTree(result.cwd)) : undefined;
        const acceptedExit = result.exit_code !== null && success_exit_codes.includes(result.exit_code);
        const failure = acceptedExit ? undefined : classifyToolFailure({
          message: result.stderr,
          exitCode: result.exit_code,
          timedOut: result.timed_out,
          command,
        });
        const expectedNoMatch = failure?.category === "expected_no_match";
        const data = { ...result, ...(failure ? { failure } : {}), ...(mutation ? { mutation } : {}), replayed: false };
        if (idempotency_key && fingerprint) await saveIdempotent(idempotency_key, fingerprint, data);
        await audit({
          tool: "run_command",
          action: "command",
          target: result.cwd,
          status: acceptedExit || expectedNoMatch ? "ok" : "error",
          details: { command, exit_code: result.exit_code, success_exit_codes, timed_out: result.timed_out, failure, changed_paths: mutation?.changed_paths, idempotency_key, transaction_id, mutation_paths: txPaths },
        });
        return toolResult("run_command", data, {
          ok: acceptedExit || expectedNoMatch,
          summary: expectedNoMatch ? `no matches in ${result.cwd}` : `exit ${result.exit_code} in ${result.cwd}`,
        });
      };

      const executeWithTransaction = () => transaction_id
        ? withEditTransactionLock(transaction_id, executeOnce)
        : executeOnce();

      const executeOrReplay = async () => {
        if (idempotency_key && fingerprint) {
          const cached = await loadIdempotent<Record<string, unknown>>(idempotency_key, fingerprint);
          if (cached) {
            if (transaction_id) {
              const transaction = await getEditTransaction(transaction_id);
              if (transaction.status === "rolled_back") {
                throw new Error(`Idempotency key ${idempotency_key} belongs to rolled-back transaction ${transaction_id}; use a new key to execute again`);
              }
            }
            await audit({ tool: "run_command", action: "replay", target: policyCwd, status: "ok", details: { idempotency_key } });
            return toolResult("run_command", { ...cached, replayed: true }, { summary: `replayed ${idempotency_key}` });
          }
        }
        return executeWithTransaction();
      };

      return idempotency_key
        ? withIdempotencyKeyLock(idempotency_key, executeOrReplay)
        : executeOrReplay();
    }
  );

  server.registerTool(
    "run_commands_parallel",
    {
      title: "Run Commands in Parallel",
      description: "Run independent short commands concurrently. Use retry_failed with the durable batch_id instead of rerunning successful siblings. For long/recursive jobs use start_process. Each member may define expected success_exit_codes.",
      inputSchema: {
        commands: z.array(z.object({
          command: z.string().max(MAX_COMMAND_CHARS),
          working_directory: z.string().optional(),
          timeout_seconds: z.number().int().positive().max(3600).optional(),
          success_exit_codes: z.array(z.number().int()).min(1).max(16).optional().default([0]),
        })).min(1).max(16).optional(),
        concurrency: z.number().int().min(1).max(8).optional().default(4),
        batch_id: z.string().optional(),
        retry_failed: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ commands, concurrency, batch_id, retry_failed }) => {
      const defaultParallelCwd = getShellStatus().cwd || defaultCwd;
      let record: ParallelBatchRecord;
      let targetIndices: number[];

      if (batch_id) {
        if (commands?.length) throw new Error("Do not provide commands when resuming a parallel batch_id");
        const existing = await loadParallelBatch(batch_id);
        if (!existing) throw new Error(`Unknown parallel batch id: ${batch_id}`);
        record = existing;
        if (!retry_failed) {
          const failedEntries = record.results
            .map((item, index) => ({ item, index }))
            .filter(({ item, index }) =>
              !item ||
              Boolean(item.error) ||
              (!(record.commands[index]?.success_exit_codes || [0]).includes(item.exit_code) &&
                item.failure?.category !== "expected_no_match")
            );
          return toolResult("run_commands_parallel", {
            batch_id: record.id,
            results: record.results,
            count: record.commands.length,
            failed: failedEntries.length,
            partial_success: failedEntries.length > 0 && failedEntries.length < record.commands.length,
            retryable_indices: failedEntries.filter(({ item }) => !item || item.failure?.retryable || item.timed_out).map(({ index }) => index),
            attempts: record.attempts,
          }, { ok: failedEntries.length === 0, summary: `loaded batch ${record.id}` });
        }
        targetIndices = record.results
          .map((item, index) => ({ item, index }))
          .filter(({ item, index }) =>
            !item ||
            Boolean(item.error) ||
            (!(record.commands[index]?.success_exit_codes || [0]).includes(item.exit_code) &&
              item.failure?.category !== "expected_no_match")
          )
          .map(({ index }) => index);
        if (!targetIndices.length) {
          return toolResult("run_commands_parallel", {
            batch_id: record.id,
            results: record.results,
            count: record.commands.length,
            failed: 0,
            partial_success: false,
            retryable_indices: [],
            attempts: record.attempts,
          }, { summary: `batch ${record.id} already succeeded` });
        }
      } else {
        if (!commands?.length) throw new Error("commands is required when batch_id is not provided");
        const now = new Date().toISOString();
        record = {
          version: 1,
          id: newParallelBatchId(),
          created_at: now,
          updated_at: now,
          concurrency,
          commands: commands as ParallelCommandSpec[],
          results: new Array(commands.length).fill(null),
          attempts: 0,
        };
        targetIndices = commands.map((_, index) => index);
      }

      const results = record.results;
      record.concurrency = concurrency;
      record.attempts++;
      await saveParallelBatch(record);
      let nextIndex = 0;

      const worker = async () => {
        while (true) {
          const target = nextIndex++;
          if (target >= targetIndices.length) return;
          const index = targetIndices[target];
          const spec = record.commands[index];
          const started = Date.now();
          try {
            const cwd = spec.working_directory ? await validatePath(spec.working_directory) : defaultParallelCwd;
            requireCommandAllowed(spec.command, cwd);
            const raw = await runOneShotCommand(
              spec.command,
              cwd,
              (spec.timeout_seconds ?? timeoutSec) * 1000
            );
            const result = await compactCommandResult(raw, "parallel");
            const acceptedExit = spec.success_exit_codes?.includes(result.exit_code) ?? result.exit_code === 0;
            const failure = acceptedExit ? undefined : classifyToolFailure({
              message: result.stderr,
              exitCode: result.exit_code,
              timedOut: result.timed_out,
              command: spec.command,
            });
            results[index] = { index, ...result, ...(failure ? { failure } : {}) };
            await saveParallelBatch(record);
            await audit({
              tool: "run_commands_parallel",
              action: "command",
              target: cwd,
              status: acceptedExit || failure?.category === "expected_no_match" ? "ok" : "error",
              details: { batch_id: record.id, index, command: spec.command, exit_code: result.exit_code, success_exit_codes: spec.success_exit_codes, timed_out: result.timed_out, failure },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
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
              error: message,
              failure: classifyToolFailure({ message, command: spec.command }),
            };
            await saveParallelBatch(record);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, targetIndices.length) }, () => worker()));
      record.results = results;
      await saveParallelBatch(record);
      const failedEntries = results
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => {
          if (!item || item.error || item.failure?.category === "expected_no_match") return Boolean(!item || item.error);
          const accepted = record.commands[index]?.success_exit_codes || [0];
          return !accepted.includes(item.exit_code);
        });
      const failed = failedEntries.length;
      return toolResult(
        "run_commands_parallel",
        {
          batch_id: record.id,
          results,
          count: results.length,
          failed,
          partial_success: failed > 0 && failed < results.length,
          retryable_indices: failedEntries.filter(({ item }) => !item || item.failure?.retryable || item.timed_out).map(({ index }) => index),
          attempts: record.attempts,
          concurrency: Math.min(concurrency, targetIndices.length),
        },
        { ok: failed === 0, summary: `${results.length - failed}/${results.length} command(s) succeeded · batch ${record.id}` }
      );
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show this MCP transport's shell cwd and recent commands. ChatGPT transports do not share cwd by default; pass working_directory for project shell work.",
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
      description: "Reset this MCP transport's shell cwd to a directory (default: server workspace).",
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
      description: "Start a named long-running operation in the background. Optionally link it to a persistent agent_task; use process_output/process_status/process_history/stop_process afterwards.",
      inputSchema: {
        command: z.string().max(MAX_COMMAND_CHARS),
        working_directory: z.string().optional(),
        label: z.string().max(160).optional(),
        task_id: z.string().optional(),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory, label, task_id }) => {
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      requireCommandAllowed(command, cwd);
      const session = getCurrentSessionState();
      const projectRoot = session?.workspace_kind === "project" && session.project_root
        ? session.project_root
        : await projectRootForCwd(cwd);
      const duplicate = [...processes.values()].find((item) =>
        processRunning(item) &&
        sameRoot(item.projectRoot, projectRoot) &&
        path.resolve(item.cwd) === path.resolve(cwd) &&
        item.command.trim() === command.trim()
      );
      if (duplicate) {
        return toolResult("start_process", {
          id: duplicate.id,
          label: duplicate.label,
          task_id: duplicate.taskId,
          session_id: duplicate.sessionId,
          project_root: duplicate.projectRoot,
          pid: duplicate.child.pid,
          command: duplicate.command,
          cwd: duplicate.cwd,
          started_at: duplicate.startedAt,
          reused: true,
          liveness: "active",
        }, { summary: `reused running ${duplicate.label || duplicate.id}` });
      }
      if (task_id) {
        const task = await getAgentTask(task_id);
        if (!task) throw new Error(`Unknown agent task id: ${task_id}`);
      }
      const { shell, args } = getShellInvocation(command);

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
        },
      });

      // A missing/broken shell emits an asynchronous `error` event. Without an
      // explicit listener Node treats it as uncaught and can terminate the MCP
      // server. Do not advertise a process id until the child actually spawned.
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        id,
        label: label?.trim() || undefined,
        taskId: task_id,
        sessionId: session?.session_id,
        projectRoot,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: [],
        stderr: [],
        exitCode: null,
        signal: null,
        lastActivityAt: new Date().toISOString(),
      };
      processes.set(id, item);
      child.stdout.on("data", (d: Buffer) => {
        item.lastActivityAt = new Date().toISOString();
        appendLog(item.stdout, d);
      });
      child.stderr.on("data", (d: Buffer) => {
        item.lastActivityAt = new Date().toISOString();
        appendLog(item.stderr, d);
      });
      child.on("error", (error) => {
        item.spawnError = error.message;
        if (item.exitCode === null) item.exitCode = 1;
        appendLog(item.stderr, Buffer.from(`\n[process error] ${error.message}\n`));
      });
      item.startWrite = recordOperationStart({
        id,
        label: item.label,
        task_id: item.taskId,
        session_id: item.sessionId,
        project_root: item.projectRoot,
        command,
        cwd,
        pid: child.pid,
        status: "running",
        started_at: item.startedAt,
        last_progress_at: item.lastActivityAt,
      });
      child.on("close", (code, signal) => {
        item.exitCode = code ?? item.exitCode ?? (item.spawnError ? 1 : null);
        item.signal = signal;
        const status = item.spawnError || (item.exitCode !== null && item.exitCode !== 0)
          ? "failed"
          : item.stopRequested || signal
            ? "stopped"
            : "completed";
        item.historyWrite = (async () => {
          // A very fast process can exit before the durable start record has
          // finished writing. Serialize finish behind start so it can never be
          // lost merely because the child completed during persistence.
          await item.startWrite;
          await recordOperationFinish(item.id, {
            status,
            finished_at: new Date().toISOString(),
            exit_code: item.exitCode,
            signal: item.signal,
            spawn_error: item.spawnError,
            stdout_tail: item.stdout.join(""),
            stderr_tail: item.stderr.join(""),
            last_progress_at: item.lastActivityAt,
          });
        })().catch((error) => {
          item.historyError = error instanceof Error ? error.message : String(error);
        }).finally(() => pruneFinishedProcesses());
      });
      try {
        await item.startWrite;
      } catch (error) {
        item.stopRequested = true;
        processes.delete(id);
        await terminateProcessTree(item, true).catch(() => undefined);
        throw new Error(`Failed to persist background operation state: ${error instanceof Error ? error.message : String(error)}`);
      }
      await audit({ tool: "start_process", action: "start", target: cwd, status: "ok", details: { id, command } });
      return toolResult("start_process", { id, label: item.label, task_id: item.taskId, session_id: item.sessionId, project_root: item.projectRoot, pid: child.pid, command, cwd, started_at: item.startedAt, reused: false }, {
        summary: `started ${item.label || id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show background process status; optionally wait for one process to exit without polling.",
      inputSchema: {
        id: z.string().optional(),
        wait_for: z.enum(["none", "exit"]).optional().default("none"),
        wait_seconds: z.number().int().min(0).max(60).optional().default(30),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, wait_for, wait_seconds }) => {
      let wait: { condition_met: boolean; timed_out: boolean; waited_ms: number } | undefined;
      if (wait_for === "exit") {
        if (!id) throw new Error("id is required when wait_for=exit");
        const item = processes.get(id);
        if (!item) throw new Error(`Unknown process id: ${id}`);
        wait = await waitForProcessCondition(item, { waitFor: "exit", timeoutMs: wait_seconds * 1000 });
      }
      const processes_list = [...processes.values()]
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          label: p.label,
          task_id: p.taskId,
          session_id: p.sessionId,
          project_root: p.projectRoot,
          pid: p.child.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: processRunning(p),
          stdin_writable: p.child.stdin.writable && !p.child.stdin.destroyed,
          exit_code: p.exitCode,
          signal: p.signal,
          spawn_error: p.spawnError ?? null,
          history_error: p.historyError ?? null,
          last_activity_at: p.lastActivityAt,
          liveness: !processRunning(p)
            ? "exited"
            : Date.now() - Date.parse(p.lastActivityAt) > 10 * 60_000
              ? "possibly_stalled"
              : Date.now() - Date.parse(p.lastActivityAt) > 2 * 60_000
                ? "silent"
                : "active",
        }));
      return toolResult("process_status", { processes: processes_list, ...(wait ? { wait } : {}) }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_history",
    {
      title: "Process Operation History",
      description:
        "Read persistent background-operation history across ChatGPT/MCP sessions and server restarts. Stale records that were running before a restart are reported as interrupted.",
      inputSchema: {
        id: z.string().optional(),
        task_id: z.string().optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ id, task_id, limit }) => {
      if (id) {
        const live = processes.get(id);
        if (live?.historyWrite) await live.historyWrite;
        if (live?.historyError) throw new Error(`Operation history persistence failed: ${live.historyError}`);
      } else {
        await Promise.all([...processes.values()].map((item) => item.historyWrite).filter(Boolean));
      }
      const activeIds = new Set(
        [...processes.values()]
          .filter((item) => item.exitCode === null && item.signal === null)
          .map((item) => item.id)
      );
      if (id) {
        const operation = await getOperationRecord(id, activeIds);
        if (!operation) throw new Error(`Unknown operation id: ${id}`);
        return toolResult("process_history", { operation }, { summary: `${operation.label || operation.id} — ${operation.effective_status}` });
      }
      const operations = await listOperationHistory({ limit, task_id, active_ids: activeIds });
      return toolResult("process_history", { operations, count: operations.length }, { summary: `${operations.length} operation(s)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read process logs, wait for exit/text, or retrieve a durable oversized-result handle.",
      inputSchema: {
        id: z.string().optional(),
        result_handle: z.string().optional(),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().positive().max(200000).optional().default(40000),
        wait_for: z.enum(["none", "exit", "text"]).optional().default("none"),
        wait_text: z.string().max(4000).optional(),
        wait_seconds: z.number().int().min(0).max(60).optional().default(30),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, result_handle, tail_chars, offset, limit, wait_for, wait_text, wait_seconds }) => {
      if (result_handle) {
        if (id) throw new Error("Provide either id or result_handle, not both");
        const stored = await readTextResult(result_handle, offset, limit);
        return toolResult("process_output", stored, { summary: `stored output ${result_handle}` });
      }
      if (!id) throw new Error("id or result_handle is required");
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (wait_for === "text" && !wait_text) throw new Error("wait_text is required when wait_for=text");
      let wait: { condition_met: boolean; timed_out: boolean; waited_ms: number } | undefined;
      if (wait_for !== "none") {
        wait = await waitForProcessCondition(item, {
          waitFor: wait_for,
          waitText: wait_text,
          timeoutMs: wait_seconds * 1000,
        });
      }
      const stdoutFull = item.stdout.join("");
      const stderrFull = item.stderr.join("");
      const combined = `STDOUT\n${stdoutFull}\n\nSTDERR\n${stderrFull}`;
      const compact = await compactOrStoreText(combined, { inline_chars: Math.min(tail_chars * 2, 80_000), prefix: "process" });
      const data = {
        id,
        label: item.label,
        task_id: item.taskId,
        pid: item.child.pid,
        command: item.command,
        cwd: item.cwd,
        running: processRunning(item),
        stdin_writable: item.child.stdin.writable && !item.child.stdin.destroyed,
        exit_code: item.exitCode,
        signal: item.signal,
        spawn_error: item.spawnError ?? null,
        history_error: item.historyError ?? null,
        stdout: stdoutFull.slice(-tail_chars),
        stderr: stderrFull.slice(-tail_chars),
        output_chars: combined.length,
        output_handle: compact.output_handle,
        truncated: compact.truncated,
        ...(wait ? { wait } : {}),
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
      requireCommandAllowed(item.command, item.cwd);

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
      item.stopRequested = true;
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
