import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import {
  requireCommandAllowed,
  requireUnsafeRuntimeAllowed,
  requireWriteAllowed,
} from "./permissions.js";
import { runLocalHooks } from "./local-hooks.js";
import { validatePath } from "./path-security.js";
import { resolveSafeSpawnSpec } from "./safe-spawn.js";

export type SubagentIsolation = "none" | "worktree";

export interface SubagentConfig {
  version: 1;
  enabled: boolean;
  executable: string;
  args: string[];
  prompt_via_stdin: boolean;
  timeout_ms: number;
  max_concurrency: number;
  isolation: SubagentIsolation;
  env?: Record<string, string>;
}

export interface SubagentRecord {
  id: string;
  label?: string;
  objective: string;
  requested_workspace: string;
  workspace: string;
  isolation: SubagentIsolation;
  worktree_path?: string;
  started_at: string;
  finished_at?: string;
  running: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  pid?: number;
  executable: string;
  args: string[];
}

interface ManagedSubagent extends SubagentRecord {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  resolveDone: () => void;
  timer?: NodeJS.Timeout;
}

const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../profiles/subagents.json"
);
const DEFAULT_CONFIG: SubagentConfig = {
  version: 1,
  enabled: false,
  executable: "",
  args: [],
  prompt_via_stdin: true,
  timeout_ms: 30 * 60 * 1000,
  max_concurrency: 4,
  isolation: "none",
};
const MAX_LOG_CHARS = 1_000_000;
const agents = new Map<string, ManagedSubagent>();

function parseEnvBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true/false`);
}

function configPath(): string {
  return path.resolve(process.env.SUBAGENT_CONFIG || DEFAULT_CONFIG_PATH);
}

function normalizeConfig(raw: Partial<SubagentConfig> | undefined): SubagentConfig {
  if (raw?.version !== undefined && raw.version !== 1) throw new Error(`Unsupported subagent config version: ${String(raw.version)}`);
  if (raw?.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (raw?.executable !== undefined && typeof raw.executable !== "string") throw new Error("executable must be a string");
  if (raw?.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== "string"))) {
    throw new Error("args must be an array of strings");
  }
  if (raw?.prompt_via_stdin !== undefined && typeof raw.prompt_via_stdin !== "boolean") {
    throw new Error("prompt_via_stdin must be a boolean");
  }
  if (raw?.timeout_ms !== undefined && (!Number.isFinite(Number(raw.timeout_ms)) || Number(raw.timeout_ms) <= 0)) {
    throw new Error("timeout_ms must be a positive number");
  }
  if (raw?.max_concurrency !== undefined && (!Number.isInteger(Number(raw.max_concurrency)) || Number(raw.max_concurrency) <= 0)) {
    throw new Error("max_concurrency must be a positive integer");
  }
  if (raw?.isolation !== undefined && raw.isolation !== "none" && raw.isolation !== "worktree") {
    throw new Error("isolation must be 'none' or 'worktree'");
  }
  if (raw?.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env) || Object.values(raw.env).some((value) => typeof value !== "string")) {
      throw new Error("env must be an object whose values are strings");
    }
  }
  return {
    version: 1,
    enabled: raw?.enabled === true,
    executable: typeof raw?.executable === "string" ? raw.executable.trim() : "",
    args: Array.isArray(raw?.args) ? [...raw.args] : [],
    prompt_via_stdin: raw?.prompt_via_stdin !== false,
    timeout_ms: Math.min(Math.max(Number(raw?.timeout_ms) || DEFAULT_CONFIG.timeout_ms, 1000), 24 * 60 * 60 * 1000),
    max_concurrency: Math.min(Math.max(Number(raw?.max_concurrency) || DEFAULT_CONFIG.max_concurrency, 1), 16),
    isolation: raw?.isolation === "worktree" ? "worktree" : "none",
    env: raw?.env ? { ...raw.env } : undefined,
  };
}

export async function getSubagentConfig(): Promise<SubagentConfig> {
  try {
    return normalizeConfig(JSON.parse(await fs.readFile(configPath(), "utf-8")) as Partial<SubagentConfig>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Failed to load subagent config ${configPath()}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const envExecutable = process.env.SUBAGENT_EXECUTABLE?.trim();
    if (envExecutable) {
      let args: string[] = [];
      try {
        args = JSON.parse(process.env.SUBAGENT_ARGS_JSON || "[]") as string[];
      } catch (error) {
        throw new Error(`SUBAGENT_ARGS_JSON is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const isolationRaw = process.env.SUBAGENT_ISOLATION;
      return normalizeConfig({
        enabled: parseEnvBoolean("SUBAGENT_ENABLED", true),
        executable: envExecutable,
        args,
        prompt_via_stdin: parseEnvBoolean("SUBAGENT_PROMPT_VIA_STDIN", true),
        timeout_ms: process.env.SUBAGENT_TIMEOUT_MS === undefined
          ? DEFAULT_CONFIG.timeout_ms
          : Number(process.env.SUBAGENT_TIMEOUT_MS),
        max_concurrency: process.env.SUBAGENT_MAX_CONCURRENCY === undefined
          ? DEFAULT_CONFIG.max_concurrency
          : Number(process.env.SUBAGENT_MAX_CONCURRENCY),
        isolation: isolationRaw === undefined ? "none" : isolationRaw as SubagentIsolation,
      });
    }
    return { ...DEFAULT_CONFIG, args: [] };
  }
}

