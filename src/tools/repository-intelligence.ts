import { z } from "zod";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { assertRepositoryPathInsideWorkspace, runRepositoryIntelligence } from "../lib/repository-intelligence.js";
import type { LspServerId } from "../lib/lsp-client.js";

const serverSchema = z.enum(["auto", "typescript", "pyright", "clangd", "rust-analyzer", "gopls"]);
const actionSchema = z.enum(["symbol_search", "references", "impact"]);

export function registerRepositoryIntelligenceTool(server: McpServer, defaultCwd: string): void {
  server.registerTool(
    "repo_intel",
    {
      title: "Repository Intelligence",
      description:
        "High-level codebase intelligence for regular ChatGPT. Search symbols, find references, or estimate change impact across a repository. Uses LSP semantics first and falls back to bounded lexical search when a language server is unavailable.",
      inputSchema: {
        action: actionSchema,
        workspace: z.string().optional().describe("Repository/workspace root; defaults to Local Coder workspace"),
        query: z.string().max(20_000).optional().describe("Symbol name or search query"),
        path: z.string().optional().describe("Optional source file; required with line+column for position-based references/impact"),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
        include_declaration: z.boolean().optional().default(true),
        server: serverSchema.optional().default("auto"),
        max_results: z.number().int().positive().max(500).optional().default(120),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ action, workspace, query, path: filePath, line, column, include_declaration, server: requestedServer, max_results }) => {
      const root = workspace ? await validatePath(workspace) : defaultCwd;
      const validFile = filePath
        ? await validatePath(path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath))
        : undefined;
      if (validFile) await assertRepositoryPathInsideWorkspace(root, validFile);
      if ((line === undefined) !== (column === undefined)) {
        throw new Error("line and column must be supplied together");
      }
      if ((line !== undefined || column !== undefined) && !validFile) {
        throw new Error("path is required when line/column are supplied");
      }
      if (action === "symbol_search" && !query?.trim()) {
        throw new Error("query is required for symbol_search");
      }
      if (action !== "symbol_search" && !query?.trim() && !(validFile && line && column)) {
        throw new Error("query or path+line+column is required");
      }

      const result = await runRepositoryIntelligence({
        action,
        workspace: root,
        defaultCwd,
        query,
        path: validFile,
        line,
        column,
        includeDeclaration: include_declaration,
        server: requestedServer as LspServerId | "auto",
        maxResults: max_results,
      });
      const count = result.matches?.length ?? result.references?.length ?? 0;
      await audit({
        tool: "repo_intel",
        action,
        target: validFile || root,
        status: "ok",
        details: { query: result.query, mode: result.mode, results: count, affected_files: result.affected_files?.length || 0 },
      });
      return toolResult("repo_intel", result, {
        summary: `${action}: ${count} result(s) via ${result.mode}${result.affected_files ? ` across ${result.affected_files.length} file(s)` : ""}`,
      });
    }
  );
}
