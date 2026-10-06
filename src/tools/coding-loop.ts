import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireCommandAllowed, requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { inspectProject, type ProjectInspection } from "../lib/project-inspection.js";
import { assertRepositoryPathInsideWorkspace, runRepositoryIntelligence } from "../lib/repository-intelligence.js";
import type { LspServerId } from "../lib/lsp-client.js";
import {
  acceptEditTransaction,
  abandonEditTransaction,
  beginEditTransaction,
  getEditTransaction,
  recordTransactionVerification,
  rollbackEditTransaction,
  withEditTransactionLock,
} from "../lib/edit-transaction-store.js";
import {
  compactVerificationOutput,
  discoverVerificationRecipe,
  type VerificationCommand,
} from "../lib/verification.js";
import { runOneShotCommand } from "./shell.js";
import { createAgentTask, getAgentTask, updateAgentTask } from "../lib/agent-task-store.js";
import { recordProjectAffinity, resolveProjectReference } from "../lib/project-affinity.js";
import {
  hasVerificationCache,
  saveVerificationCache,
  selectIncrementalVerification,
  verificationFingerprint,
} from "../lib/verification-cache.js";
import {
  createCodingLoop,
  getCodingLoop,
  getCodingLoopConfig,
  listCodingLoops,
  newCodingLoopId,
  saveCodingLoop,
  withCodingLoopLock,
  type CodingLoopAttempt,
  type CodingLoopContext,
  type CodingLoopFailure,
  type CodingLoopRecord,
} from "../lib/coding-loop-store.js";
import {
  assertCurrentSessionMutationPath,
  getCurrentSessionState,
} from "../lib/session-context.js";

const actionSchema = z.enum(["begin", "resume", "refresh", "verify", "finish", "rollback", "abandon", "archive", "cleanup"]);
const presetSchema = z.enum(["quick", "full", "custom"]);
const intelActionSchema = z.enum(["symbol_search", "references", "impact"]);
const serverSchema = z.enum(["auto", "typescript", "pyright", "clangd", "rust-analyzer", "gopls"]);
const verificationCommandSchema = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(100_000),
  timeout_seconds: z.number().int().min(5).max(3600).optional().default(180),
});

interface VerificationResult {
  label: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  excerpt: string;
  output_chars: number;
  truncated: boolean;
  cached?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function contextFingerprint(project: ProjectInspection): string {
  return createHash("sha256")
    .update(JSON.stringify({
      root: project.root,
      git: project.git,
      package: project.package,
      languages: project.languages,
      important_files: project.important_files,
      scanned_files: project.scanned_files,
      scan_truncated: project.scan_truncated,
    }))
    .digest("hex")
    .slice(0, 20);
}

function compactProject(project: ProjectInspection): CodingLoopContext["project"] {
  return {
    name: project.name,
    root: project.root,
    git: {
      is_repo: project.git.is_repo,
      branch: project.git.branch,
      head: project.git.head,
      changed_files: project.git.changed_files,
      status: project.git.status,
    },
    ...(project.package ? { package: project.package } : {}),
    languages: project.languages.slice(0, 12),
    important_files: project.important_files.slice(0, 30),
    scanned_files: project.scanned_files,
    scan_truncated: project.scan_truncated,
  };
}

async function buildContext(
  workspace: string,
  defaultCwd: string,
  intel?: {
    action?: "symbol_search" | "references" | "impact";
    query?: string;
    path?: string;
    line?: number;
    column?: number;
    server?: LspServerId | "auto";
    maxResults?: number;
  }
): Promise<{ context: CodingLoopContext; intel_result?: unknown }> {
  const project = await inspectProject(workspace, 4);
  let intelResult: Awaited<ReturnType<typeof runRepositoryIntelligence>> | undefined;
  const hasPosition = Boolean(intel?.path && intel.line && intel.column);
  if (intel && (intel.query?.trim() || hasPosition)) {
    intelResult = await runRepositoryIntelligence({
      action: intel.action ?? "impact",
      workspace,
      defaultCwd,
      query: intel.query,
      path: intel.path,
      line: intel.line,
      column: intel.column,
      server: intel.server ?? "auto",
      maxResults: Math.min(Math.max(intel.maxResults ?? 80, 1), 200),
    });
  }
  const context: CodingLoopContext = {
    refreshed_at: nowIso(),
    fingerprint: contextFingerprint(project),
    project: compactProject(project),
    ...(intelResult ? {
      intel: {
        action: intelResult.action,
        mode: intelResult.mode,
        query: intelResult.query,
        result_count: intelResult.matches?.length ?? intelResult.references?.length ?? 0,
        affected_files: (intelResult.affected_files || []).slice(0, 50),
        fallback_reason: intelResult.fallback_reason,
      },
    } : {}),
  };
  return { context, ...(intelResult ? { intel_result: intelResult } : {}) };
}

function classifyFailure(result: VerificationResult): CodingLoopFailure["category"] {
  const haystack = `${result.label}\n${result.command}\n${result.excerpt}`.toLowerCase();
  if (result.timed_out) return "timeout";
  if (/typecheck|tsc\b|type error|pyright|mypy/.test(haystack)) return "typecheck";
  if (/\btest\b|jest|vitest|pytest|assert|spec\b/.test(haystack)) return "test";
  if (/lint|eslint|ruff|flake8|clippy/.test(haystack)) return "lint";
  if (/build|compile|compiler|webpack|vite|cargo check/.test(haystack)) return "build";
  if (/exception|traceback|runtime|uncaught|fatal/.test(haystack)) return "runtime";
  return "unknown";
}

function failureEvidence(excerpt: string): string[] {
  const lines = excerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) => /error|fail|fatal|exception|traceback|assert|warning|expected|received|cannot|undefined|not found/i.test(line));
  return (important.length ? important : lines).slice(0, 8).map((line) => line.slice(0, 800));
}

