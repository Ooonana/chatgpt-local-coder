import fs from "fs/promises";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { fileURLToPath } from "url";
import { requireCommandAllowed } from "./permissions.js";
import { getWinShell } from "./persistent-shell.js";
import { terminateChildProcessTree } from "./process-tree.js";
import { atomicWriteText } from "./atomic-file.js";

export type LocalHookEvent =
  | "session_start"
  | "session_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "permission_request"
  | "subagent_start"
  | "subagent_stop";

export interface LocalHook {
  id: string;
  event: LocalHookEvent;
  command: string;
  enabled?: boolean;
  tool?: string[];
  path_glob?: string;
  timeout_ms?: number;
  blocking?: boolean;
}

export interface LocalHooksConfig {
  version: 1;
  enabled: boolean;
  hooks: LocalHook[];
}

export interface LocalHookContext {
  event: LocalHookEvent;
  tool?: string;
  arguments?: unknown;
  path?: string;
  workspace?: string;
  session_id?: string;
  result?: unknown;
  error?: string;
  subagent_id?: string;
  objective?: string;
}

export interface LocalHookRunResult {
  id: string;
  event: LocalHookEvent;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  allow: boolean;
  reason?: string;
  additional_context?: string;
}

const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../profiles/hooks.json"
);
const DEFAULT_CONFIG: LocalHooksConfig = { version: 1, enabled: false, hooks: [] };
const DEFAULT_HOOK_BUDGET_MS = 30_000;
const MAX_HOOK_CAPTURE_CHARS = 100_000;

function configPath(): string {
  return path.resolve(process.env.LOCAL_HOOKS_CONFIG || DEFAULT_CONFIG_PATH);
}

function normalizeHook(raw: Partial<LocalHook>): LocalHook | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
  if (typeof raw.command !== "string" || !raw.command.trim()) return undefined;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`Hook '${raw.id}' enabled must be a boolean`);
  }
  if (raw.blocking !== undefined && typeof raw.blocking !== "boolean") {
    throw new Error(`Hook '${raw.id}' blocking must be a boolean`);
  }
  if (raw.tool !== undefined && (!Array.isArray(raw.tool) || raw.tool.some((item) => typeof item !== "string"))) {
    throw new Error(`Hook '${raw.id}' tool must be an array of strings`);
  }
  if (raw.path_glob !== undefined && typeof raw.path_glob !== "string") {
    throw new Error(`Hook '${raw.id}' path_glob must be a string`);
  }
  if (raw.timeout_ms !== undefined && (!Number.isFinite(Number(raw.timeout_ms)) || Number(raw.timeout_ms) <= 0)) {
    throw new Error(`Hook '${raw.id}' timeout_ms must be a positive number`);
  }
  const validEvents: LocalHookEvent[] = [
    "session_start",
    "session_end",
    "pre_tool_use",
    "post_tool_use",
    "permission_request",
    "subagent_start",
    "subagent_stop",
  ];
  if (!validEvents.includes(raw.event as LocalHookEvent)) return undefined;
  return {
    id: raw.id.trim(),
    event: raw.event as LocalHookEvent,
    command: raw.command,
    enabled: raw.enabled !== false,
    tool: Array.isArray(raw.tool) ? raw.tool.map((item) => item.trim()).filter(Boolean) : undefined,
    path_glob: typeof raw.path_glob === "string" && raw.path_glob.trim() ? raw.path_glob.trim() : undefined,
    timeout_ms: Math.min(Math.max(Number(raw.timeout_ms) || 15000, 250), 120000),
    blocking: raw.blocking === true,
  };
}

function normalizeConfig(raw: Partial<LocalHooksConfig> | undefined): LocalHooksConfig {
  if (raw?.version !== undefined && raw.version !== 1) {
    throw new Error(`Unsupported hooks config version: ${String(raw.version)}`);
  }
  if (raw?.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("hooks.enabled must be a boolean");
  }
  if (raw?.hooks !== undefined && !Array.isArray(raw.hooks)) {
    throw new Error("hooks.hooks must be an array");
  }
  const hooks: LocalHook[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(raw?.hooks) ? raw.hooks : []) {
    const hook = normalizeHook(item);
    if (!hook) throw new Error("Invalid local hook entry: id, event, and command are required and event must be supported");
    if (ids.has(hook.id)) throw new Error(`Duplicate local hook id: ${hook.id}`);
    ids.add(hook.id);
    hooks.push(hook);
  }
  return { version: 1, enabled: raw?.enabled === true, hooks };
}

