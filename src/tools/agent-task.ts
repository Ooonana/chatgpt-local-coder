import { z } from "zod";
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

const statusSchema = z.enum(["active", "blocked", "completed", "cancelled"]);
const stepStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked", "skipped"]);

function taskWithProgress<T extends Awaited<ReturnType<typeof getAgentTask>>>(task: NonNullable<T>) {
  return { ...task, progress: getAgentTaskProgress(task) };
}

export function registerAgentTaskTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "agent_task",
    {
      title: "Agent Task State",
      description:
        "Persistent coding-agent plan state for regular ChatGPT. Tracks objective, structured plan-step progress, notes, workspace, and resume state across MCP/chat sessions; Local Coder stores the loop while ChatGPT remains the reasoning model.",
      inputSchema: {
        action: z.enum(["start", "list", "get", "resume", "update", "step", "finish", "cancel"]),
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
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, id, title, objective, workspace, plan, note, status, step_id, step_index, step_status }) => {
      if (action === "list") {
        const tasks = await listAgentTasks(status as AgentTaskStatus | undefined);
        return toolResult("agent_task", { action, tasks: tasks.map(taskWithProgress) }, { summary: `${tasks.length} task(s)` });
      }

      if (action === "get") {
        if (!id) throw new Error("id is required for get");
        const task = await getAgentTask(id);
        if (!task) throw new Error(`Unknown agent task id: ${id}`);
        return toolResult("agent_task", { action, task: taskWithProgress(task) }, { summary: `${task.title} — ${task.status}` });
      }

      if (action === "resume") {
        const task = await getResumableAgentTask(id);
        if (!task) throw new Error(id ? `Agent task ${id} is not resumable` : "No active or blocked agent task to resume");
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
        const resolvedWorkspace = workspace ? await validatePath(workspace) : defaultCwd;
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
        action === "finish" ? "completed" : action === "cancel" ? "cancelled" : (status as AgentTaskStatus | undefined);
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
