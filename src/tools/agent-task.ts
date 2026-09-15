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
  listAgentTasks,
  updateAgentTask,
  type AgentTaskStatus,
} from "../lib/agent-task-store.js";

const statusSchema = z.enum(["active", "blocked", "completed", "cancelled"]);

export function registerAgentTaskTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "agent_task",
    {
      title: "Agent Task State",
      description:
        "Persist and resume multi-step coding task state across ChatGPT/MCP sessions. Stores objective, workspace, plan, notes, and status; it does not run another model or create a subagent.",
      inputSchema: {
        action: z.enum(["start", "list", "get", "update", "finish", "cancel"]),
        id: z.string().optional(),
        title: z.string().max(200).optional(),
        objective: z.string().max(10000).optional(),
        workspace: z.string().optional(),
        plan: z.array(z.string().max(1000)).max(100).optional(),
        note: z.string().max(10000).optional(),
        status: statusSchema.optional(),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, id, title, objective, workspace, plan, note, status }) => {
      if (action === "list") {
        const tasks = await listAgentTasks(status as AgentTaskStatus | undefined);
        return toolResult("agent_task", { action, tasks }, { summary: `${tasks.length} task(s)` });
      }

      if (action === "get") {
        if (!id) throw new Error("id is required for get");
        const task = await getAgentTask(id);
        if (!task) throw new Error(`Unknown agent task id: ${id}`);
        return toolResult("agent_task", { action, task }, { summary: `${task.title} — ${task.status}` });
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
        return toolResult("agent_task", { action, task }, { summary: `started ${task.id}: ${task.title}` });
      }

      if (!id) throw new Error(`id is required for ${action}`);
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
      return toolResult("agent_task", { action, task }, { summary: `${task.id} — ${task.status}` });
    }
  );
}