export async function saveSubagentConfig(raw: Partial<SubagentConfig>): Promise<SubagentConfig> {
  const next = normalizeConfig(raw);
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

export function getSubagentConfigPath(): string {
  return configPath();
}

function expandArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) => arg.replace(/\{(prompt|workspace|id|label)\}/g, (_match, key) => values[key] ?? ""));
}

async function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function createWorktree(workspace: string, id: string): Promise<string> {
  requireCommandAllowed("git rev-parse --show-toplevel", workspace);
  const check = await runGit(["rev-parse", "--show-toplevel"], workspace);
  if (check.code !== 0 || !check.stdout) {
    throw new Error("Subagent worktree isolation requires workspace to be inside a Git repository");
  }
  const repoRoot = check.stdout.split(/\r?\n/)[0];
  const dir = await validatePath(
    path.join(os.tmpdir(), "chatgpt-local-coder-subagents", `${path.basename(repoRoot)}-${id}`)
  );
  requireWriteAllowed(dir);
  requireCommandAllowed(`git worktree add --detach ${JSON.stringify(dir)} HEAD`, repoRoot);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const add = await runGit(["worktree", "add", "--detach", dir, "HEAD"], repoRoot);
  if (add.code !== 0) throw new Error(add.stderr || add.stdout || "git worktree add failed");
  return dir;
}

async function removeWorktree(record: SubagentRecord): Promise<boolean> {
  if (!record.worktree_path) return false;
  try {
    requireWriteAllowed(record.worktree_path);
    requireCommandAllowed("git rev-parse --show-toplevel", record.requested_workspace);
    const check = await runGit(["rev-parse", "--show-toplevel"], record.requested_workspace);
    if (check.code === 0 && check.stdout) {
      const repoRoot = check.stdout.split(/\r?\n/)[0];
      requireCommandAllowed(`git worktree remove --force ${JSON.stringify(record.worktree_path)}`, repoRoot);
      const removed = await runGit(["worktree", "remove", "--force", record.worktree_path], repoRoot);
      return removed.code === 0;
    }
  } catch {}
  return false;
}

function publicRecord(item: ManagedSubagent): SubagentRecord {
  const { child: _child, done: _done, resolveDone: _resolveDone, timer: _timer, ...record } = item;
  return { ...record };
}

function appendLog(item: ManagedSubagent, key: "stdout" | "stderr", chunk: Buffer): void {
  item[key] += chunk.toString();
  if (item[key].length > MAX_LOG_CHARS) item[key] = item[key].slice(-MAX_LOG_CHARS);
}

