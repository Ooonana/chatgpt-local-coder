import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { registerComputerUseTools } from "./tools/computer-use.js";
import { registerNodeReplTool } from "./tools/node-repl.js";
import { registerPonytailTurnTool } from "./tools/ponytail.js";
import { registerAgentTaskTool } from "./tools/agent-task.js";
import { registerImageTools } from "./tools/image.js";
import { registerLspTool } from "./tools/lsp.js";
import { registerPtyTool } from "./tools/pty.js";
import { registerSubagentTool } from "./tools/subagent.js";
import { registerDelegateTools } from "./tools/delegate.js";
import { registerAgentRuntimeTools } from "./tools/agent-runtime.js";
import { registerRepositoryIntelligenceTool } from "./tools/repository-intelligence.js";
import { registerEditTransactionTool } from "./tools/edit-transaction.js";
import { registerCodingLoopTools } from "./tools/coding-loop.js";
import { registerContextCapsuleTool } from "./tools/context-capsule.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";
import { TOOL_RESULT_OUTPUT_SCHEMA } from "./lib/tool-result.js";
import { runLocalHooks } from "./lib/local-hooks.js";
import { summarizeToolArgs } from "./lib/activity-log.js";
import { beginToolCall, finishToolCall, type RuntimeToolKind } from "./lib/runtime-state.js";
import { requireUnsafeRuntimeAllowed } from "./lib/permissions.js";
import {
  autoCheckpointContextCapsule,
  getAutoCheckpointContextCapsule,
  getContextCapsuleHeuristicConfig,
} from "./lib/context-capsule-store.js";
import { invalidateTextReadCache } from "./lib/text-read-cache.js";
import path from "node:path";
import {
  bindCurrentSessionMachine,
  bindCurrentSessionProject,
  ensureSessionRuntimeState,
  getCurrentSessionState,
  runWithSessionContext,
} from "./lib/session-context.js";
import { detectProjectRoot, isProjectRoot } from "./lib/project-affinity.js";
import { audit } from "./lib/audit.js";
import {
  incrementContextBudgetCycle,
  recordContextBudgetActivity,
  resetContextBudgetWindow,
} from "./lib/context-budget.js";

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

function scopePathFromArguments(value: unknown): string | undefined {
  const direct = hookPathFromArguments(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.files)) {
    const first = record.files.find((item) =>
      item && typeof item === "object" && typeof (item as Record<string, unknown>).path === "string"
    ) as Record<string, unknown> | undefined;
    if (first?.path) return String(first.path);
  }
  if (Array.isArray(record.commands)) {
    const dirs = [...new Set(record.commands
      .map((item) => item && typeof item === "object"
        ? (item as Record<string, unknown>).working_directory
        : undefined)
      .filter((item): item is string => typeof item === "string" && Boolean(item)))];
    if (dirs.length === 1) return dirs[0];
  }
  return undefined;
}

