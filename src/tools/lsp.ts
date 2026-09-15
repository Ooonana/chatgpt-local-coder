import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { boundDiagnosticValue } from "../lib/bounded-value.js";
import {
  activeLspSessions,
  getLspClient,
  getLspServerStatus,
  shutdownLspSessions,
  type LspServerId,
} from "../lib/lsp-client.js";

const serverSchema = z.enum(["auto", "typescript", "pyright", "clangd", "rust-analyzer", "gopls"]);
const actionSchema = z.enum([
  "status",
  "hover",
  "definition",
  "references",
  "document_symbols",
  "workspace_symbols",
  "diagnostics",
  "shutdown",
]);

export function registerLspTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "lsp",
    {
      title: "Language Server Protocol",
      description:
        "Semantic code intelligence using persistent LSP servers. Supports hover, definition, references, document/workspace symbols, and diagnostics. TypeScript/JavaScript and Python servers ship with Local Coder; clangd, rust-analyzer, and gopls are auto-detected if installed. Positions are 1-based.",
      inputSchema: {
        action: actionSchema,
        path: z.string().optional(),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
        query: z.string().max(20_000).optional(),
        include_declaration: z.boolean().optional().default(true),
        server: serverSchema.optional().default("auto"),
        workspace: z.string().optional(),
        diagnostic_wait_ms: z.number().int().min(100).max(5000).optional().default(1500),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ action, path: filePath, line, column, query, include_declaration, server: requestedServer, workspace, diagnostic_wait_ms }) => {
      if (action === "status") {
        const validPath = filePath ? await validatePath(filePath) : undefined;
        return toolResult(
          "lsp",
          {
            action,
            file: validPath ?? null,
            servers: getLspServerStatus(validPath),
            sessions: activeLspSessions(),
          },
          { summary: `${activeLspSessions().length} active LSP session(s)` }
        );
      }

      if (action === "shutdown") {
        const selected = requestedServer === "auto" ? undefined : requestedServer as LspServerId;
        const stopped = await shutdownLspSessions(selected);
        return toolResult("lsp", { action, server: selected ?? "all", stopped }, { summary: `stopped ${stopped} LSP session(s)` });
      }

      if (!filePath && action !== "workspace_symbols") {
        throw new Error(`path is required for LSP action '${action}'`);
      }

      const validFile = filePath ? await validatePath(filePath) : undefined;
      const validWorkspace = workspace ? await validatePath(workspace) : undefined;
      const targetForServer = validFile || validWorkspace;
      if (!targetForServer) throw new Error("path or workspace is required");

      const requested = requestedServer as LspServerId | "auto";
      const client = await getLspClient(targetForServer, defaultCwd, requested, validWorkspace);
      let result: unknown;

      if (action === "workspace_symbols") {
        if (!query?.trim()) throw new Error("query is required for workspace_symbols");
        result = await client.requestWorkspace("workspace/symbol", { query });
      } else {
        const uri = await client.openDocument(validFile!);
        if (action === "diagnostics") {
          result = await client.waitForDiagnostics(uri, diagnostic_wait_ms);
        } else if (action === "document_symbols") {
          result = await client.requestDocument("textDocument/documentSymbol", uri);
        } else {
          if (line === undefined || column === undefined) {
            throw new Error(`line and column are required for LSP action '${action}'`);
          }
          if (action === "hover") {
            result = await client.requestAt("textDocument/hover", uri, line, column);
          } else if (action === "definition") {
            result = await client.requestAt("textDocument/definition", uri, line, column);
          } else {
            result = await client.requestAt("textDocument/references", uri, line, column, {
              context: { includeDeclaration: include_declaration },
            });
          }
        }
      }

      // Language servers can return tens of thousands of references/symbols.
      // Keep semantic results useful while ensuring one pathological server
      // response cannot consume huge memory or hit the MCP tunnel payload cap.
      result = boundDiagnosticValue(result, {
        maxStringChars: 50_000,
        maxArrayItems: 1_000,
        maxObjectKeys: 500,
        maxDepth: 10,
      });

      const status = client.status();
      await audit({
        tool: "lsp",
        action,
        target: validFile || status.workspace,
        status: "ok",
        details: { server: status.server, line, column, query },
      });
      return toolResult(
        "lsp",
        {
          action,
          server: status.server,
          workspace: status.workspace,
          path: validFile ?? null,
          line: line ?? null,
          column: column ?? null,
          result,
        },
        { summary: `${action} via ${status.server}` }
      );
    }
  );
}
