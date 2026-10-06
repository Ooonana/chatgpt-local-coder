import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import {
  checkpointContextCapsule,
  compactContextCapsule,
  deleteContextCapsule,
  getContextCapsule,
  getContextCapsuleConfig,
  getContextCapsuleStateErrors,
  listContextCapsules,
  resumeContextCapsule,
} from "../lib/context-capsule-store.js";

const fileSchema = z.object({
  path: z.string().min(1).max(2_000),
  note: z.string().max(1_000).optional(),
});

function sameWorkspace(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function registerContextCapsuleTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "context_capsule",
    {
      title: "Context Capsule",
      description:
        "Durable compact working-context checkpoint for regular ChatGPT. Use checkpoint after major decisions/long tool runs and resume after chat/context loss; Local Coder also auto-snapshots machine state at phase boundaries without pretending to read hidden chat history.",
      inputSchema: {
        action: z.enum(["checkpoint", "resume", "status", "clear"]),
        id: z.string().optional(),
        workspace: z.string().optional(),
        task_id: z.string().optional(),
        coding_loop_id: z.string().optional(),
        objective: z.string().max(10_000).optional(),
        summary: z.string().max(20_000).optional(),
        decisions: z.array(z.string().max(2_000)).max(30).optional(),
        findings: z.array(z.string().max(2_000)).max(30).optional(),
        blockers: z.array(z.string().max(2_000)).max(30).optional(),
        next_steps: z.array(z.string().max(2_000)).max(30).optional(),
        files: z.array(fileSchema).max(50).optional(),
        semantic_mode: z.enum(["replace", "merge"]).optional().default("replace")
          .describe("checkpoint only: replace clears omitted semantic fields; merge preserves omitted fields"),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, id, workspace, task_id, coding_loop_id, objective, summary, decisions, findings, blockers, next_steps, files, semantic_mode, limit }) => {
      if (action === "status") {
        const resolvedWorkspace = await validatePath(workspace || defaultCwd);
        const capsules = (await listContextCapsules(200))
          .filter((capsule) => capsule.workspace === resolvedWorkspace)
          .filter((capsule) => !task_id || capsule.task_id === task_id)
          .filter((capsule) => !coding_loop_id || capsule.coding_loop_id === coding_loop_id)
          .slice(0, limit);
        return toolResult("context_capsule", {
          action,
          config: getContextCapsuleConfig(),
          capsules: capsules.map(compactContextCapsule),
          state_errors: getContextCapsuleStateErrors(),
        }, { summary: `${capsules.length} context capsule(s)` });
      }

      if (action === "resume") {
        const stored = id && !workspace ? await getContextCapsule(id) : null;
        const resolvedWorkspace = await validatePath(workspace || stored?.workspace || defaultCwd);
        const capsule = await resumeContextCapsule({
          workspace: resolvedWorkspace,
          id,
          task_id,
          coding_loop_id,
        });
        if (!capsule) {
          return toolResult("context_capsule", {
            action,
            capsule: null,
            next: "No durable capsule matched. Resume agent_task/coding_loop if known, then create a context checkpoint once working state is reconstructed.",
          }, { ok: false, summary: "no matching context capsule" });
        }
        return toolResult("context_capsule", {
          action,
          capsule,
          next: capsule.semantic.next_steps[0] || capsule.machine.task?.progress.next_step?.title || "Continue from the capsule's semantic summary and live machine state.",
        }, { summary: `resume ${capsule.id}: ${capsule.objective || "working context"}` });
      }

      requireWriteAllowed();

      if (action === "clear") {
        if (!id) throw new Error("id is required for context_capsule action=clear");
        const stored = await getContextCapsule(id);
        await validatePath(stored.workspace);
        await deleteContextCapsule(id);
        await audit({ tool: "context_capsule", action: "clear", target: id, status: "ok" });
        return toolResult("context_capsule", { action, id, cleared: true }, { summary: `cleared ${id}` });
      }

      const stored = id ? await getContextCapsule(id) : null;
      const storedWorkspace = stored ? await validatePath(stored.workspace) : null;
      const resolvedWorkspace = await validatePath(workspace || storedWorkspace || defaultCwd);
      if (storedWorkspace && !sameWorkspace(resolvedWorkspace, storedWorkspace)) {
        throw new Error(`Context capsule ${id} belongs to a different workspace: ${storedWorkspace}`);
      }
      const capsule = await checkpointContextCapsule({
        id,
        workspace: resolvedWorkspace,
        task_id,
        coding_loop_id,
        objective,
        summary,
        decisions,
        findings,
        blockers,
        next_steps,
        files,
        semantic_mode,
      });
      await audit({
        tool: "context_capsule",
        action: "checkpoint",
        target: resolvedWorkspace,
        status: "ok",
        details: { id: capsule.id, task_id: capsule.task_id, coding_loop_id: capsule.coding_loop_id },
      });
      return toolResult("context_capsule", {
        action,
        capsule,
        next: "This compact semantic + machine-state capsule can be resumed after chat/context loss.",
      }, { summary: `checkpointed ${capsule.id}` });
    }
  );
}