function diagnoseFailures(results: VerificationResult[]): CodingLoopFailure[] {
  return results
    .filter((result) => result.exit_code !== 0)
    .slice(0, 12)
    .map((result) => ({
      label: result.label,
      command: result.command,
      category: classifyFailure(result),
      exit_code: result.exit_code,
      evidence: failureEvidence(result.excerpt),
    }));
}

async function runVerification(record: CodingLoopRecord, affectedFiles: string[]): Promise<{
  source: string;
  results: VerificationResult[];
  passed: number;
  failed: number;
  duration_ms: number;
  incremental: boolean;
  incremental_reason: string | null;
  cached_checks: number;
}> {
  const configured = record.verification;
  const recipe = configured.preset === "custom"
    ? { source: "custom", commands: configured.commands || [] }
    : await discoverVerificationRecipe(record.workspace, configured.preset);
  const selected = selectIncrementalVerification(recipe.commands, affectedFiles, configured.preset);
  if (!selected.commands.length) throw new Error("No verification checks discovered for coding loop");

  const results: VerificationResult[] = [];
  for (const check of selected.commands as VerificationCommand[]) {
    requireCommandAllowed(check.command, record.workspace);
    const fingerprint = affectedFiles.length
      ? await verificationFingerprint(record.workspace, check.command, affectedFiles)
      : null;
    if (fingerprint && await hasVerificationCache(record.workspace, check.command, fingerprint)) {
      results.push({
        label: check.label,
        command: check.command,
        exit_code: 0,
        duration_ms: 0,
        timed_out: false,
        excerpt: "cached successful verification for unchanged affected-file fingerprint",
        output_chars: 0,
        truncated: false,
        cached: true,
      });
      continue;
    }
    const result = await runOneShotCommand(check.command, record.workspace, check.timeout_seconds * 1000);
    const compact = compactVerificationOutput(result.stdout, result.stderr);
    results.push({
      label: check.label,
      command: check.command,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      ...compact,
      cached: false,
    });
    if (result.exit_code === 0 && fingerprint) await saveVerificationCache(record.workspace, check.command, fingerprint).catch(() => undefined);
    if (configured.stop_on_failure && result.exit_code !== 0) break;
  }
  const failed = results.filter((item) => item.exit_code !== 0).length;
  return {
    source: recipe.source,
    results,
    passed: results.length - failed,
    failed,
    duration_ms: results.reduce((sum, item) => sum + item.duration_ms, 0),
    incremental: selected.incremental,
    incremental_reason: selected.reason,
    cached_checks: results.filter((item) => item.cached).length,
  };
}

function quoteForDisplay(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

async function killGitTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      child.kill("SIGKILL");
      return;
    }
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.once("error", () => {
      child.kill("SIGKILL");
      resolve();
    });
    killer.once("close", () => resolve());
  });
}

const WORKTREE_GIT_TIMEOUT_MS = 300_000;

