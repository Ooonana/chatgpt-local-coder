import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import {
  createAgentTask,
  getAgentTask,
  getAgentTaskProgress,
  getResumableAgentTask,
  listAgentTasks,
  updateAgentTask,
  updateAgentTaskStep,
  type AgentTaskStatus,
  type AgentTaskStepStatus,
} from "../lib/agent-task-store.js";
import {
  assertCurrentSessionMutationPath,
  getCurrentSessionState,
} from "../lib/session-context.js";
import { sameResolvedPath } from "../lib/path-identity.js";
import { getManagedProcessSnapshot } from "./shell.js";
import { listCodingLoops } from "../lib/coding-loop-store.js";
import { summarizeTaskActivity } from "../lib/task-activity.js";

const statusSchema = z.enum(["active", "blocked", "completed", "cancelled", "abandoned", "archived"]);
const stepStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked", "skipped"]);

function taskWithProgress<T extends Awaited<ReturnType<typeof getAgentTask>>>(task: NonNullable<T>) {
  const runningWorkers = getManagedProcessSnapshot().filter((worker) => worker.running && worker.task_id === task.id);
  return {
    ...task,
    progress: getAgentTaskProgress(task),
    execution: {
      status_scope: "persistent_plan",
      running_worker_count: runningWorkers.length,
      note: "Task status tracks a plan. It does not start or prove a running agent.",
    },
  };
}