async function terminate(item: ManagedSubagent): Promise<void> {
  if (!item.running) return;
  if (process.platform === "win32" && item.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(item.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }

  if (!item.pid) {
    item.child.kill("SIGTERM");
    return;
  }

  try {
    process.kill(-item.pid, "SIGTERM");
  } catch {
    item.child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!item.running) return;
  try {
    process.kill(-item.pid, "SIGKILL");
  } catch {
    item.child.kill("SIGKILL");
  }
}

export async function spawnSubagent(options: {
  objective: string;
  workspace: string;
  label?: string;
  timeout_ms?: number;
  isolation?: SubagentIsolation;
}): Promise<SubagentRecord> {
  const config = await getSubagentConfig();
  if (!config.enabled || !config.executable) {
    throw new Error(
      `Real subagents require a configured model-capable runner. Configure ${getSubagentConfigPath()} (enabled=true, executable, args). The ChatGPT app subscription is not exposed to MCP servers as a model-spawn API.`
    );
  }
  const runningCount = [...agents.values()].filter((item) => item.running).length;
  if (runningCount >= config.max_concurrency) {
    throw new Error(
      `Subagent concurrency limit reached (${runningCount}/${config.max_concurrency}). Wait for or stop an existing subagent first.`
    );
  }
  if (!config.prompt_via_stdin && !config.args.some((arg) => arg.includes("{prompt}"))) {
    throw new Error(
      "Invalid subagent config: prompt_via_stdin=false requires at least one args entry containing {prompt}"
    );
  }
  requireUnsafeRuntimeAllowed("subagent runner");
  const id = randomUUID().slice(0, 12);
  const isolation = options.isolation ?? config.isolation;
  const requestedWorkspace = await validatePath(options.workspace);
  requireCommandAllowed([config.executable, ...config.args].join(" "), requestedWorkspace);
  const workspace = isolation === "worktree" ? await createWorktree(requestedWorkspace, id) : requestedWorkspace;
  const values = {
    prompt: options.objective,
    workspace,
    id,
    label: options.label || "",
  };
  const args = expandArgs(config.args, values);
  try {
    requireCommandAllowed([config.executable, ...args].join(" "), workspace);

    const hook = await runLocalHooks("subagent_start", {
      subagent_id: id,
      objective: options.objective,
      workspace,
    });
    if (!hook.allow) throw new Error(hook.reason || "Subagent start blocked by hook");
  } catch (error) {
    if (isolation === "worktree") {
      await removeWorktree({ worktree_path: workspace, requested_workspace: requestedWorkspace } as SubagentRecord);
    }
    throw error;
  }

  const childEnv = { ...process.env, ...config.env, LOCAL_CODER_SUBAGENT_ID: id };
  const spawnSpec = await resolveSafeSpawnSpec(config.executable, args, childEnv);
  const child = spawn(spawnSpec.file, spawnSpec.args, {
    cwd: workspace,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: childEnv,
  });
  try {
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
  } catch (error) {
    if (isolation === "worktree") {
      await removeWorktree({
        worktree_path: workspace,
        requested_workspace: requestedWorkspace,
      } as SubagentRecord);
    }
    throw error;
  }
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const record: ManagedSubagent = {
    id,
    label: options.label,
    objective: options.objective,
    requested_workspace: requestedWorkspace,
    workspace,
    isolation,
    worktree_path: isolation === "worktree" ? workspace : undefined,
    started_at: new Date().toISOString(),
    running: true,
    exit_code: null,
    signal: null,
    timed_out: false,
    stdout: "",
    stderr: "",
    pid: child.pid,
    executable: config.executable,
    args,
    child,
    done,
    resolveDone,
  };
  agents.set(id, record);
  child.stdout.on("data", (data: Buffer) => appendLog(record, "stdout", data));
  child.stderr.on("data", (data: Buffer) => appendLog(record, "stderr", data));
  let finalized = false;
  const finalize = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
    if (finalized) return;
    finalized = true;
    if (record.timer) clearTimeout(record.timer);
    if (error) appendLog(record, "stderr", Buffer.from(`\n${error.message}\n`));
    record.running = false;
    record.exit_code = code ?? (error ? 1 : null);
    record.signal = signal;
    record.finished_at = new Date().toISOString();
    record.resolveDone();
    if (error && record.worktree_path) void removeWorktree(record);
    void runLocalHooks("subagent_stop", {
      subagent_id: id,
      objective: record.objective,
      workspace: record.workspace,
      result: {
        exit_code: record.exit_code,
        signal,
        timed_out: record.timed_out,
        error: error?.message,
      },
    }).catch(() => undefined);
  };
  const timeoutMs = Math.min(Math.max(options.timeout_ms ?? config.timeout_ms, 1000), 24 * 60 * 60 * 1000);
  record.timer = setTimeout(() => {
    record.timed_out = true;
    void terminate(record);
  }, timeoutMs);
  record.timer.unref?.();
  child.on("error", (error) => finalize(1, null, error));
  child.on("close", (code, signal) => {
    finalize(code, signal);
  });
  if (config.prompt_via_stdin) child.stdin.end(options.objective);
  else child.stdin.end();
  return publicRecord(record);
}

export function listSubagents(): SubagentRecord[] {
  return [...agents.values()].map(publicRecord).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getSubagent(id: string): SubagentRecord | undefined {
  const item = agents.get(id);
  return item ? publicRecord(item) : undefined;
}

export async function waitForSubagent(id: string, timeoutMs = 30000): Promise<SubagentRecord> {
  const item = agents.get(id);
  if (!item) throw new Error(`Unknown subagent id: ${id}`);
  if (item.running) {
    await Promise.race([
      item.done,
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(Math.max(timeoutMs, 0), 30_000))),
    ]);
  }
  return publicRecord(item);
}

export async function stopSubagent(id: string): Promise<SubagentRecord> {
  const item = agents.get(id);
  if (!item) throw new Error(`Unknown subagent id: ${id}`);
  await terminate(item);
  if (item.running) {
    await Promise.race([
      item.done,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  return publicRecord(item);
}

export async function clearSubagents(removeWorktrees = false): Promise<{ cleared: number; removed_worktrees: number }> {
  let cleared = 0;
  let removedWorktrees = 0;
  for (const [id, item] of [...agents.entries()]) {
    if (item.running) continue;
    agents.delete(id);
    cleared++;
    if (removeWorktrees && item.worktree_path) {
      if (await removeWorktree(item)) removedWorktrees++;
    }
  }
  return { cleared, removed_worktrees: removedWorktrees };
}

export async function shutdownSubagents(): Promise<number> {
  let stopped = 0;
  for (const item of agents.values()) {
    if (!item.running) continue;
    await terminate(item);
    if (item.running) {
      await Promise.race([
        item.done,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    stopped++;
  }
  return stopped;
}