async function gitExec(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = `git ${args.map(quoteForDisplay).join(" ")}`;
  requireCommandAllowed(command, cwd);
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GIT_PAGER: "cat" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = (value: string, chunk: Buffer) => (value + chunk.toString()).slice(-120_000);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void killGitTree(child).finally(() => reject(new Error(`Git command timed out after ${timeoutMs}ms: ${command}`)));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr, chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function createIsolatedWorktree(options: {
  loopId: string;
  sourceWorkspace: string;
  requestedPath?: string;
  baseRef: string;
  allowDirtyBase: boolean;
}): Promise<{ workspace: string; branch: string }> {
  const inspection = await inspectProject(options.sourceWorkspace, 1);
  if (!inspection.git.is_repo) throw new Error("Worktree isolation requires a Git repository");
  if ((inspection.git.changed_files || 0) > 0 && !options.allowDirtyBase) {
    throw new Error("Worktree isolation refused because the source workspace is dirty. Commit/stash first or set allow_dirty_base=true knowing the worktree starts from the selected Git ref, not uncommitted source changes.");
  }

  const short = options.loopId.replace(/^loop_/, "").slice(0, 10);
  const branch = `local-coder/${short}`;
  const defaultRoot = process.env.MCP_CODING_LOOP_WORKTREE_ROOT
    ? path.resolve(process.env.MCP_CODING_LOOP_WORKTREE_ROOT)
    : path.join(os.tmpdir(), "chatgpt-local-coder-worktrees");
  const target = await validatePath(options.requestedPath || path.join(defaultRoot, `${path.basename(options.sourceWorkspace)}-${short}`));
  try {
    await fs.access(target);
    throw new Error(`Worktree path already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const created = await gitExec(["worktree", "add", "-b", branch, target, options.baseRef], options.sourceWorkspace, WORKTREE_GIT_TIMEOUT_MS);
  if (created.code !== 0) {
    await gitExec(["worktree", "remove", "--force", target], options.sourceWorkspace, 60_000).catch(() => undefined);
    await gitExec(["branch", "-D", branch], options.sourceWorkspace, 60_000).catch(() => undefined);
    throw new Error(`git worktree add failed (${created.code}): ${created.stderr || created.stdout}`);
  }
  return { workspace: target, branch };
}

async function cleanupWorktree(record: CodingLoopRecord, force: boolean): Promise<CodingLoopRecord> {
  if (record.isolation.mode !== "worktree" || !record.isolation.worktree_path) {
    throw new Error("Coding loop is not using worktree isolation");
  }
  if (record.status === "active") throw new Error("Finish or rollback the coding loop before cleaning its worktree");
  if (record.isolation.cleaned_at) return record;
  try {
    await fs.access(record.isolation.worktree_path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The directory may have been removed manually. Prune stale Git metadata
    // and still let the durable loop converge to a cleaned terminal state.
    await gitExec(["worktree", "prune"], record.isolation.source_workspace, 60_000).catch(() => undefined);
    record.isolation.cleaned_at = nowIso();
    return saveCodingLoop(record);
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(record.isolation.worktree_path);
  const result = await gitExec(args, record.isolation.source_workspace, WORKTREE_GIT_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`git worktree remove failed (${result.code}): ${result.stderr || result.stdout}`);
  record.isolation.cleaned_at = nowIso();
  return saveCodingLoop(record);
}

function handoff(record: CodingLoopRecord) {
  if (record.isolation.mode !== "worktree") return null;
  return {
    source_workspace: record.isolation.source_workspace,
    worktree_path: record.isolation.worktree_path,
    branch: record.isolation.branch,
    base_ref: record.isolation.base_ref,
    auto_commit: false,
    merge_hint: record.isolation.branch
      ? `Review the worktree. If it has uncommitted changes, commit them inside the worktree first; then merge '${record.isolation.branch}' from the source workspace when ready.`
      : null,
    cleanup_required: !record.isolation.cleaned_at,
  };
}

function compactLoop(record: CodingLoopRecord) {
  const lastAttempt = record.attempts.at(-1);
  return {
    id: record.id,
    goal: record.goal,
    task_id: record.task_id,
    managed_task: Boolean(record.managed_task),
    status: record.status,
    phase: record.phase,
    workspace: record.workspace,
    source_workspace: record.source_workspace,
    transaction_id: record.transaction_id,
    attempts: record.attempts.length,
    max_attempts: record.max_attempts,
    last_attempt: lastAttempt || null,
    context: record.context,
    isolation: record.isolation,
    updated_at: record.updated_at,
    handoff: handoff(record),
  };
}

function compactLoopListItem(record: CodingLoopRecord) {
  return {
    id: record.id,
    status: record.status,
    phase: record.phase,
    workspace: record.workspace,
    task_id: record.task_id,
    transaction_id: record.transaction_id,
    goal: record.goal.slice(0, 240),
    attempts: record.attempts.length,
    max_attempts: record.max_attempts,
    updated_at: record.updated_at,
  };
}

export function registerCodingLoopTools(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "coding_loop_status",
    {
      title: "Coding Loop Status",
      description: "Read persistent Codex-like coding-loop state. With no id, lists recent loops. This is read-only; use coding_loop for begin/resume/verify/finish/rollback/cleanup.",
      inputSchema: {
        id: z.string().optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ id, limit }) => {
      if (id) {
        const record = await getCodingLoop(id);
        const transaction = await getEditTransaction(record.transaction_id).catch(() => null);
        return toolResult("coding_loop_status", { loop: compactLoop(record), transaction }, { summary: `${id}: ${record.status}/${record.phase}` });
      }
      const loops = await listCodingLoops(limit);
      return toolResult("coding_loop_status", {
        config: getCodingLoopConfig(),
        loops: loops.map(compactLoopListItem),
      }, { summary: `${loops.length} coding loop(s)` });
    }
  );

  server.registerTool(
    "coding_loop",
    {
      title: "Coding Loop",
      description:
        "Durable Codex-like execution loop for regular ChatGPT. ChatGPT remains the reasoning model; Local Coder persists context, owns an edit transaction, runs bounded verification/repair cycles, resumes after reconnects, and can isolate work in a Git worktree without auto-merging.",
      inputSchema: {
        action: actionSchema,
        id: z.string().optional(),
        goal: z.string().min(1).max(20_000).optional(),
        workspace: z.string().optional(),
        task_id: z.string().optional(),
        manage_task: z.boolean().optional().default(true),
        isolation: z.enum(["none", "worktree"]).optional().default("none"),
        worktree_path: z.string().optional(),
        base_ref: z.string().max(200).optional().default("HEAD"),
        allow_dirty_base: z.boolean().optional().default(false),
        verification_preset: presetSchema.optional().default("quick"),
        commands: z.array(verificationCommandSchema).min(1).max(12).optional(),
        stop_on_failure: z.boolean().optional().default(false),
        max_attempts: z.number().int().min(1).max(8).optional().default(4),
        extend_attempts: z.number().int().min(1).max(8).optional(),
        intel_action: intelActionSchema.optional().default("impact"),
        query: z.string().max(20_000).optional(),
        path: z.string().optional(),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
        server: serverSchema.optional().default("auto"),
        max_results: z.number().int().positive().max(200).optional().default(80),
        allow_unverified: z.boolean().optional().default(false),
        force: z.boolean().optional().default(false),
        note: z.string().max(10_000).optional(),
      },
      annotations: toolAnnotations("edit"),
    },
    async (args) => {
      const {
        action, id, goal, workspace, task_id, manage_task, isolation, worktree_path, base_ref, allow_dirty_base,
        verification_preset, commands, stop_on_failure, max_attempts, extend_attempts,
        intel_action, query, path: intelPath, line, column, server: requestedServer, max_results,
        allow_unverified, force, note,
      } = args;

      if (action === "begin") {
        requireWriteAllowed();
        if (!goal?.trim()) throw new Error("goal is required for coding_loop action=begin");
        if (verification_preset === "custom" && !commands?.length) throw new Error("commands are required with verification_preset=custom");
        if (verification_preset !== "custom" && commands?.length) throw new Error("commands may only be used with verification_preset=custom");
        if ((line === undefined) !== (column === undefined)) throw new Error("line and column must be supplied together");
        if ((line !== undefined || column !== undefined) && !intelPath) throw new Error("path is required when line/column are supplied");
        if (base_ref.startsWith("-")) throw new Error("base_ref must be a Git revision, not an option");

        const session = getCurrentSessionState();
        const fallbackWorkspace =
          session?.workspace_kind === "project" && session.project_root ? session.project_root : defaultCwd;
        const sourceCandidate = await resolveProjectReference(workspace, fallbackWorkspace);
        const sourceWorkspace = await validatePath(sourceCandidate);
        assertCurrentSessionMutationPath(sourceWorkspace, "coding_loop begin");
        await recordProjectAffinity(sourceWorkspace).catch(() => undefined);
        if (task_id) {
          const linkedTask = await getAgentTask(task_id);
          if (!linkedTask) throw new Error(`Unknown agent task id: ${task_id}`);
          if (path.resolve(linkedTask.workspace) !== path.resolve(sourceWorkspace)) {
            throw new Error(`Agent task ${task_id} belongs to ${linkedTask.workspace}, not coding-loop workspace ${sourceWorkspace}`);
          }
        }
        let effectiveTaskId = task_id;
        let managedTask = false;
        if (!effectiveTaskId && manage_task) {
          const autoTask = await createAgentTask({
            title: goal.trim().slice(0, 160),
            objective: goal.trim(),
            workspace: sourceWorkspace,
            plan: [
              "Implement the requested change set",
              "Verify the affected project",
              "Finish and accept the transaction or rollback safely",
            ],
          });
          effectiveTaskId = autoTask.id;
          managedTask = true;
        }
        const loopId = newCodingLoopId();
        let effectiveWorkspace = sourceWorkspace;
        let worktree: { workspace: string; branch: string } | undefined;
        let transactionId: string | undefined;
        try {
          if (isolation === "worktree") {
            worktree = await createIsolatedWorktree({
              loopId,
              sourceWorkspace,
              requestedPath: worktree_path,
              baseRef: base_ref,
              allowDirtyBase: allow_dirty_base,
            });
            effectiveWorkspace = worktree.workspace;
          }
          const transaction = await beginEditTransaction(effectiveWorkspace, `coding-loop:${loopId}`);
          transactionId = transaction.id;
          const validIntelPath = intelPath
            ? await validatePath(path.isAbsolute(intelPath) ? intelPath : path.resolve(effectiveWorkspace, intelPath))
            : undefined;
          if (validIntelPath) await assertRepositoryPathInsideWorkspace(effectiveWorkspace, validIntelPath);
          const contextBuilt = await buildContext(effectiveWorkspace, defaultCwd, {
            action: intel_action,
            query,
            path: validIntelPath,
            line,
            column,
            server: requestedServer as LspServerId | "auto",
            maxResults: max_results,
          });
          const record = await createCodingLoop({
            id: loopId,
            goal: goal.trim(),
            task_id: effectiveTaskId,
            managed_task: managedTask,
            status: "active",
            phase: "editing",
            source_workspace: sourceWorkspace,
            workspace: effectiveWorkspace,
            transaction_id: transaction.id,
            verification: {
              preset: verification_preset,
              ...(verification_preset === "custom" ? { commands: commands as VerificationCommand[] } : {}),
              stop_on_failure,
            },
            max_attempts,
            attempts: [],
            context: contextBuilt.context,
            isolation: isolation === "worktree"
              ? {
                  mode: "worktree",
                  source_workspace: sourceWorkspace,
                  workspace: effectiveWorkspace,
                  worktree_path: effectiveWorkspace,
                  branch: worktree!.branch,
                  base_ref,
                }
              : { mode: "none", source_workspace: sourceWorkspace, workspace: effectiveWorkspace },
            notes: note?.trim() ? [{ at: nowIso(), text: note.trim() }] : [],
          });
          if (effectiveTaskId) {
            await updateAgentTask(effectiveTaskId, { note: `Coding loop ${loopId} started: ${goal.trim()}` }).catch(() => undefined);
          }
          await audit({
            tool: "coding_loop",
            action: "begin",
            target: effectiveWorkspace,
            status: "ok",
            details: { id: loopId, task_id: effectiveTaskId, managed_task: managedTask, transaction_id: transaction.id, isolation, max_attempts },
          });
          return toolResult("coding_loop", {
            action,
            loop: compactLoop(record),
            intel: contextBuilt.intel_result ?? null,
            next: `Use transaction_id=${transaction.id} on supported file edits. For shell-driven edits also pass transaction_id plus mutation_paths. Then call coding_loop action=verify id=${loopId}.`,
          }, { summary: `began ${loopId} in ${isolation} mode` });
        } catch (error) {
          if (transactionId) await rollbackEditTransaction(transactionId, true).catch(() => undefined);
          if (managedTask && effectiveTaskId) {
            await updateAgentTask(effectiveTaskId, { status: "cancelled", note: `Coding loop startup failed: ${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined);
          }
          if (worktree) {
            await gitExec(["worktree", "remove", "--force", worktree.workspace], sourceWorkspace, WORKTREE_GIT_TIMEOUT_MS).catch(() => undefined);
            await gitExec(["branch", "-D", worktree.branch], sourceWorkspace, 60_000).catch(() => undefined);
          }
          throw error;
        }
      }

      if (!id) throw new Error(`id is required for coding_loop action='${action}'`);
      return withCodingLoopLock(id, async () => {
        let record = await getCodingLoop(id);
        await validatePath(record.workspace);
        await recordProjectAffinity(record.workspace).catch(() => undefined);

        if (action === "resume") {
          if (record.status === "failed" && extend_attempts) {
            if (record.max_attempts >= 8) {
              throw new Error(`Coding loop ${id} is already at the maximum verification budget (8 attempts)`);
            }
            record.max_attempts = Math.min(8, record.max_attempts + extend_attempts);
            record.status = "active";
            record.phase = "repair";
            delete record.failed_at;
          } else if (record.status !== "active") {
            return toolResult("coding_loop", { action, loop: compactLoop(record), reopened: false }, {
              ok: false,
              summary: `${id} is ${record.status}; only failed loops can be reopened with extend_attempts`,
            });
          }
          const refreshed = await buildContext(record.workspace, defaultCwd);
          const changed = refreshed.context.fingerprint !== record.context.fingerprint;
          record.context = refreshed.context;
          if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
          record = await saveCodingLoop(record);
          return toolResult("coding_loop", {
            action,
            loop: compactLoop(record),
            context_changed: changed,
            reopened: record.status === "active",
            next: record.phase === "repair" ? "Repair the recorded verification failures using the existing transaction_id, then verify again." : "Continue edits using the existing transaction_id, then verify.",
          }, { summary: `resumed ${id}: ${record.phase}` });
        }

        if (action === "refresh") {
          if (record.status !== "active") throw new Error(`Coding loop ${id} is ${record.status}, not active`);
          if ((line === undefined) !== (column === undefined)) throw new Error("line and column must be supplied together");
          let validIntelPath: string | undefined;
          if (intelPath) {
            validIntelPath = await validatePath(path.isAbsolute(intelPath) ? intelPath : path.resolve(record.workspace, intelPath));
            await assertRepositoryPathInsideWorkspace(record.workspace, validIntelPath);
          }
          const refreshed = await buildContext(record.workspace, defaultCwd, {
            action: intel_action,
            query,
            path: validIntelPath,
            line,
            column,
            server: requestedServer as LspServerId | "auto",
            maxResults: max_results,
          });
          const changed = refreshed.context.fingerprint !== record.context.fingerprint;
          record.context = refreshed.context;
          if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
          record = await saveCodingLoop(record);
          await audit({ tool: "coding_loop", action: "refresh", target: record.workspace, status: "ok", details: { id, context_changed: changed, query } });
          return toolResult("coding_loop", {
            action,
            loop: compactLoop(record),
            context_changed: changed,
            intel: refreshed.intel_result ?? null,
          }, { summary: `refreshed ${id}${changed ? ": workspace changed" : ""}` });
        }

        if (action === "verify") {
          if (record.status !== "active") throw new Error(`Coding loop ${id} is ${record.status}, not active`);
          if (record.attempts.length >= record.max_attempts) {
            record.status = "failed";
            record.phase = "failed";
            record.failed_at = nowIso();
            record = await saveCodingLoop(record);
            return toolResult("coding_loop", {
              action,
              loop: compactLoop(record),
              attempt_budget_exhausted: true,
              next: "Call coding_loop action=resume with extend_attempts to explicitly allow more repair cycles, or rollback.",
            }, { ok: false, summary: `${id} exhausted ${record.max_attempts} verification attempts` });
          }

          return withEditTransactionLock(record.transaction_id, async () => {
            const transaction = await getEditTransaction(record.transaction_id);
            if (transaction.status !== "active") {
              throw new Error(
                `Coding loop transaction ${record.transaction_id} is ${transaction.status}; ` +
                "finish/rollback must reconcile terminal transaction state before more verification"
              );
            }
            const started = nowIso();
            const affectedFiles = [...new Set(transaction.edits.flatMap((edit) => edit.paths))];
            const verification = await runVerification(record, affectedFiles);
            const failures = diagnoseFailures(verification.results);
            const attempt: CodingLoopAttempt = {
              number: record.attempts.length + 1,
              started_at: started,
              finished_at: nowIso(),
              passed: verification.passed,
              failed: verification.failed,
              duration_ms: verification.duration_ms,
              failures,
            };
            record.attempts.push(attempt);
            await recordTransactionVerification(record.transaction_id, {
              at: attempt.finished_at,
              preset: record.verification.preset,
              passed: verification.passed,
              failed: verification.failed,
              duration_ms: verification.duration_ms,
              results: verification.results.map((result) => ({
                label: result.label,
                command: result.command,
                exit_code: result.exit_code,
                timed_out: result.timed_out,
                excerpt: result.excerpt,
              })),
            });

            if (verification.failed === 0) {
              record.phase = "ready";
            } else if (record.attempts.length >= record.max_attempts) {
              record.status = "failed";
              record.phase = "failed";
              record.failed_at = nowIso();
            } else {
              record.phase = "repair";
            }
            const refreshed = await buildContext(record.workspace, defaultCwd);
            record.context = refreshed.context;
            if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
            record = await saveCodingLoop(record);
            if (record.task_id) {
              const compactFailures = failures.map((failure) => `${failure.label}:${failure.category}`).join(", ");
              await updateAgentTask(record.task_id, {
                note: `Coding loop ${id} verification attempt ${attempt.number}/${record.max_attempts}: ${verification.passed} passed, ${verification.failed} failed${compactFailures ? ` (${compactFailures})` : ""}`,
              }).catch(() => undefined);
            }
            await audit({
              tool: "coding_loop",
              action: "verify",
              target: record.workspace,
              status: verification.failed ? "error" : "ok",
              details: { id, attempt: attempt.number, max_attempts: record.max_attempts, passed: verification.passed, failed: verification.failed, incremental: verification.incremental, cached_checks: verification.cached_checks, affected_files: affectedFiles.length },
            });
            return toolResult("coding_loop", {
              action,
              loop: compactLoop(record),
              verification: { ...verification, failures },
              next: verification.failed === 0
                ? "Verification passed. Review transaction preview if needed, then call coding_loop action=finish."
                : record.status === "failed"
                  ? "Attempt budget exhausted. Resume with extend_attempts or rollback."
                  : "Use the failure evidence to repair within the same transaction_id, then verify again.",
            }, {
              ok: verification.failed === 0,
              summary: `${verification.passed}/${verification.results.length} checks passed on attempt ${attempt.number}/${record.max_attempts}`,
            });
          });
        }

        if (action === "finish") {
          requireWriteAllowed();
          if (record.status === "completed") {
            return toolResult("coding_loop", {
              action,
              loop: compactLoop(record),
              handoff: handoff(record),
              reconciled: true,
            }, { summary: `${id} already completed` });
          }
          if (record.status !== "active") throw new Error(`Coding loop ${id} is ${record.status}, not active`);
          const lastAttempt = record.attempts.at(-1);
          if (!allow_unverified && (!lastAttempt || lastAttempt.failed !== 0)) {
            throw new Error("Coding loop cannot finish until its latest verification passes. Set allow_unverified=true only for an explicit override.");
          }
          const transaction = await withEditTransactionLock(record.transaction_id, async () => {
            const current = await getEditTransaction(record.transaction_id);
            if (current.status === "rolled_back") {
              throw new Error(`Coding loop transaction ${record.transaction_id} was already rolled back`);
            }
            return current.status === "accepted" ? current : acceptEditTransaction(record.transaction_id);
          });
          record.status = "completed";
          record.phase = "completed";
          record.completed_at = nowIso();
          if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
          // Persist the terminal loop state immediately after the transaction
          // becomes accepted. A crash or context-refresh failure after this
          // point can then be retried/reconciled safely.
          record = await saveCodingLoop(record);
          let contextRefreshError: string | null = null;
          try {
            const refreshed = await buildContext(record.workspace, defaultCwd);
            record.context = refreshed.context;
            record = await saveCodingLoop(record);
          } catch (error) {
            contextRefreshError = error instanceof Error ? error.message : String(error);
          }
          if (record.task_id) {
            await updateAgentTask(record.task_id, {
              ...(record.managed_task ? { status: "completed" as const } : {}),
              note: `Coding loop ${id} completed successfully.`,
            }).catch(() => undefined);
          }
          await audit({ tool: "coding_loop", action: "finish", target: record.workspace, status: "ok", details: { id, allow_unverified, isolation: record.isolation.mode } });
          return toolResult("coding_loop", {
            action,
            loop: compactLoop(record),
            handoff: handoff(record),
            transaction_status: transaction.status,
            context_refresh_error: contextRefreshError,
            next: record.isolation.mode === "worktree"
              ? "Review the worktree/branch and merge it from the source workspace when ready. cleanup removes the worktree but does not delete the branch."
              : "Coding loop complete; transaction accepted.",
          }, { summary: `completed ${id}` });
        }

        if (action === "rollback") {
          requireWriteAllowed();
          if (record.status === "cancelled") {
            return toolResult("coding_loop", {
              action,
              loop: compactLoop(record),
              handoff: handoff(record),
              reconciled: true,
            }, { summary: `${id} already cancelled` });
          }
          const transaction = await getEditTransaction(record.transaction_id);
          if (transaction.status === "active") {
            const rolled = await withEditTransactionLock(record.transaction_id, async () => rollbackEditTransaction(record.transaction_id, force));
            if (!rolled.rolled_back) {
              return toolResult("coding_loop", { action, loop: compactLoop(record), rollback: rolled }, {
                ok: false,
                summary: `rollback blocked by ${rolled.conflicts.length} conflict(s)`,
              });
            }
          } else if (transaction.status === "accepted") {
            throw new Error("The loop transaction is already accepted and cannot be rolled back through coding_loop");
          }
          record.status = "cancelled";
          record.phase = "cancelled";
          record.cancelled_at = nowIso();
          if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
          record = await saveCodingLoop(record);
          if (record.task_id && record.managed_task) {
            await updateAgentTask(record.task_id, { status: "cancelled", note: `Coding loop ${id} rolled back and was cancelled.` }).catch(() => undefined);
          }
          await audit({ tool: "coding_loop", action: "rollback", target: record.workspace, status: "ok", details: { id, force } });
          return toolResult("coding_loop", {
            action,
            loop: compactLoop(record),
            handoff: handoff(record),
            next: record.isolation.mode === "worktree" ? "Call coding_loop action=cleanup to remove the isolated worktree when no longer needed." : null,
          }, { summary: `rolled back and cancelled ${id}` });
        }

        if (action === "abandon") {
          requireWriteAllowed();
          if (record.status === "abandoned") {
            return toolResult("coding_loop", { action, loop: compactLoop(record), files_preserved: true }, {
              summary: `${id} already abandoned`,
            });
          }
          if (record.status === "completed" || record.status === "cancelled" || record.status === "archived") {
            throw new Error(`Coding loop ${id} is ${record.status}; it cannot be abandoned`);
          }
          const transaction = await getEditTransaction(record.transaction_id);
          if (transaction.status === "active") {
            await abandonEditTransaction(record.transaction_id);
          } else if (transaction.status === "accepted" || transaction.status === "rolled_back") {
            throw new Error(`Coding loop transaction ${record.transaction_id} is already ${transaction.status}; use the matching terminal loop action instead`);
          }
          record.status = "abandoned";
          record.phase = "abandoned";
          record.abandoned_at = nowIso();
          if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
          record = await saveCodingLoop(record);
          if (record.task_id && record.managed_task) {
            await updateAgentTask(record.task_id, {
              status: "abandoned",
              note: `Coding loop ${id} was abandoned without rolling files back.`,
            }).catch(() => undefined);
          }
          await audit({ tool: "coding_loop", action: "abandon", target: record.workspace, status: "ok", details: { id, files_preserved: true } });
          return toolResult("coding_loop", {
            action,
            loop: compactLoop(record),
            files_preserved: true,
            next: record.isolation.mode === "worktree"
              ? "Current files were preserved. cleanup can remove the isolated worktree later."
              : "Current files were preserved; the loop and transaction are no longer active.",
          }, { summary: `abandoned ${id} without changing current files` });
        }

        if (action === "archive") {
          requireWriteAllowed();
          if (record.status === "active") {
            throw new Error(`Coding loop ${id} is still active; finish, rollback, or abandon it before archiving`);
          }
          if (record.status !== "archived") {
            if (record.phase === "archived") {
              throw new Error(`Coding loop ${id} has inconsistent state: phase is archived while status is ${record.status}`);
            }
            record.archived_from_status = record.status;
            record.archived_from_phase = record.phase;
            record.status = "archived";
            record.phase = "archived";
            record.archived_at = nowIso();
            if (note?.trim()) record.notes.push({ at: nowIso(), text: note.trim() });
            record = await saveCodingLoop(record);
          }
          await audit({ tool: "coding_loop", action: "archive", target: record.workspace, status: "ok", details: { id } });
          return toolResult("coding_loop", { action, loop: compactLoop(record) }, { summary: `archived ${id}` });
        }

        if (action === "cleanup") {
          requireWriteAllowed();
          await validatePath(record.source_workspace);
          if (record.isolation.worktree_path) await validatePath(record.isolation.worktree_path).catch((error) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw error;
          });
          record = await cleanupWorktree(record, force);
          await audit({ tool: "coding_loop", action: "cleanup", target: record.source_workspace, status: "ok", details: { id, force, worktree: record.isolation.worktree_path } });
          return toolResult("coding_loop", { action, loop: compactLoop(record) }, { summary: `cleaned worktree for ${id}` });
        }

        throw new Error(`Unsupported coding_loop action: ${action}`);
      });
    }
  );
}