export async function getLocalHooksConfig(): Promise<LocalHooksConfig> {
  try {
    return normalizeConfig(JSON.parse(await fs.readFile(configPath(), "utf-8")) as Partial<LocalHooksConfig>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG, hooks: [] };
    throw new Error(
      `Failed to load local hooks config ${configPath()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function saveLocalHooksConfig(raw: Partial<LocalHooksConfig>): Promise<LocalHooksConfig> {
  const next = normalizeConfig(raw);
  await atomicWriteText(configPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function getLocalHooksConfigPath(): string {
  return configPath();
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesHook(hook: LocalHook, context: LocalHookContext): boolean {
  if (hook.enabled === false || hook.event !== context.event) return false;
  if (hook.tool?.length && (!context.tool || !hook.tool.includes(context.tool))) return false;
  if (hook.path_glob) {
    if (!context.path) return false;
    const target = context.path.replace(/\\/g, "/");
    const base = path.basename(context.path);
    const regex = globRegex(hook.path_glob);
    if (!regex.test(target) && !regex.test(base)) return false;
  }
  return true;
}

function parseHookOutput(stdout: string): Pick<LocalHookRunResult, "allow" | "reason" | "additional_context"> {
  try {
    const parsed = JSON.parse(stdout) as { allow?: unknown; reason?: unknown; additional_context?: unknown };
    return {
      allow: parsed.allow !== false,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      additional_context: typeof parsed.additional_context === "string" ? parsed.additional_context : undefined,
    };
  } catch {
    return { allow: true, additional_context: stdout.trim() || undefined };
  }
}

function hookBudgetMs(): number {
  const raw = Number(process.env.LOCAL_HOOK_BUDGET_MS || DEFAULT_HOOK_BUDGET_MS);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : DEFAULT_HOOK_BUDGET_MS, 1000), 120_000);
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length > MAX_HOOK_CAPTURE_CHARS ? next.slice(-MAX_HOOK_CAPTURE_CHARS) : next;
}

async function killHookProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  await terminateChildProcessTree(child, true).catch(() => {
    try { child.kill("SIGKILL"); } catch {}
  });
}

async function executeHook(
  hook: LocalHook,
  context: LocalHookContext,
  timeoutOverrideMs?: number
): Promise<LocalHookRunResult> {
  const cwd = context.workspace || (context.path ? path.dirname(context.path) : process.cwd());
  try {
    requireCommandAllowed(hook.command, cwd);
  } catch (error) {
    return {
      id: hook.id,
      event: hook.event,
      exit_code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timed_out: false,
      allow: !hook.blocking,
      reason: hook.blocking ? "Blocking hook could not run under the active permission profile" : undefined,
    };
  }

  const winShell = process.platform === "win32" ? getWinShell() : undefined;
  const shell = winShell?.shell || process.env.SHELL || "bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", hook.command]
    : ["-lc", hook.command];

  return await new Promise<LocalHookRunResult>((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        LOCAL_CODER_HOOK_EVENT: context.event,
        LOCAL_CODER_HOOK_ID: hook.id,
        LOCAL_CODER_TOOL: context.tool || "",
        LOCAL_CODER_PATH: context.path || "",
        LOCAL_CODER_SESSION_ID: context.session_id || "",
        LOCAL_CODER_SUBAGENT_ID: context.subagent_id || "",
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timeoutMs = Math.min(hook.timeout_ms ?? 15000, timeoutOverrideMs ?? Number.POSITIVE_INFINITY);
    const timer = setTimeout(() => {
      timedOut = true;
      void killHookProcessTree(child);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (data: Buffer) => (stdout = appendBounded(stdout, data)));
    child.stderr.on("data", (data: Buffer) => (stderr = appendBounded(stderr, data)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        id: hook.id,
        event: hook.event,
        exit_code: null,
        stdout,
        stderr: error.message,
        timed_out: false,
        allow: !hook.blocking,
        reason: hook.blocking ? error.message : undefined,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseHookOutput(stdout.trim());
      const commandOk = !timedOut && code === 0;
      const allow = hook.blocking ? commandOk && parsed.allow : true;
      resolve({
        id: hook.id,
        event: hook.event,
        exit_code: code,
        stdout: stdout.trim().slice(0, 20000),
        stderr: stderr.trim().slice(0, 20000),
        timed_out: timedOut,
        allow,
        reason: allow ? parsed.reason : parsed.reason || (timedOut ? "Hook timed out" : `Hook exited with code ${code}`),
        additional_context: parsed.additional_context,
      });
    });
    child.stdin.end(JSON.stringify(context));
  });
}

export async function runLocalHooks(
  event: LocalHookEvent,
  context: Omit<LocalHookContext, "event">
): Promise<{ allow: boolean; reason?: string; results: LocalHookRunResult[]; additional_context: string }> {
  const config = await getLocalHooksConfig();
  if (!config.enabled) return { allow: true, results: [], additional_context: "" };
  const fullContext: LocalHookContext = { event, ...context };
  const hooks = config.hooks.filter((hook) => matchesHook(hook, fullContext));
  const results: LocalHookRunResult[] = [];
  const deadline = Date.now() + hookBudgetMs();
  for (const hook of hooks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const blocked = hook.blocking === true;
      const exhausted: LocalHookRunResult = {
        id: hook.id,
        event,
        exit_code: null,
        stdout: "",
        stderr: "Hook event budget exhausted before this hook could run",
        timed_out: true,
        allow: !blocked,
        reason: blocked ? "Blocking hook could not run because the hook event budget was exhausted" : undefined,
      };
      results.push(exhausted);
      if (blocked) {
        return { allow: false, reason: exhausted.reason, results, additional_context: "" };
      }
      continue;
    }
    const result = await executeHook(hook, fullContext, remaining);
    results.push(result);
    if (!result.allow) {
      return {
        allow: false,
        reason: result.reason || `Blocked by hook ${hook.id}`,
        results,
        additional_context: results.map((item) => item.additional_context).filter(Boolean).join("\n\n"),
      };
    }
  }
  return {
    allow: true,
    results,
    additional_context: results.map((item) => item.additional_context).filter(Boolean).join("\n\n"),
  };
}
