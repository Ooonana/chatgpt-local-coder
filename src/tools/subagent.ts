import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import {
  clearSubagents,
  getSubagent,
  getSubagentConfig,
  getSubagentConfigPath,
  listSubagents,
  spawnSubagent,
  stopSubagent,
  waitForSubagent,
  type SubagentRecord,
} from "../lib/subagent-manager.js";
import { getCurrentSessionState } from "../lib/session-context.js";
import {
  canonicalProjectRootForPath,
  resolveWorkspaceScope,
  sameProjectRoot,
} from "../lib/workspace-scope.js";

function summarizeAgent(agent: SubagentRecord) {
  const { stdout: _stdout, stderr: _stderr, ...summary } = agent;
  return summary;
}

async function agentProjectRoot(agent: SubagentRecord): Promise<string | null> {
  return await canonicalProjectRootForPath(agent.requested_workspace);
}

async function assertAgentScope(agent: SubagentRecord, workspace: string | undefined, requireScope: boolean): Promise<void> {
  const scope = await resolveWorkspaceScope(workspace);
  if (!scope.scoped) {
    if (requireScope) {
      throw new Error(`workspace is required to control subagent ${agent.id} from an unbound MCP transport.`);
    }
    return;
  }
  const root = await agentProjectRoot(agent);
  if (!sameProjectRoot(root, scope.projectRoot)) {
    throw new Error(`Subagent ${agent.id} is outside the requested workspace scope.`);
  }
}

export function registerSubagentTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "subagent",
    {
      title: "Real Subagent",
      description:
        "Run/manage a separate model-capable agent process through the configured subagent runner. This is real delegation only when profiles/subagents.json points at an external model runner; it does not reuse the parent ChatGPT app subscription. Actions: config, spawn, list, status, output, wait, stop, clear.",
      inputSchema: {
        action: z.enum(["config", "spawn", "list", "status", "output", "wait", "stop", "clear"]),
        id: z.string().optional(),
        objective: z.string().max(100000).optional(),
        workspace: z.string().optional(),
        label: z.string().max(200).optional(),
        timeout_seconds: z.number().int().positive().max(86400).optional(),
        wait_seconds: z
          .number()
          .int()
          .nonnegative()
          .max(30)
          .optional()
          .default(10)
          .describe("Short polling window. Keep this brief; use repeated wait/status/output calls instead of holding one MCP request open."),
        tail_chars: z.number().int().positive().max(500000).optional().default(50000),
        isolation: z.enum(["none", "worktree"]).optional(),
        remove_worktrees: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ action, id, objective, workspace, label, timeout_seconds, wait_seconds, tail_chars, isolation, remove_worktrees }) => {
      if (action === "config") {
        const config = await getSubagentConfig();
        return toolResult("subagent", {
          action,
          config_path: getSubagentConfigPath(),
          config: { ...config, env: undefined },
          env_keys: Object.keys(config.env ?? {}),
          chatgpt_subscription_reuse: false,
        });
      }
      if (action === "list") {
        const scope = await resolveWorkspaceScope(workspace);
        const all = listSubagents();
        const agents = scope.scoped
          ? (await Promise.all(all.map(async (agent) => ({
              agent,
              matches: sameProjectRoot(await agentProjectRoot(agent), scope.projectRoot),
            })))).filter((item) => item.matches).map((item) => item.agent)
          : all;
        return toolResult(
          "subagent",
          { action, agents: agents.map(summarizeAgent), count: agents.length },
          { summary: `${agents.length} subagent(s)` }
        );
      }
      if (action === "clear") {
        const scope = await resolveWorkspaceScope(workspace);
        if (!scope.scoped) {
          throw new Error("workspace is required for subagent clear from an unbound MCP transport.");
        }
        const result = await clearSubagents(remove_worktrees, scope.projectRoot);
        return toolResult("subagent", { action, ...result });
      }
      if (action === "spawn") {
        if (!objective?.trim()) throw new Error("objective is required for subagent spawn");
        const session = getCurrentSessionState();
        const validWorkspace = workspace
          ? await validatePath(workspace)
          : session?.workspace_kind === "project" && session.project_root
            ? await validatePath(session.project_root)
            : defaultCwd;
        const agent = await spawnSubagent({
          objective,
          workspace: validWorkspace,
          label,
          timeout_ms: timeout_seconds ? timeout_seconds * 1000 : undefined,
          isolation,
        });
        return toolResult("subagent", { action, agent: summarizeAgent(agent) }, { summary: `started subagent ${agent.id}` });
      }
      if (!id) throw new Error(`id is required for subagent action '${action}'`);
      if (action === "status") {
        const agent = getSubagent(id);
        if (!agent) throw new Error(`Unknown subagent id: ${id}`);
        await assertAgentScope(agent, workspace, false);
        return toolResult("subagent", { action, agent: summarizeAgent(agent) });
      }
      if (action === "output") {
        const agent = getSubagent(id);
        if (!agent) throw new Error(`Unknown subagent id: ${id}`);
        await assertAgentScope(agent, workspace, false);
        return toolResult("subagent", {
          action,
          id,
          running: agent.running,
          exit_code: agent.exit_code,
          stdout: agent.stdout.slice(-tail_chars),
          stderr: agent.stderr.slice(-tail_chars),
        });
      }
      if (action === "wait") {
        const existing = getSubagent(id);
        if (!existing) throw new Error(`Unknown subagent id: ${id}`);
        await assertAgentScope(existing, workspace, false);
        const agent = await waitForSubagent(id, wait_seconds * 1000);
        return toolResult(
          "subagent",
          {
            action,
            agent: summarizeAgent(agent),
            stdout: agent.stdout.slice(-tail_chars),
            stderr: agent.stderr.slice(-tail_chars),
          },
          { summary: agent.running ? `${id} still running` : `${id} exit ${agent.exit_code}` }
        );
      }
      const existing = getSubagent(id);
      if (!existing) throw new Error(`Unknown subagent id: ${id}`);
      await assertAgentScope(existing, workspace, true);
      const agent = await stopSubagent(id);
      return toolResult("subagent", { action, agent: summarizeAgent(agent) }, { summary: `stop sent to ${id}` });
    }
  );
}
