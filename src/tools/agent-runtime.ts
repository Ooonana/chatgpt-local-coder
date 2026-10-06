import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { inspectProject } from "../lib/project-inspection.js";
import {
  compactVerificationOutput,
  discoverVerificationRecipe,
  type VerificationCommand,
} from "../lib/verification.js";
import { runOneShotCommand } from "./shell.js";
import { getAgentTask, updateAgentTask } from "../lib/agent-task-store.js";
import { recordProjectAffinity, resolveProjectReference } from "../lib/project-affinity.js";
import { getShellStatus } from "../lib/persistent-shell.js";
import { sameResolvedPath } from "../lib/path-identity.js";
import {
  hasVerificationCache,
  saveVerificationCache,
  selectIncrementalVerification,
  verificationFingerprint,
} from "../lib/verification-cache.js";

const commandSchema = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(100_000),
  timeout_seconds: z.number().int().min(5).max(3600).optional().default(180),
});

async function validateAffectedFiles(root: string, affectedFiles: string[] | undefined): Promise<string[]> {
  if (!affectedFiles?.length) return [];
  const canonicalRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const validated: string[] = [];
  for (const item of affectedFiles) {
    const candidate = path.isAbsolute(item) ? item : path.resolve(root, item);
    const allowed = await validatePath(candidate);
    const canonical = await fs.realpath(allowed).catch(() => path.resolve(allowed));
    const relative = path.relative(canonicalRoot, canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`affected_files path is outside the selected project: ${item}`);
    }
    validated.push(allowed);
  }
  return [...new Set(validated)];
}

export function registerAgentRuntimeTools(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "inspect_project",
    {
      title: "Inspect Project",
      description:
        "Compact repository reconnaissance in one call: top-level layout, important manifests, language/file distribution, package scripts, package manager, and Git branch/status. Use before many separate list/glob/git-status calls.",
      inputSchema: {
        path: z.string().optional(),
        max_depth: z.number().int().min(0).max(8).optional().default(4),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: projectPath, max_depth }) => {
      const affinityRoot = await resolveProjectReference(projectPath, getShellStatus().cwd || defaultCwd);
      const root = await validatePath(affinityRoot);
      await recordProjectAffinity(root).catch(() => undefined);
      const inspection = await inspectProject(root, max_depth);
      await audit({
        tool: "inspect_project",
        action: "inspect",
        target: root,
        status: "ok",
        details: { scanned_files: inspection.scanned_files, changed_files: inspection.git.changed_files },
      });
      return toolResult("inspect_project", inspection, {
        summary: `${inspection.name}: ${inspection.scanned_files} file(s) scanned, ${inspection.git.changed_files ?? 0} changed`,
      });
    }
  );

  server.registerTool(
    "verify_project",
    {
      title: "Verify Project",
      description:
        "Run deterministic build/lint/typecheck/test verification, not exploratory diagnosis. A failing project check is reported as verification_passed=false while the tool call itself remains successful. Use preset=discover to inspect the recipe without executing it.",
      inputSchema: {
        path: z.string().optional(),
        preset: z.enum(["discover", "quick", "full", "custom"]).optional().default("full"),
        commands: z.array(commandSchema).min(1).max(12).optional(),
        stop_on_failure: z.boolean().optional().default(false),
        task_id: z.string().optional().describe("Optional persistent agent_task id to append a compact verification note"),
        affected_files: z.array(z.string().max(2000)).max(256).optional(),
        use_cache: z.boolean().optional().default(false).describe("Opt-in successful-check cache; keyed to the complete Git worktree state and short TTL"),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ path: projectPath, preset, commands, stop_on_failure, task_id, affected_files, use_cache }) => {
      const affinityRoot = await resolveProjectReference(projectPath, getShellStatus().cwd || defaultCwd);
      const root = await validatePath(affinityRoot);
      await recordProjectAffinity(root).catch(() => undefined);
      if (task_id) {
        const task = await getAgentTask(task_id);
        if (!task) throw new Error(`Unknown agent task id: ${task_id}`);
        if (!sameResolvedPath(task.workspace, root)) {
          throw new Error(`Agent task ${task_id} belongs to '${task.workspace}', not verification workspace '${root}'.`);
        }
      }
      if (preset === "custom" && !commands?.length) throw new Error("commands are required when preset=custom");
      if (preset !== "custom" && commands?.length) throw new Error("commands may only be supplied when preset=custom");
      const safeAffectedFiles = await validateAffectedFiles(root, affected_files);

      const discovered = preset === "custom"
        ? { source: "custom" as const, commands: commands as VerificationCommand[] }
        : await discoverVerificationRecipe(root, preset === "discover" ? "full" : preset);
      const selected = preset === "discover"
        ? { commands: discovered.commands, incremental: false, reason: null }
        : selectIncrementalVerification(discovered.commands, safeAffectedFiles, preset);

      if (preset === "discover") {
        return toolResult("verify_project", {
          path: root,
          preset,
          source: discovered.source,
          commands: discovered.commands,
        }, { summary: `${discovered.commands.length} verification check(s) discovered` });
      }

      if (!selected.commands.length) {
        return toolResult(
          "verify_project",
          { path: root, preset, source: discovered.source, commands: [], results: [], verification_available: false, verification_passed: null, incremental: selected.incremental, incremental_reason: selected.reason },
          { summary: "no verification checks discovered" }
        );
      }

      const results: Array<{
        label: string;
        command: string;
        exit_code: number;
        duration_ms: number;
        timed_out: boolean;
        excerpt: string;
        output_chars: number;
        truncated: boolean;
        cached: boolean;
      }> = [];

      for (const check of selected.commands) {
        requireCommandAllowed(check.command, root);
        const fingerprint = use_cache && safeAffectedFiles.length
          ? await verificationFingerprint(root, check.command, safeAffectedFiles)
          : null;
        if (use_cache && fingerprint && await hasVerificationCache(root, check.command, fingerprint)) {
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
        const result = await runOneShotCommand(check.command, root, check.timeout_seconds * 1000);
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
        if (use_cache && result.exit_code === 0 && fingerprint) await saveVerificationCache(root, check.command, fingerprint).catch(() => undefined);
        if (stop_on_failure && result.exit_code !== 0) break;
      }

      const failed = results.filter((result) => result.exit_code !== 0).length;
      const passed = results.length - failed;
      const totalMs = results.reduce((sum, result) => sum + result.duration_ms, 0);
      const summary = `${passed}/${results.length} verification check(s) passed${failed ? `, ${failed} failed` : ""}`;

      if (task_id) {
        await updateAgentTask(task_id, {
          note: `Verification ${failed ? "FAILED" : "PASSED"}: ${summary}; ${results.map((r) => `${r.label}=${r.exit_code}`).join(", ")}`,
        });
      }
      await audit({
        tool: "verify_project",
        action: "verify",
        target: root,
        status: "ok",
        details: { preset, source: discovered.source, checks: results.length, failed, verification_passed: failed === 0, duration_ms: totalMs, task_id, incremental: selected.incremental, affected_files: safeAffectedFiles.length, use_cache },
      });
      return toolResult(
        "verify_project",
        {
          path: root,
          preset,
          source: discovered.source,
          results,
          passed,
          failed,
          duration_ms: totalMs,
          stopped_early: stop_on_failure && results.length < selected.commands.length,
          incremental: selected.incremental,
          incremental_reason: selected.reason,
          affected_files: safeAffectedFiles,
          cached_checks: results.filter((item) => item.cached).length,
          verification_available: true,
          verification_passed: failed === 0,
        },
        { summary }
      );
    }
  );
}