export function registerAgentTaskTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "agent_task",
    {
      title: "Agent Task State",
      description:
        "Persistent coding-agent plan state for regular ChatGPT. Tracks objective, structured plan-step progress, notes, workspace, and resume state across MCP/chat sessions; Local Coder stores the loop while ChatGPT remains the reasoning model.",
      inputSchema: {
        action: z.enum(["start", "list", "get", "resume", "review", "update", "step", "finish", "cancel", "abandon", "archive"]),
        id: z.string().optional(),
        title: z.string().max(200).optional(),
        objective: z.string().max(10000).optional(),
        workspace: z.string().optional(),
        plan: z.array(z.string().max(1000)).max(100).optional(),
        note: z.string().max(10000).optional(),
        status: statusSchema.optional(),
        step_id: z.string().optional(),
        step_index: z.number().int().min(0).max(99).optional(),
        step_status: stepStatusSchema.optional(),
        stale_hours: z.number().min(1).max(720).optional().default(24).describe("Review-only: minimum age in hours for stale active/blocked tasks"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, id, title, objective, workspace, plan, note, status, step_id, step_index, step_status, stale_hours }) => {
      if (action === "list") {
        const resolvedWorkspace = workspace ? await validatePath(workspace) : null;
        const tasks = (await listAgentTasks(status as AgentTaskStatus | undefined))
          .filter((task) => !resolvedWorkspace || sameResolvedPath(task.workspace, resolvedWorkspace));
        return toolResult("agent_task", { action, tasks: tasks.map(taskWithProgress) }, { summary: `${tasks.length} task(s)` });
      }

      if (action === "get") {
        if (!id) throw new Error("id is required for get");
        const task = await getAgentTask(id);
        if (!task) throw new Error(`Unknown agent task id: ${id}`);
        return toolResult("agent_task", { action, task: taskWithProgress(task) }, { summary: `${task.title} — ${task.status}` });
      }

      if (action === "review") {
        if (!workspace) throw new Error("Review requires an explicit workspace; it never scans or edits other projects");
        const resolvedWorkspace = await validatePath(workspace);
        const records = (await listAgentTasks())
          .filter((task) => sameResolvedPath(task.workspace, resolvedWorkspace) && (!id || task.id === id));
        if (id && !records.length) throw new Error("Task id does not belong to the requested workspace");
        const [loops, workers] = [await listCodingLoops(500), getManagedProcessSnapshot()];
        const now = Date.now();
        const matches = records.filter((task) => ["active", "blocked"].includes(task.status) &&
          Number.isFinite(Date.parse(task.updated_at)) &&
          now - Date.parse(task.updated_at) >= stale_hours * 3_600_000);
        const findings = matches.map((task) => {
          const activity = summarizeTaskActivity(task, loops, workers);
          const completeLoop = activity.linked_loop?.status === "completed";
          return {
            id: task.id, title: task.title, status: task.status, updated_at: task.updated_at,
            age_hours: Math.round((now - Date.parse(task.updated_at)) / 360_000) / 10,
            progress: getAgentTaskProgress(task), execution: activity,
            suggested_action: activity.running_worker_count > 0 ? "inspect_running_worker" :
              completeLoop ? "inspect_and_finish_manually" :
              activity.linked_loop?.status === "active" ? "resume_loop_or_explicitly_abandon" :
              "resume_or_mark_blocked_with_reason",
            auto_modified: false,
          };
        });
        return toolResult("agent_task", {
          action, workspace: resolvedWorkspace, threshold_hours: stale_hours,
          findings: findings.slice(0, 50), count: findings.length,
          note: "Read-only review. No task, loop, transaction, or project state was modified.",
        }, { summary: `Review: ${findings.length} stale task(s) in ${resolvedWorkspace}; nothing changed` });
      }

      if (action === "resume") {
        const resolvedWorkspace = workspace ? await validatePath(workspace) : undefined;
        let task = await getResumableAgentTask(id, resolvedWorkspace);
        if (!id && !resolvedWorkspace) {
          const candidates = (await listAgentTasks()).filter((item) => item.status === "active" || item.status === "blocked");
          if (candidates.length > 1) {
            throw new Error(
              `Multiple resumable tasks exist across workspaces (${candidates.slice(0, 6).map((item) => `${item.id} @ ${item.workspace}`).join("; ")}). Specify id or workspace instead of guessing.`
            );
          }
          task = candidates[0] || null;
        }
        if (!task) throw new Error(id ? `Agent task ${id} is not resumable` : "No active or blocked agent task matched the requested workspace");
        if (resolvedWorkspace && !sameResolvedPath(task.workspace, resolvedWorkspace)) {
          throw new Error(`Agent task ${task.id} belongs to ${task.workspace}, not ${resolvedWorkspace}`);
        }
        const progress = getAgentTaskProgress(task);
        return toolResult(
          "agent_task",
          { action, task: { ...task, progress } },
          { summary: progress.next_step ? `resume ${task.title}: ${progress.next_step.title}` : `resume ${task.title}` }
        );
      }

      requireWriteAllowed();

      if (action === "start") {
        if (!objective?.trim()) throw new Error("objective is required for start");
        const session = getCurrentSessionState();
        const resolvedWorkspace = workspace
          ? await validatePath(workspace)
          : session?.workspace_kind === "project" && session.project_root
            ? session.project_root
            : defaultCwd;
        await assertCurrentSessionMutationPath(resolvedWorkspace, "agent_task start");
        const task = await createAgentTask({ title, objective, workspace: resolvedWorkspace, plan });
        await audit({
          tool: "agent_task",
          action: "start",
          target: resolvedWorkspace,
          status: "ok",
          details: { id: task.id, title: task.title },
        });
        return toolResult("agent_task", { action, task: taskWithProgress(task) }, { summary: `started ${task.id}: ${task.title}` });
      }

      if (!id) throw new Error(`id is required for ${action}`);
      const existing = await getAgentTask(id);
      if (!existing) throw new Error(`Unknown agent task id: ${id}`);
      if (workspace) {
        const requestedWorkspace = await validatePath(workspace);
        if (!sameResolvedPath(existing.workspace, requestedWorkspace)) {
          throw new Error(`Task ${id} belongs to ${existing.workspace}, not the requested workspace ${requestedWorkspace}`);
        }
      }
      await assertCurrentSessionMutationPath(existing.workspace, `agent_task ${action}`);
      requireWriteAllowed(existing.workspace);
      if (action === "step") {
        if (step_id === undefined && step_index === undefined) throw new Error("step_id or step_index is required for step");
        if (!step_status) throw new Error("step_status is required for step");
        const task = await updateAgentTaskStep(
          id,
          { step_id, step_index },
          { status: step_status as AgentTaskStepStatus, note }
        );
        await audit({
          tool: "agent_task",
          action,
          target: task.workspace,
          status: "ok",
          details: { id: task.id, step_id, step_index, step_status },
        });
        return toolResult("agent_task", { action, task: taskWithProgress(task) }, { summary: `${task.id} — step ${step_status}` });
      }

      const nextStatus: AgentTaskStatus | undefined =
        action === "finish"
          ? "completed"
          : action === "cancel"
            ? "cancelled"
            : action === "abandon"
              ? "abandoned"
              : action === "archive"
                ? "archived"
                : (status as AgentTaskStatus | undefined);
      if (nextStatus === "archived" && (existing.status === "active" || existing.status === "blocked")) {
        throw new Error(`Agent task ${id} is still ${existing.status}; abandon or finish it before archiving.`);
      }
      const task = await updateAgentTask(id, { title, objective, status: nextStatus, plan, note });
      await audit({
        tool: "agent_task",
        action,
        target: task.workspace,
        status: "ok",
        details: { id: task.id, status: task.status },
      });
      return toolResult("agent_task", { action, task: taskWithProgress(task) }, { summary: `${task.id} — ${task.status}` });
    }
  );
}
