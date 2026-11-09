import fs from "fs/promises";
import path from "path";
import { getHeapStatistics } from "node:v8";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit, getAuditPath } from "../lib/audit.js";
import { getPersistentAuditMetrics } from "../lib/audit-metrics.js";
import {
  describePermissionProfile,
  getPermissionConfig,
  getPermissionProfile,
  getEffectivePathRoots,
  requireWriteAllowed,
} from "../lib/permissions.js";
import { getDefaultCwd, getFullDiskAccess, getMachineRoots } from "../lib/path-security.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { MCP_QUICKSTART } from "../lib/quickstart.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import { getUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { appendAutoMemory } from "../lib/auto-memory.js";
import { loadPathRulesForFile } from "../lib/path-rules.js";
import { toolResult } from "../lib/tool-result.js";
import { loadProjectSkill, loadProjectSkills } from "../lib/skills-loader.js";
import { getShellStatus, resetShellSession } from "../lib/persistent-shell.js";
import { getProjectAffinity, recordProjectAffinity, resolveProjectReference } from "../lib/project-affinity.js";
import { getRuntimeIdentity } from "../lib/runtime-identity.js";
import { listAgentTasks } from "../lib/agent-task-store.js";
import { listEditTransactions } from "../lib/edit-transaction-store.js";
import { listCodingLoops } from "../lib/coding-loop-store.js";
import { summarizeTaskActivity } from "../lib/task-activity.js";
import { getTextReadCacheStats } from "../lib/text-read-cache.js";
import {
  bindCurrentSessionMachine,
  getCurrentSessionState,
  listSessionRuntimeStates,
} from "../lib/session-context.js";
import { getManagedProcessSnapshot } from "./shell.js";
import { listOperationHistory } from "../lib/operation-store.js";



const contextFileNames = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  ".claude/settings.json",
  ".codex/config.toml",
  ".cursor/rules",
];

const CONTEXT_CACHE_MAX_ENTRIES = 128;
const CONTEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const contextFileCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; retainedBytes: number; content: string }>();
let contextFileCacheBytes = 0;

function sameOptionalRoot(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return left == null && right == null;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function buildRecoverySummary() {
  const session = getCurrentSessionState();
  const processes = getManagedProcessSnapshot();
  const activeIds = new Set(processes.filter((item) => item.running).map((item) => item.id));
  const history = await listOperationHistory({ limit: 30, active_ids: activeIds });
  const running = processes
    .filter((item) => item.running)
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: item.label || null,
      pid: item.pid || null,
      project_root: item.project_root || null,
      cwd: item.cwd,
      liveness: item.liveness,
      last_activity_at: item.last_activity_at,
    }));
  const attention = running.filter((item) => item.liveness !== "active");
  const recentCompleted = history
    .filter((item) => item.effective_status !== "running")
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      label: item.label || null,
      project_root: item.project_root || null,
      status: item.effective_status,
      exit_code: item.exit_code ?? null,
      finished_at: item.finished_at || null,
    }));
  return {
    transport_session_id: session?.session_id || null,
    note: "MCP transport sessions are diagnostic only; durable work is recovered by operation/task/loop id and workspace.",
    running_operations: running,
    silent_or_stalled_operations: attention,
    recent_completed_operations: recentCompleted,
  };
}

function removeContextCacheEntry(key: string): void {
  const existing = contextFileCache.get(key);
  if (!existing) return;
  contextFileCacheBytes = Math.max(0, contextFileCacheBytes - existing.retainedBytes);
  contextFileCache.delete(key);
}

function cacheContextFile(key: string, value: { size: number; mtimeMs: number; ctimeMs: number; retainedBytes: number; content: string }): void {
  removeContextCacheEntry(key);
  if (value.retainedBytes > CONTEXT_CACHE_MAX_BYTES) return;
  contextFileCache.set(key, value);
  contextFileCacheBytes += value.retainedBytes;
  while (contextFileCache.size > CONTEXT_CACHE_MAX_ENTRIES || contextFileCacheBytes > CONTEXT_CACHE_MAX_BYTES) {
    const oldest = contextFileCache.keys().next().value as string | undefined;
    if (!oldest) break;
    removeContextCacheEntry(oldest);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findContextFiles(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    for (const name of contextFileNames) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) found.push(candidate);
    }

    if (depth === maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return [...new Set(found)];
}

async function readContextFileCached(file: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  const stat = await fs.stat(file);
  const cacheKey = `${file}|${maxBytes}`;
  const cached = contextFileCache.get(cacheKey);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) {
    cacheContextFile(cacheKey, cached);
    return { content: cached.content, truncated: stat.size > maxBytes };
  }
  const buf = await fs.readFile(file);
  const content = buf.subarray(0, maxBytes).toString("utf-8");
  cacheContextFile(cacheKey, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    retainedBytes: Math.max(Buffer.byteLength(content, "utf8"), content.length * 2),
    content,
  });
  return { content, truncated: buf.length > maxBytes };
}

