import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { updateAgentTask } from "../lib/agent-task-store.js";

const commandSchema = z.object({
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(100_000),
  timeout_seconds: z.number().int().min(5).max(3600).optional().default(180),
});

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
      const root = projectPath ? await validatePath(projectPath) : defaultCwd;
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
        "Run a deterministic project verification recipe in one MCP call and return compact per-check evidence. Auto-discovers package build/lint/typecheck/test/integration checks or reads .local-coder/verification.json. Use preset=discover to inspect the recipe without executing it.",
      inputSchema: {
        path: z.string().optional(),
        preset: z.enum(["discover", "quick", "full", "custom"]).optional().default("full"),
        commands: z.array(commandSchema).min(1).max(12).optional(),
        stop_on_failure: z.boolean().optional().default(false),
        task_id: z.string().optional().describe("Optional persistent agent_task id to append a compact verification note"),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ path: projectPath, preset, commands, stop_on_failure, task_id }) => {
      const root = projectPath ? await validatePath(projectPath) : defaultCwd;
      if (preset === "custom" && !commands?.length) throw new Error("commands are required when preset=custom");
      if (preset !== "custom" && commands?.length) throw new Error("commands may only be supplied when preset=custom");

      const discovered = preset === "custom"
        ? { source: "custom" as const, commands: commands as VerificationCommand[] }
        : await discoverVerificationRecipe(root, preset === "discover" ? "full" : preset);

      if (preset === "discover") {
        return toolResult("verify_project", {
          path: root,
          preset,
          source: discovered.source,
          commands: discovered.commands,
        }, { summary: `${discovered.commands.length} verification check(s) discovered` });
      }

      if (!discovered.commands.length) {
        return toolResult(
          "verify_project",
          { path: root, preset, source: discovered.source, commands: [], results: [] },
          { ok: false, summary: "no verification checks discovered" }
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
      }> = [];

      for (const check of discovered.commands) {
        requireCommandAllowed(check.command, root);
        const result = await runOneShotCommand(check.command, root, check.timeout_seconds * 1000);
        const compact = compactVerificationOutput(result.stdout, result.stderr);
        results.push({
          label: check.label,
          command: check.command,
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          timed_out: result.timed_out,
          ...compact,
        });
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
        status: failed ? "error" : "ok",
        details: { preset, source: discovered.source, checks: results.length, failed, duration_ms: totalMs, task_id },
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
          stopped_early: stop_on_failure && results.length < discovered.commands.length,
        },
        { ok: failed === 0, summary }
      );
    }
  );
}
