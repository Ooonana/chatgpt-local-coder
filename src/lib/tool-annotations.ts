import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ChatGPT uses tool annotations when deciding whether to request confirmation.
 * When CHATGPT_AUTO_APPROVE=true (default), mark local operations as routine
 * where possible to reduce unnecessary prompts and session resets.
 */
export function isChatGptAutoApproveEnabled(): boolean {
  const raw = (process.env.CHATGPT_AUTO_APPROVE ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export type ToolRisk = "read" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }

  if (isChatGptAutoApproveEnabled()) {
    // Treat write/command/delete operations as routine local edits rather than destructive actions.
    return {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: risk !== "command",
    };
  }

  return {
    readOnlyHint: false,
    destructiveHint: risk === "destructive",
    openWorldHint: false,
    idempotentHint: risk === "edit",
  };
}