async function buildDoctor(workspaceRoot: string) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const checkPath = async (name: string, target: string) => {
    try {
      await fs.access(target);
      checks.push({ name, ok: true, detail: target });
    } catch (error) {
      checks.push({ name, ok: false, detail: `${target}: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  await checkPath("workspace", workspaceRoot);
  await checkPath("audit_parent", path.dirname(getAuditPath()));
  const affinity = await getProjectAffinity(workspaceRoot);
  if (affinity.active_root) await checkPath("active_project", affinity.active_root);
  const identity = getRuntimeIdentity();
  const memory = process.memoryUsage();
  const heapStats = getHeapStatistics();
  const textCache = getTextReadCacheStats();
  const recommendations: string[] = [];
  const staleHoursRaw = Number(process.env.MCP_STALE_STATE_HOURS || 24);
  const staleHours = Number.isFinite(staleHoursRaw) && staleHoursRaw > 0
    ? Math.min(Math.max(Math.trunc(staleHoursRaw), 1), 24 * 30)
    : 24;
  const cutoffMs = Date.now() - staleHours * 60 * 60 * 1000;
  const [tasksResult, transactionsResult, loopsResult, auditMetricsResult] = await Promise.allSettled([
    listAgentTasks(),
    listEditTransactions(100),
    listCodingLoops(100),
    getPersistentAuditMetrics(),
  ]);
  const tasks = tasksResult.status === "fulfilled" ? tasksResult.value : [];
  const transactions = transactionsResult.status === "fulfilled" ? transactionsResult.value : [];
  const loops = loopsResult.status === "fulfilled" ? loopsResult.value : [];
  const workers = getManagedProcessSnapshot();
  const auditMetrics = auditMetricsResult.status === "fulfilled" ? auditMetricsResult.value : null;
  const activeLoops = loops.filter((loop) => loop.status === "active");
  const activeLoopTransactions = new Set(activeLoops.map((loop) => loop.transaction_id));
  const ageHours = (value: string | undefined) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 360_000) / 10) : null;
  };
  const isStale = (value: string | undefined) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed < cutoffMs;
  };
  const staleTasks = tasks
    .filter((task) => ["active", "blocked"].includes(task.status) && isStale(task.updated_at))
    .slice(0, 20)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      age_hours: ageHours(task.updated_at),
      workspace: task.workspace,
      execution: summarizeTaskActivity(task, loops, workers),
    }));
  const staleLoops = activeLoops
    .filter((loop) => isStale(loop.updated_at))
    .slice(0, 20)
    .map((loop) => ({ id: loop.id, goal: loop.goal, phase: loop.phase, age_hours: ageHours(loop.updated_at), workspace: loop.workspace, transaction_id: loop.transaction_id }));
  const staleTransactions = transactions
    .filter((transaction) => transaction.status === "active" && isStale(transaction.updated_at))
    .slice(0, 20)
    .map((transaction) => ({
      id: transaction.id,
      age_hours: ageHours(transaction.updated_at),
      workspace: transaction.workspace,
      files: transaction.snapshots.length,
      edits: transaction.edits.length,
      linked_to_active_loop: activeLoopTransactions.has(transaction.id),
    }));
  const stateErrors = [
    ...(tasksResult.status === "rejected" ? [`agent_tasks: ${String(tasksResult.reason)}`] : []),
    ...(transactionsResult.status === "rejected" ? [`edit_transactions: ${String(transactionsResult.reason)}`] : []),
    ...(loopsResult.status === "rejected" ? [`coding_loops: ${String(loopsResult.reason)}`] : []),
    ...(auditMetricsResult.status === "rejected" ? [`audit_metrics: ${String(auditMetricsResult.reason)}`] : []),
  ];
  if (identity.connector_refresh_recommended) recommendations.push("Server tool schema changed since the previous run; refresh the connector and use a fresh ChatGPT chat after restart.");
  if (!checks.every((check) => check.ok)) recommendations.push("Resolve failed filesystem checks before relying on mutation or recovery features.");
  if (staleTasks.length || staleLoops.length || staleTransactions.length) {
    recommendations.push(`Review stale durable state older than ${staleHours}h. Doctor reports it but never deletes resumable tasks/loops/transactions automatically.`);
  }
  if (stateErrors.length) recommendations.push("Inspect persistent-state read errors before relying on recovery diagnostics.");
  if (heapStats.heap_size_limit > 0 && memory.heapUsed / heapStats.heap_size_limit >= 0.7) {
    recommendations.push("Node heap usage is above 70% of the V8 heap limit; restart after saving durable state and inspect cache/session growth.");
  }
  return {
    healthy: checks.every((check) => check.ok) && stateErrors.length === 0,
    checks,
    recommendations,
    project_affinity: affinity,
    runtime_identity: identity,
    memory: {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
      heap_limit_bytes: heapStats.heap_size_limit,
      heap_used_ratio: heapStats.heap_size_limit > 0 ? Math.round((memory.heapUsed / heapStats.heap_size_limit) * 10_000) / 10_000 : null,
      text_cache: textCache,
      context_cache: {
        entries: contextFileCache.size,
        retained_bytes: contextFileCacheBytes,
        max_entries: CONTEXT_CACHE_MAX_ENTRIES,
        max_total_bytes: CONTEXT_CACHE_MAX_BYTES,
      },
    },
    stale_state: {
      threshold_hours: staleHours,
      agent_tasks: staleTasks,
      coding_loops: staleLoops,
      edit_transactions: staleTransactions,
      state_errors: stateErrors,
    },
    persistent_telemetry: auditMetrics,
  };
}

export function registerContextTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "list_skills",
    {
      title: "List Skills",
      description: "Discover project and global skills. Pass path for a specific project; use load_skill with the same path.",
      inputSchema: { path: z.string().optional().describe("Project root for skill discovery") },
      annotations: toolAnnotations("read"),
    },
    async ({ path: projectPath }) => {
      const root = await validatePath(await resolveProjectReference(projectPath, getShellStatus().cwd || workspaceRoot));
      const skills = await loadProjectSkills(root);
      return toolResult("list_skills", { root, skills, count: skills.length });
    }
  );

  server.registerTool(
    "load_skill",
    {
      title: "Load Skill",
      description: "Load a skill's instructions, or read one .md/.txt reference using reference_path relative to that skill's directory. Computer Use plugin has bundled guidance.",
      inputSchema: {
        name: z.string().min(1).describe("Exact skill name returned by list_skills"),
        path: z.string().optional().describe("Same project root used for list_skills"),
        reference_path: z.string().max(2000).optional().describe("Optional reference file relative to skill directory, e.g. references/api.md"),
        max_bytes: z.number().int().positive().max(500000).optional().default(200000),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ name, path: projectPath, reference_path, max_bytes }) => {
      const root = await validatePath(await resolveProjectReference(projectPath, getShellStatus().cwd || workspaceRoot));
      const loaded = await loadProjectSkill(root, name, max_bytes, reference_path);
      await audit({ tool: "load_skill", action: "read", target: loaded.skill.path, status: "ok" });
      return toolResult("load_skill", loaded);
    }
  );

  server.registerTool(
    "project_context",
    {
      title: "Project Context",
      description:
        "Load one project's context for this MCP transport, or select machine mode for host-wide work. Explicit path/workspace/working_directory arguments remain authoritative because ChatGPT may create a fresh MCP transport on later tool calls.",
      inputSchema: {
        mode: z.enum(["project", "machine"]).optional().default("project"),
        path: z.string().optional().describe("Project directory, defaults to primary workspace"),
        max_depth: z.number().int().min(0).max(5).optional().default(3),
        max_bytes_per_file: z.number().int().positive().max(200000).optional().default(60000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ mode, path: projectPath, max_depth, max_bytes_per_file }) => {
      if (mode === "machine") {
        if (projectPath) throw new Error("path must be omitted when project_context mode=machine");
        bindCurrentSessionMachine();
        resetShellSession(workspaceRoot);
        const session = getCurrentSessionState();
        await audit({ tool: "project_context", action: "machine", target: workspaceRoot, status: "ok" });
        return toolResult("project_context", {
          mode,
          root: null,
          files: [],
          count: 0,
          session,
          cwd: getShellStatus().cwd,
        }, { summary: "session switched to machine context" });
      }
      const fallback = getShellStatus().cwd || workspaceRoot;
      const affinityRoot = await resolveProjectReference(projectPath, fallback);
      const root = await validatePath(affinityRoot);
      await recordProjectAffinity(root).catch(() => undefined);
      resetShellSession(root);
      const files = await findContextFiles(root, max_depth);
      const fileContents: Array<{ path: string; content: string; truncated: boolean }> = [];

      for (const file of files) {
        try {
          const cached = await readContextFileCached(file, max_bytes_per_file);
          fileContents.push({ path: file, content: cached.content, truncated: cached.truncated });
        } catch {}
      }

      await audit({ tool: "project_context", action: "read", target: root, status: "ok", details: { files: files.length } });
      return toolResult("project_context", {
        mode,
        root,
        files: fileContents,
        count: fileContents.length,
        session: getCurrentSessionState(),
        cwd: getShellStatus().cwd,
      });
    }
  );

  server.registerTool(
    "agent_status",
    {
      title: "Agent Status",
      description:
        "Compact runtime/session/project status. Use mode=doctor for self-checks, full for detailed configuration, or help for the full tool workflow.",
      inputSchema: { mode: z.enum(["summary", "doctor", "full", "help"]).optional().default("summary") },

      annotations: toolAnnotations("read"),
    },
    async ({ mode }) => {
      const affinity = await getProjectAffinity(getShellStatus().cwd || workspaceRoot);
      const identity = getRuntimeIdentity();
      const session = getCurrentSessionState() ?? null;
      const recovery = await buildRecoverySummary();
      const doctor = mode === "doctor" ? await buildDoctor(workspaceRoot) : undefined;
      const compact = {
        healthy: doctor ? doctor.healthy : true,
        pid: process.pid,
        node: process.version,
        session,
        shell: getShellStatus(),
        project: {
          active_root: affinity.active_root,
          active_alias: affinity.active_alias,
        },
        tool_profile: process.env.CHATGPT_TOOL_PROFILE || "slim",
        runtime_identity: identity,
        recovery,
        admin_ui: `http://127.0.0.1:${process.env.ADMIN_PORT || "3001"}/ui`,
      };
      if (mode === "summary") return toolResult("agent_status", compact);
      if (mode === "help") {
        return toolResult("agent_status", { ...compact, quickstart: MCP_QUICKSTART });
      }
      if (mode === "doctor") {
        return toolResult("agent_status", { ...compact, doctor });
      }
      const upstreamManager = getUpstreamManager();
      let upstream: Awaited<ReturnType<typeof upstreamManager.listStatuses>> = [];
      try {
        upstream = await upstreamManager.listStatuses();
      } catch {}
      return toolResult("agent_status", {
        ...compact,
        permission_profile: getPermissionProfile(),
        permission_description: describePermissionProfile(),
        permission_config: getPermissionConfig(),
        permission_roots: getEffectivePathRoots(),
        full_machine_access: getFullDiskAccess(),
        default_cwd: getDefaultCwd(),
        machine_roots: getMachineRoots(),
        audit_log: getAuditPath(),
        rewind: getCheckpointConfig(),
        upstream_mcp: {
          config_path: upstreamManager.getConfigPath(),
          servers: upstream,
        },
        project_affinity: affinity,
      });
    }
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Save a note to auto memory for future ChatGPT sessions (like Claude Code MEMORY.md).",
      inputSchema: {
        note: z.string().describe("Short fact to remember: build command, convention, gotcha"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ note }) => {
      requireWriteAllowed();
      const file = await appendAutoMemory(workspaceRoot, note);
      await audit({ tool: "remember", action: "append", target: file, status: "ok" });
      return toolResult("remember", { saved_to: file, note }, { summary: "saved to auto memory" });
    }
  );

  server.registerTool(
    "load_path_rules",
    {
      title: "Load Path Rules",
      description:
        "Load .claude/rules/*.md scoped to a file path (Claude Code path-specific rules). Call after read_text_file when editing unfamiliar areas.",
      inputSchema: {
        path: z.string().describe("File path to match against rule paths: frontmatter"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath }) => {
      const validPath = await validatePath(filePath);
      const rules = await loadPathRulesForFile(workspaceRoot, validPath);
      await audit({ tool: "load_path_rules", action: "read", target: validPath, status: "ok", details: { rules: rules.length } });
      return toolResult("load_path_rules", { path: validPath, rules, count: rules.length });
    }
  );
}
