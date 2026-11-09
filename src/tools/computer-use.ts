import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import {
  COMPUTER_USE_PROVIDER_IDS,
  allowedComputerUseTools,
  validateComputerUseTool,
  type ComputerUseProvider,
} from "../lib/computer-use-policy.js";
import { requireUnsafeRuntimeAllowed, requireWriteAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolResult } from "../lib/tool-result.js";

type UpstreamResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
};

function summarizeUpstream(raw: unknown) {
  const result = (raw ?? {}) as UpstreamResult;
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
  } catch {}
  const payload = result.structuredContent ?? envelope;
  const nested = payload?.response && typeof payload.response === "object"
    ? payload.response as Record<string, unknown> : null;
  const successful = result.isError !== true &&
    payload?.ok !== false && nested?.ok !== false &&
    (typeof payload?.exitCode !== "number" || payload.exitCode === 0);
  // Upstream failures include delivery metadata. Never retry uncertain delivery.
  const error = payload?.error && typeof payload.error === "object"
    ? payload.error as Record<string, unknown> : null;
  const disposition = error?.disposition && typeof error.disposition === "object"
    ? error.disposition as Record<string, unknown> : null;
  const retrySafe = !successful &&
    disposition?.delivery === "not_delivered" && disposition?.retry === "safe";
  const asText = JSON.stringify(payload ?? text);
  return {
    ok: successful,
    retrySafe,
    payload,
    text: asText.slice(0, 60_000),
    truncated: asText.length > 60_000,
    images: (result.content ?? []).filter((item) => item.type === "image"),
  };
}

function mustEnableProvider(manager: McpUpstreamManager, provider: ComputerUseProvider): string {
  const serverId = COMPUTER_USE_PROVIDER_IDS[provider];
  const config = manager.getServerConfig(serverId);
  if (!config?.enabled || config.transport !== "stdio") {
    throw new Error(provider + " computer-use MCP is not enabled. Add and review the Vercel preset in Admin UI first.");
  }
  return serverId;
}

