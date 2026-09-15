import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { probeDelegates } from "../lib/delegate-registry.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

export function registerDelegateTools(server: McpServer): void {
  server.registerTool(
    "delegate_status",
    {
      title: "Delegate Status",
      description:
        "Detect supported local coding-agent CLIs (Claude, Codex, Grok, OpenCode), their paths/versions, and safe prompt transport mode. Detection is read-only and never starts an agent task.",
      inputSchema: {
        refresh: z.boolean().optional().default(false).describe("Re-probe PATH and versions instead of using the in-process cache"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ refresh }) => {
      const delegates = await probeDelegates(refresh);
      const available = delegates.filter((item) => item.available);
      return toolResult(
        "delegate_status",
        {
          delegates,
          available: available.map((item) => item.id),
          count: available.length,
          note: "Detected CLIs are not run by this tool. The existing subagent tool still requires explicit runner configuration and does not reuse the ChatGPT app subscription.",
        },
        { summary: `${available.length}/${delegates.length} delegate CLI(s) available` }
      );
    }
  );
}
