import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { registerNodeReplTool } from "./tools/node-repl.js";
import { registerPonytailTurnTool } from "./tools/ponytail.js";
import { registerAgentTaskTool } from "./tools/agent-task.js";
import { registerImageTools } from "./tools/image.js";
import { registerLspTool } from "./tools/lsp.js";
import { registerPtyTool } from "./tools/pty.js";
import { registerSubagentTool } from "./tools/subagent.js";
import { registerDelegateTools } from "./tools/delegate.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";
import { TOOL_RESULT_OUTPUT_SCHEMA } from "./lib/tool-result.js";
import { runLocalHooks } from "./lib/local-hooks.js";
import { summarizeToolArgs } from "./lib/activity-log.js";
import { beginToolCall, finishToolCall, type RuntimeToolKind } from "./lib/runtime-state.js";
import { requireUnsafeRuntimeAllowed } from "./lib/permissions.js";

// OpenAI Secure MCP Tunnel rejects request/response bodies above 10 MiB.
// Keep a healthy margin for the JSON-RPC/SSE envelope so an oversized tool
// result becomes a small explicit MCP error instead of a tunnel-level 413 that
// can leave the ChatGPT turn looking permanently paused.
const MAX_SAFE_TOOL_RESULT_BYTES = 7 * 1024 * 1024;

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

function hookPathFromArguments(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "source", "destination", "working_directory", "workspace", "worktree_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

function boundedHookValue(value: unknown, maxChars = 100_000): unknown {
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxChars) return value;
    return { truncated: true, preview: json.slice(0, maxChars), original_chars: json.length };
  } catch {
    return { unserializable: true };
  }
}

function runtimeToolKind(isUpstreamProxy: boolean, config: any): RuntimeToolKind {
  if (isUpstreamProxy) return "MCP";
  if (config.annotations?.readOnlyHint === true) return "READ";
  if (config.annotations?.idempotentHint === true) return "EDIT";
  return "EXEC";
}

function assertToolResultFitsTransport(toolName: string, result: unknown): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    throw new Error(`Tool '${toolName}' returned a result that could not be serialized safely`);
  }
  if (bytes <= MAX_SAFE_TOOL_RESULT_BYTES) return;
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  throw new Error(
    `Tool '${toolName}' output is ${mib} MiB, above Local Coder's safe transport limit. ` +
      "Narrow or chunk the request (for example: read_text_file offset/limit, smaller base64 chunks, or a shallower tree)."
  );
}

function configureToolRegistration(server: McpServer, workspaceRoot: string): void {
  const profile = getChatGptToolProfile();
  const original = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => {
    const toolName = String(name);
    const isUpstreamProxy = toolName.includes("__");

    // Upstream MCP tools are namespaced as <server>__<tool>. An enabled
    // upstream is always exposed directly, even when local tools use slim.
    if (!isUpstreamProxy && profile !== "full" && !shouldExposeTool(toolName, profile)) {
      return NOOP_TOOL;
    }

    // Every native Local Coder tool already returns the stable
    // { ok, tool, summary, data } structuredContent envelope. Advertise that
    // contract so MCP clients (including ChatGPT) can validate/use structured
    // output instead of treating every result as opaque text.
    const nextConfig =
      !isUpstreamProxy && !config.outputSchema
        ? { ...config, outputSchema: TOOL_RESULT_OUTPUT_SCHEMA }
        : config;

    const wrapped = async (...callbackArgs: any[]) => {
      const input = callbackArgs[0];
      const path = hookPathFromArguments(input);
      const readOnly = nextConfig.annotations?.readOnlyHint === true;
      const runtimeCallId = beginToolCall({
        tool: toolName,
        kind: runtimeToolKind(isUpstreamProxy, nextConfig),
        summary: summarizeToolArgs(toolName, input),
      });
      const common = {
        tool: toolName,
        arguments: boundedHookValue(input),
        path,
        workspace: workspaceRoot,
      };

      try {
        if (isUpstreamProxy && !readOnly) {
          requireUnsafeRuntimeAllowed(`upstream MCP tool '${toolName}'`);
        }

        if (!readOnly) {
          const permissionHook = await runLocalHooks("permission_request", common);
          if (!permissionHook.allow) {
            throw new Error(permissionHook.reason || `Tool '${toolName}' denied by permission hook`);
          }
        }

        const pre = await runLocalHooks("pre_tool_use", common);
        if (!pre.allow) throw new Error(pre.reason || `Tool '${toolName}' blocked by pre_tool_use hook`);

        try {
          const result = await (callback as any)(...callbackArgs);
          assertToolResultFitsTransport(toolName, result);
          await runLocalHooks("post_tool_use", {
            ...common,
            result: boundedHookValue(result, 50_000),
          }).catch(() => undefined);
          finishToolCall(runtimeCallId, "ok");
          return result;
        } catch (error) {
          await runLocalHooks("post_tool_use", {
            ...common,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        finishToolCall(runtimeCallId, "error", error instanceof Error ? error.message : String(error));
        throw error;
      }
    };

    return original(name, nextConfig as any, wrapped as any);
  }) as typeof server.registerTool;
}

export function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string
): McpServer {
  const server = new McpServer(
    {
      name: "chatgpt-local-coder",
      version: "2.0.0",
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
      instructions: buildServerInstructions(
        workspaceRoot,
        workspaceRoots,
        fullDiskAccess,
        projectMemoryInstructions
      ),
    }
  );

  configureToolRegistration(server, workspaceRoot);

  registerFilesystemTools(server);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerNodeReplTool(server, workspaceRoot);
  registerPonytailTurnTool(server);
  registerAgentTaskTool(server, workspaceRoot);
  registerImageTools(server);
  registerLspTool(server, workspaceRoot);
  registerPtyTool(server, workspaceRoot);
  registerSubagentTool(server, workspaceRoot);
  registerDelegateTools(server);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    upstreamManager.registerMcpServer(server);
  }

  return server;
}