async function bindToolExecutionScope(input: unknown, workspaceRoot: string): Promise<void> {
  const candidate = scopePathFromArguments(input);
  if (!candidate) return;
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
  const root = await detectProjectRoot(absolute);
  if (await isProjectRoot(root)) bindCurrentSessionProject(root);
  else bindCurrentSessionMachine();
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

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function phaseBoundary(toolName: string, input: unknown): boolean {
  const action = input && typeof input === "object" && typeof (input as Record<string, unknown>).action === "string"
    ? String((input as Record<string, unknown>).action)
    : "";
  if (toolName === "coding_loop") return ["begin", "verify", "finish", "rollback", "abandon", "archive"].includes(action);
  if (toolName === "agent_task") return ["start", "step", "update", "finish", "cancel", "abandon", "archive"].includes(action);
  if (toolName === "edit_transaction") return ["verify", "accept", "rollback", "abandon"].includes(action);
  return toolName === "verify_project" || toolName === "git_commit";
}

function contextLinks(toolName: string, input: unknown, result: unknown): { workspace?: string; task_id?: string; coding_loop_id?: string } {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const structured = result && typeof result === "object"
    ? (result as { structuredContent?: Record<string, unknown> }).structuredContent
    : undefined;
  const data = structured?.data && typeof structured.data === "object"
    ? structured.data as Record<string, unknown>
    : {};
  const task = data.task && typeof data.task === "object" ? data.task as Record<string, unknown> : undefined;
  const loop = data.loop && typeof data.loop === "object" ? data.loop as Record<string, unknown> : undefined;
  const capsule = data.capsule && typeof data.capsule === "object" ? data.capsule as Record<string, unknown> : undefined;
  const capsuleMachine = capsule?.machine && typeof capsule.machine === "object"
    ? capsule.machine as Record<string, unknown>
    : undefined;
  const capsuleTask = capsuleMachine?.task && typeof capsuleMachine.task === "object"
    ? capsuleMachine.task as Record<string, unknown>
    : undefined;
  const capsuleLoop = capsuleMachine?.coding_loop && typeof capsuleMachine.coding_loop === "object"
    ? capsuleMachine.coding_loop as Record<string, unknown>
    : undefined;
  const transaction = data.transaction && typeof data.transaction === "object"
    ? data.transaction as Record<string, unknown>
    : undefined;
  const explicitWorkspace = typeof args.workspace === "string"
    ? args.workspace
    : ["inspect_project", "verify_project"].includes(toolName) && typeof args.path === "string"
      ? args.path
      : undefined;
  return {
    workspace: typeof capsule?.workspace === "string"
      ? capsule.workspace
      : typeof loop?.workspace === "string"
      ? loop.workspace
      : typeof task?.workspace === "string"
        ? task.workspace
        : typeof transaction?.workspace === "string"
          ? transaction.workspace
          : explicitWorkspace,
    task_id: typeof capsule?.task_id === "string" && ["active", "blocked"].includes(String(capsuleTask?.status || ""))
      ? capsule.task_id
      : typeof args.task_id === "string"
      ? args.task_id
      : toolName === "agent_task" && typeof args.id === "string"
        ? (["finish", "cancel", "abandon", "archive"].includes(String(args.action || "")) ? undefined : args.id)
        : typeof task?.id === "string" && ["active", "blocked"].includes(String(task.status || ""))
          ? task.id
          : typeof loop?.task_id === "string" && String(loop.status || "") === "active"
            ? loop.task_id
            : undefined,
    coding_loop_id: typeof capsule?.coding_loop_id === "string" && String(capsuleLoop?.status || "") === "active"
      ? capsule.coding_loop_id
      : toolName === "coding_loop" && typeof args.id === "string"
      ? (["finish", "rollback", "abandon", "archive", "cleanup"].includes(String(args.action || "")) ? undefined : args.id)
      : typeof loop?.id === "string" && String(loop.status || "") === "active"
        ? loop.id
        : typeof args.coding_loop_id === "string"
          ? args.coding_loop_id
          : undefined,
  };
}

function attachContextCheckpointHint(result: unknown, hint: Record<string, unknown>): unknown {
  if (!result || typeof result !== "object") return result;
  const typed = result as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
  const structured = typed.structuredContent;
  if (!structured || typeof structured.data !== "object" || structured.data === null) return result;
  structured.data = { ...(structured.data as Record<string, unknown>), context_checkpoint_hint: hint };
  const textItem = typed.content?.find((item) => item.type === "text");
  if (textItem) textItem.text = JSON.stringify(structured, null, 2);
  return result;
}

function runtimeDomainOutcome(result: unknown): {
  domain_ok: boolean | null;
  verification_passed?: boolean | null;
  failure_category?: string;
  timed_out?: boolean;
} {
  if (!result || typeof result !== "object") return { domain_ok: null };
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return { domain_ok: null };
  const payload = structured as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : {};
  const verificationPassed =
    typeof data.verification_passed === "boolean" ? data.verification_passed : undefined;
  const failure = data.failure && typeof data.failure === "object"
    ? data.failure as Record<string, unknown>
    : undefined;
  const failureCategory = failure && typeof failure.category === "string"
    ? failure.category
    : undefined;
  const timedOut = data.timed_out === true ||
    (Array.isArray(data.results) && data.results.some((item) =>
      item && typeof item === "object" && (item as Record<string, unknown>).timed_out === true
    ));
  const envelopeOk = typeof payload.ok === "boolean" ? payload.ok : null;
  return {
    domain_ok: verificationPassed === false ? false : envelopeOk,
    ...(verificationPassed !== undefined ? { verification_passed: verificationPassed } : {}),
    ...(failureCategory ? { failure_category: failureCategory } : {}),
    ...(timedOut ? { timed_out: true } : {}),
  };
}

function terminalContextAction(toolName: string, input: unknown): { task: boolean; loop: boolean } {
  const action = input && typeof input === "object" && typeof (input as Record<string, unknown>).action === "string"
    ? String((input as Record<string, unknown>).action)
    : "";
  return {
    task: toolName === "agent_task" && ["finish", "cancel", "abandon", "archive"].includes(action),
    loop: toolName === "coding_loop" && ["finish", "rollback", "abandon", "archive", "cleanup"].includes(action),
  };
}

function configureToolRegistration(server: McpServer, workspaceRoot: string, sessionId: string): void {
  const profile = getChatGptToolProfile();
  const contextHeuristic = getContextCapsuleHeuristicConfig();
  let contextWorkspaceHint = workspaceRoot;
  let contextTaskHint: string | undefined;
  let contextLoopHint: string | undefined;
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

    const wrapped = async (...callbackArgs: any[]) => runWithSessionContext(sessionId, async () => {
      const input = callbackArgs[0];
      await bindToolExecutionScope(input, workspaceRoot).catch(() => undefined);
      const path = hookPathFromArguments(input);
      const readOnly = nextConfig.annotations?.readOnlyHint === true;
      const runtimeStartedAt = Date.now();
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
          let result = await (callback as any)(...callbackArgs);
          assertToolResultFitsTransport(toolName, result);
          if (toolName === "context_capsule") {
            const action = input && typeof input === "object" ? (input as Record<string, unknown>).action : undefined;
            const links = contextLinks(toolName, input, result);
            if (links.workspace) contextWorkspaceHint = links.workspace;
            if (links.task_id) contextTaskHint = links.task_id;
            if (links.coding_loop_id) contextLoopHint = links.coding_loop_id;
            if (action === "checkpoint") {
              const sessionState = getCurrentSessionState();
              const budgetWorkspace = links.workspace ||
                (sessionState?.workspace_kind === "project" ? sessionState.project_root || undefined : undefined) ||
                ((contextTaskHint || contextLoopHint) ? contextWorkspaceHint : undefined);
              if (budgetWorkspace) resetContextBudgetWindow(budgetWorkspace);
            }
          } else {
            const currentLinks = contextLinks(toolName, input, result);
            if (currentLinks.workspace) contextWorkspaceHint = currentLinks.workspace;
            if (currentLinks.task_id) contextTaskHint = currentLinks.task_id;
            if (currentLinks.coding_loop_id) contextLoopHint = currentLinks.coding_loop_id;
            const sessionState = getCurrentSessionState();
            const budgetWorkspace = currentLinks.workspace ||
              (sessionState?.workspace_kind === "project" ? sessionState.project_root || undefined : undefined) ||
              ((contextTaskHint || contextLoopHint) ? contextWorkspaceHint : undefined);
            const budget = budgetWorkspace
              ? recordContextBudgetActivity(budgetWorkspace, serializedBytes(result), contextHeuristic)
              : null;
            const budgetDue = budget?.due ?? false;
            const boundary = phaseBoundary(toolName, input);
            if (budgetDue || boundary) {
              const links = {
                task_id: currentLinks.task_id || contextTaskHint,
                coding_loop_id: currentLinks.coding_loop_id || contextLoopHint,
              };
              const reason = budgetDue
                ? `context budget: ${budget?.tool_calls || 0} tool calls / ${budget?.result_bytes || 0} result bytes`
                : `phase boundary: ${toolName}`;
              let capsule = null;
              let checkpointError: string | undefined;
              const checkpointWorkspace = currentLinks.workspace || budgetWorkspace || contextWorkspaceHint;
              try {
                capsule = await autoCheckpointContextCapsule({
                  workspace: checkpointWorkspace,
                  reason,
                  ...links,
                });
                // Auto checkpointing deliberately deduplicates identical machine
                // state. A deduped disk write must still consume the context
                // budget cycle and emit the semantic checkpoint / rollover hint,
                // so recover only the exact active task/loop capsule without
                // invoking manual workspace-level resume ambiguity rules.
                if (!capsule && budgetDue) {
                  capsule = await getAutoCheckpointContextCapsule({
                    workspace: checkpointWorkspace,
                    ...links,
                  });
                }
              } catch (error) {
                checkpointError = error instanceof Error ? error.message : String(error);
              }
              if (capsule) {
                if (budgetWorkspace) resetContextBudgetWindow(budgetWorkspace);
                if (budgetDue) {
                  const contextBudgetCycles = budgetWorkspace
                    ? incrementContextBudgetCycle(budgetWorkspace)
                    : 1;
                  const rolloverRecommended = contextBudgetCycles >= contextHeuristic.rollover_cycles;
                  result = attachContextCheckpointHint(result, {
                    due: true,
                    capsule_id: capsule.id,
                    reason,
                    budget_cycles: contextBudgetCycles,
                    rollover_recommended: rolloverRecommended,
                    instruction: rolloverRecommended
                      ? "Machine state was auto-snapshotted. Save a semantic context_capsule checkpoint now. This chat has accumulated several bounded context cycles; at the next safe boundary, use a fresh ChatGPT chat and resume the capsule because Local Coder cannot erase the host conversation history in place."
                      : "Machine state was auto-snapshotted. Call context_capsule action=checkpoint with a compact semantic summary/decisions/findings/next_steps before more long tool work.",
                  });
                }
              } else if (checkpointError) {
                result = attachContextCheckpointHint(result, {
                  due: budgetDue,
                  snapshot_failed: true,
                  reason,
                  error: checkpointError,
                  instruction: "The primary tool succeeded, but Local Coder could not persist its automatic context snapshot. Save a semantic context_capsule checkpoint before more long tool work and inspect the state-directory error if checkpointing also fails.",
                });
              } else if (budgetDue) {
                // No active task/loop means there is nothing durable to snapshot.
                // Start a fresh budget window instead of retrying the same no-op
                // checkpoint on every later tool call.
                if (budgetWorkspace) resetContextBudgetWindow(budgetWorkspace);
              } else if (boundary && budgetWorkspace) {
                resetContextBudgetWindow(budgetWorkspace);
              }
            }
            const terminal = terminalContextAction(toolName, input);
            if (terminal.task) contextTaskHint = undefined;
            if (terminal.loop) contextLoopHint = undefined;
          }
          await runLocalHooks("post_tool_use", {
            ...common,
            result: boundedHookValue(result, 50_000),
          }).catch(() => undefined);
          const resultBytes = serializedBytes(result);
          finishToolCall(runtimeCallId, "ok", undefined, resultBytes);
          const sessionState = getCurrentSessionState();
          await audit({
            tool: toolName,
            action: "__runtime",
            target: sessionState?.project_root || path || undefined,
            status: "ok",
            details: {
              tool_ok: true,
              duration_ms: Math.max(0, Date.now() - runtimeStartedAt),
              result_bytes: resultBytes,
              project_root: sessionState?.project_root || null,
              workspace_kind: sessionState?.workspace_kind || "unbound",
              ...runtimeDomainOutcome(result),
            },
          }).catch(() => undefined);
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
        const sessionState = getCurrentSessionState();
        await audit({
          tool: toolName,
          action: "__runtime",
          target: sessionState?.project_root || path || undefined,
          status: "error",
          details: {
            tool_ok: false,
            domain_ok: null,
            duration_ms: Math.max(0, Date.now() - runtimeStartedAt),
            result_bytes: 0,
            project_root: sessionState?.project_root || null,
            workspace_kind: sessionState?.workspace_kind || "unbound",
            error: error instanceof Error ? error.message : String(error),
          },
        }).catch(() => undefined);
        throw error;
      } finally {
        if (!readOnly) invalidateTextReadCache();
      }
    });

    return original(name, nextConfig as any, wrapped as any);
  }) as typeof server.registerTool;
}

export function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string,
  sessionId = "legacy"
): McpServer {
  ensureSessionRuntimeState(sessionId, workspaceRoot);
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

  configureToolRegistration(server, workspaceRoot, sessionId);

  registerFilesystemTools(server);
  registerShellTools(server, workspaceRoot, shellTimeout, sessionId);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerNodeReplTool(server, workspaceRoot);
  registerPonytailTurnTool(server);
  registerAgentTaskTool(server, workspaceRoot);
  registerAgentRuntimeTools(server, workspaceRoot);
  registerRepositoryIntelligenceTool(server, workspaceRoot);
  registerEditTransactionTool(server, workspaceRoot);
  registerCodingLoopTools(server, workspaceRoot);
  registerContextCapsuleTool(server, workspaceRoot);
  registerImageTools(server);
  registerLspTool(server, workspaceRoot);
  registerPtyTool(server, workspaceRoot);
  registerSubagentTool(server, workspaceRoot);
  registerDelegateTools(server);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    registerComputerUseTools(server, upstreamManager);
    upstreamManager.registerMcpServer(server);
  }

  return server;
}