export function registerComputerUseTools(server: McpServer, manager: McpUpstreamManager): void {
  const providerSchema = z.enum(["desktop", "browser"]);
  const argumentSchema = z.record(z.string(), z.unknown()).optional().default({});
  // Qualified accessibility refs are tied to the window-scoped observation
  // that returned them, not to an unrelated caller-supplied verification target.
  // This registry is local to the MCP session; refs expire and are invalidated
  // after every desktop input to avoid acting on stale UI state.
  const observedRefs = new Map<string, { windowId: string; capturedAt: number }>();
  const REF_TTL_MS = 60_000;
  function rememberWindowRefs(payload: Record<string, unknown> | null | undefined, windowId: string): void {
    const data = payload?.data as Record<string, unknown> | undefined;
    if (!data?.tree) return;
    const now = Date.now();
    for (const [ref, entry] of observedRefs) {
      if (now - entry.capturedAt >= REF_TTL_MS) observedRefs.delete(ref);
    }
    let visited = 0;
    function visit(node: unknown): void {
      if (++visited > 5000 || !node || typeof node !== "object") return;
      const item = node as { ref_id?: unknown; children?: unknown };
      if (typeof item.ref_id === "string" && /^@[^\s:]+:e\d+$/.test(item.ref_id)) {
        observedRefs.set(item.ref_id, { windowId, capturedAt: now });
      }
      if (Array.isArray(item.children)) for (const child of item.children) visit(child);
    }
    visit(data.tree);
    while (observedRefs.size > 5000) observedRefs.delete(observedRefs.keys().next().value!);
  }
  server.registerTool(
    "computer_observe",
    {
      title: "Observe Desktop or Browser",
      description: "Read accessible Windows UI or browser state through installed Vercel MCP providers. Use tool=desktop_snapshot/desktop_list_windows or agent_browser_snapshot. Never modifies UI.",
      inputSchema: {
        provider: providerSchema,
        tool: z.string().optional().describe("Allowed observation tool; omit to list supported tools and provider status"),
        arguments: argumentSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ provider, tool, arguments: args }) => {
      const serverId = COMPUTER_USE_PROVIDER_IDS[provider];
      const config = manager.getServerConfig(serverId);
      if (!tool) {
        return toolResult("computer_observe", {
          provider,
          configured: Boolean(config),
          enabled: Boolean(config?.enabled),
          tools: allowedComputerUseTools(provider, "observe"),
          note: "An enabled provider is necessary to observe live UI.",
        });
      }
      validateComputerUseTool(provider, "observe", tool, args);
      // A read-only filesystem sandbox must not implicitly expose all windows,
      // pages and screenshots from the user's interactive desktop.
      requireUnsafeRuntimeAllowed("desktop/browser observation");
      mustEnableProvider(manager, provider);
      const advertised = await manager.listTools(serverId);
      if (!advertised.some((item) => item.name === tool)) throw new Error("Unsupported upstream observation tool: " + tool);
      const result = summarizeUpstream(await manager.callTool(serverId, tool, args));
      if (provider === "desktop" && tool === "desktop_snapshot" && result.ok &&
        typeof args.window_id === "string") {
        rememberWindowRefs(result.payload, args.window_id);
      }
      await audit({ tool: "computer_observe", action: tool, target: provider, status: result.ok ? "ok" : "error" });
      const output = toolResult("computer_observe", {
        provider, tool, output: result.text, truncated: result.truncated,
      }, { ok: result.ok, summary: result.ok ? provider + " observation complete" : provider + " observation failed" });
      // Preserve image content from screenshots without duplicating base64 inside JSON.
      return { ...output, content: [...output.content, ...result.images] } as typeof output;
    }
  );

  server.registerTool(
    "computer_act",
    {
      title: "Act on Desktop or Browser",
      description: "Explicitly authorized computer interaction through Vercel MCP. Requires allow_input=true. Optional expected_text verifies resulting UI via a fresh accessibility/DOM snapshot; a failed action is never blindly retried.",
      inputSchema: {
        provider: providerSchema,
        tool: z.string().min(1).describe("Allowed input/navigation tool"),
        arguments: argumentSchema,
        allow_input: z.boolean().optional().default(false).describe("Must be true for actual user-visible interaction"),
        expected_text: z.string().max(1000).optional().describe("Optional text expected in a new post-action snapshot"),
        verification_target: z.object({
          app: z.string().min(1).max(200).optional(),
          window_id: z.string().min(1).max(200).optional(),
        }).optional().describe("Desktop window_id must match a previously observed window-scoped snapshot for input by ref"),
        safe_retries: z.number().int().min(0).max(1).optional().default(0).describe("Retry only when upstream confirms the action was NOT delivered and retry is safe"),
        screenshot_on_failure: z.boolean().optional().default(false),
      },
      // Computer input changes external state, so never mark it auto-approved.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ provider, tool, arguments: args, allow_input, expected_text, verification_target, safe_retries, screenshot_on_failure }) => {
      if (!allow_input) throw new Error("Computer input requires allow_input=true and user authorization");
      requireWriteAllowed();
      requireUnsafeRuntimeAllowed("computer-use input");
      validateComputerUseTool(provider, "act", tool, args);
      if (provider === "desktop") {
        if ((expected_text || screenshot_on_failure) && !verification_target?.window_id) {
          throw new Error("Desktop verification/screenshot requires verification_target.window_id");
        }
        if (tool !== "desktop_wait" && !verification_target?.window_id) {
          throw new Error("Desktop input requires verification_target.window_id from a window-scoped snapshot");
        }
        if (tool === "desktop_focus_window") {
          if (args.window_id !== verification_target?.window_id) {
            throw new Error("Desktop focus target must match verification_target.window_id");
          }
        } else if (tool !== "desktop_wait") {
          const ref = args.ref_id;
          const binding = typeof ref === "string" ? observedRefs.get(ref) : undefined;
          if (!binding || binding.windowId !== verification_target?.window_id ||
            Date.now() - binding.capturedAt >= REF_TTL_MS) {
            throw new Error("Desktop ref_id is not bound to the specified window; call computer_observe desktop_snapshot with window_id first");
          }
        }
      }
      if (provider === "browser" && verification_target) {
        throw new Error("verification_target is only supported for desktop actions");
      }
      const serverId = mustEnableProvider(manager, provider);
      const available = await manager.listTools(serverId);
      if (!available.some((item) => item.name === tool)) throw new Error("Unsupported upstream input tool: " + tool);

      let outcome = summarizeUpstream(await manager.callTool(serverId, tool, args));
      let attempts = 1;
      if (!outcome.ok && safe_retries > 0 && outcome.retrySafe) {
        outcome = summarizeUpstream(await manager.callTool(serverId, tool, args));
        attempts += 1;
      }
      if (provider === "desktop" && tool !== "desktop_wait") observedRefs.clear();
      let verification: { checked: boolean; passed: boolean | null; snapshot: string; error?: string } = {
        checked: false, passed: null, snapshot: "",
      };
      let screenshot: ReturnType<typeof summarizeUpstream> | undefined;
      if (outcome.ok && expected_text) {
        const snapshotTool = provider === "desktop" ? "desktop_snapshot" : "agent_browser_snapshot";
        const snapshotArgs = provider === "desktop" ? { ...verification_target } : {};
        try {
          const observed = summarizeUpstream(await manager.callTool(serverId, snapshotTool, snapshotArgs));
          verification = {
            checked: true,
            passed: observed.ok && observed.text.includes(expected_text),
            snapshot: observed.text.slice(0, 20_000),
          };
        } catch (error) {
          verification = {
            checked: true, passed: false, snapshot: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (screenshot_on_failure && (!outcome.ok || verification.passed === false)) {
        try {
          screenshot = summarizeUpstream(await manager.callTool(
            serverId,
            provider === "desktop" ? "desktop_screenshot" : "agent_browser_screenshot",
            provider === "desktop" ? { ...verification_target } : {},
          ));
        } catch {}
      }
      const success = outcome.ok && verification.passed !== false;
      await audit({ tool: "computer_act", action: tool, target: provider, status: success ? "ok" : "error",
        details: { verified: verification.passed, screenshot_fallback: Boolean(screenshot), attempts } });
      const output = toolResult("computer_act", {
        provider, tool, action_output: outcome.text, attempts,
        verification, screenshot_fallback: screenshot ? screenshot.text.slice(0, 4000) : null,
      }, {
        ok: success,
        summary: !outcome.ok ? (attempts > 1 ? "Computer action failed after one safe retry" : "Computer action failed; not retried") :
          verification.passed === false ? "Action completed but expected state was not verified" :
            expected_text ? "Computer action verified" : "Computer action sent; no expected state provided",
      });
      return { ...output, content: [...output.content, ...(screenshot?.images ?? [])] } as typeof output;
    }
  );
}