import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getLspClient, type LspServerId } from "./lsp-client.js";
import { isPathInside } from "./path-identity.js";

export type RepoIntelAction = "symbol_search" | "references" | "impact";

export interface RepoIntelLocation {
  path: string;
  line: number;
  column: number;
  end_line?: number;
  end_column?: number;
  name?: string;
  kind?: number | string;
  preview?: string;
}

export interface RepoIntelResult {
  action: RepoIntelAction;
  mode: "semantic" | "lexical";
  workspace: string;
  query: string;
  symbol?: RepoIntelLocation | null;
  definitions?: RepoIntelLocation[];
  references?: RepoIntelLocation[];
  affected_files?: Array<{ path: string; references: number }>;
  total_references?: number;
  matches?: RepoIntelLocation[];
  truncated: boolean;
  fallback_reason?: string;
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".c", ".h", ".cc", ".cpp", ".cxx",
  ".hpp", ".hh", ".rs", ".go", ".java", ".kt", ".kts", ".cs", ".swift", ".rb", ".php", ".vue", ".svelte",
]);
const SKIP_DIRS = new Set([".git", "node_modules", ".mcp-state", "dist", "build", "coverage", ".next"]);
const MAX_SCAN_FILES = 12_000;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function canonicalPath(inputPath: string): Promise<string> {
  return path.resolve(await fs.realpath(path.resolve(inputPath)));
}

export async function assertRepositoryPathInsideWorkspace(workspace: string, filePath: string): Promise<void> {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedFile = path.resolve(filePath);
  if (!isPathInside(resolvedWorkspace, resolvedFile)) {
    throw new Error(`Repository path is outside selected workspace: ${resolvedFile}`);
  }
  const [canonicalWorkspace, canonicalFile] = await Promise.all([
    canonicalPath(resolvedWorkspace),
    canonicalPath(resolvedFile),
  ]);
  if (!isPathInside(canonicalWorkspace, canonicalFile)) {
    throw new Error(`Repository path escapes selected workspace through a symlink/junction: ${resolvedFile}`);
  }
}

async function filterLocationsToWorkspace(workspace: string, locations: RepoIntelLocation[]): Promise<RepoIntelLocation[]> {
  const out: RepoIntelLocation[] = [];
  for (const location of locations) {
    try {
      await assertRepositoryPathInsideWorkspace(workspace, location.path);
      out.push(location);
    } catch {
      // Language servers can report dependency/project-reference locations
      // outside the selected repository. Repository intelligence must never
      // preview those paths implicitly.
    }
  }
  return out;
}

function locationFromUri(uri: string): string | null {
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
    if (path.isAbsolute(uri)) return uri;
  } catch {}
  return null;
}

function normalizeLocation(value: unknown, inherited?: { name?: string; kind?: number | string }): RepoIntelLocation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, any>;
  const location = record.location && typeof record.location === "object" ? record.location : record;
  const uri = typeof location.uri === "string" ? location.uri : typeof record.uri === "string" ? record.uri : null;
  const range = location.range || record.range || record.selectionRange;
  const resolved = uri ? locationFromUri(uri) : null;
  if (!resolved || !range?.start) return null;
  return {
    path: resolved,
    line: Number(range.start.line ?? 0) + 1,
    column: Number(range.start.character ?? 0) + 1,
    end_line: range.end ? Number(range.end.line ?? 0) + 1 : undefined,
    end_column: range.end ? Number(range.end.character ?? 0) + 1 : undefined,
    name: typeof record.name === "string" ? record.name : inherited?.name,
    kind: record.kind ?? inherited?.kind,
  };
}

function collectSymbolLocations(value: unknown, maxResults: number): RepoIntelLocation[] {
  const out: RepoIntelLocation[] = [];
  const visit = (item: unknown, inherited?: { name?: string; kind?: number | string }) => {
    if (out.length >= maxResults || !item) return;
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, inherited);
        if (out.length >= maxResults) break;
      }
      return;
    }
    if (typeof item !== "object") return;
    const record = item as Record<string, any>;
    const current = {
      name: typeof record.name === "string" ? record.name : inherited?.name,
      kind: record.kind ?? inherited?.kind,
    };
    const normalized = normalizeLocation(record, current);
    if (normalized) out.push(normalized);
    if (Array.isArray(record.children)) visit(record.children, current);
  };
  visit(value);
  return out.slice(0, maxResults);
}

async function previewLine(filePath: string, line: number): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) return undefined;
    const lines = (await fs.readFile(filePath, "utf-8")).split(/\r?\n/);
    return lines[line - 1]?.trim().slice(0, 500);
  } catch {
    return undefined;
  }
}

async function withPreviews(locations: RepoIntelLocation[], maxResults: number): Promise<RepoIntelLocation[]> {
  const bounded = locations.slice(0, maxResults);
  return Promise.all(bounded.map(async (location) => ({ ...location, preview: await previewLine(location.path, location.line) })));
}

async function identifierAtPosition(filePath: string, line: number, column: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Repository intelligence path is not a regular file");
  if (stat.size > MAX_SCAN_FILE_BYTES) {
    throw new Error(`Repository intelligence position lookup is limited to ${MAX_SCAN_FILE_BYTES} bytes per file`);
  }
  const text = await fs.readFile(filePath, "utf-8");
  const row = text.split(/\r?\n/)[line - 1] || "";
  const index = Math.max(0, Math.min(row.length, column - 1));
  const isIdent = (ch: string) => /[A-Za-z0-9_$]/.test(ch || "");
  let start = index;
  if (!isIdent(row[start]) && start > 0 && isIdent(row[start - 1])) start--;
  let left = start;
  let right = start;
  while (left > 0 && isIdent(row[left - 1])) left--;
  while (right < row.length && isIdent(row[right])) right++;
  const identifier = row.slice(left, right);
  if (!identifier) throw new Error("Could not infer an identifier at the requested position");
  return identifier;
}

async function lexicalSearch(root: string, query: string, maxResults: number): Promise<RepoIntelLocation[]> {
  const results: RepoIntelLocation[] = [];
  const simpleIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query);
  const regex = new RegExp(simpleIdentifier ? `\\b${escapeRegex(query)}\\b` : escapeRegex(query), "i");
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults || scanned >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults || scanned >= MAX_SCAN_FILES) break;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      scanned++;
      let text: string;
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) continue;
        text = await fs.readFile(full, "utf-8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const match = regex.exec(lines[index]);
        if (!match) continue;
        results.push({
          path: full,
          line: index + 1,
          column: (match.index || 0) + 1,
          name: query,
          preview: lines[index].trim().slice(0, 500),
        });
        if (results.length >= maxResults) break;
      }
    }
  }

  await walk(root);
  return results;
}

function groupAffectedFiles(locations: RepoIntelLocation[], maxFiles: number): Array<{ path: string; references: number }> {
  const counts = new Map<string, number>();
  for (const location of locations) counts.set(location.path, (counts.get(location.path) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxFiles)
    .map(([filePath, references]) => ({ path: filePath, references }));
}

function mergeLocations(primary: RepoIntelLocation[], supplemental: RepoIntelLocation[], maxResults: number): RepoIntelLocation[] {
  const seen = new Set<string>();
  const out: RepoIntelLocation[] = [];
  for (const location of [...primary, ...supplemental]) {
    const key = `${path.resolve(location.path).toLowerCase()}:${location.line}:${location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(location);
    if (out.length >= maxResults) break;
  }
  return out;
}

async function semanticSymbolSearch(
  workspace: string,
  query: string,
  defaultCwd: string,
  requestedServer: LspServerId | "auto",
  maxResults: number,
  hintFile?: string
): Promise<{ matches: RepoIntelLocation[]; clientServer: string }> {
  const target = hintFile || workspace;
  const client = await getLspClient(target, defaultCwd, requestedServer, workspace);
  const raw = await client.requestWorkspace("workspace/symbol", { query });
  const matches = await filterLocationsToWorkspace(workspace, collectSymbolLocations(raw, maxResults));
  return { matches: await withPreviews(matches, maxResults), clientServer: client.status().server };
}

async function resolveSemanticSymbol(
  workspace: string,
  query: string | undefined,
  filePath: string | undefined,
  line: number | undefined,
  column: number | undefined,
  defaultCwd: string,
  requestedServer: LspServerId | "auto",
  maxResults: number
): Promise<{ client: Awaited<ReturnType<typeof getLspClient>>; symbol: RepoIntelLocation; query: string }> {
  if (filePath && line && column) {
    await assertRepositoryPathInsideWorkspace(workspace, filePath);
    const client = await getLspClient(filePath, defaultCwd, requestedServer, workspace);
    const uri = await client.openDocument(filePath);
    const inferred = query?.trim() || await identifierAtPosition(filePath, line, column);
    return { client, symbol: { path: filePath, line, column, name: inferred }, query: inferred };
  }
  if (!query?.trim()) throw new Error("query or path+line+column is required");
  const searched = await semanticSymbolSearch(workspace, query.trim(), defaultCwd, requestedServer, Math.max(maxResults, 50), filePath);
  const exact = searched.matches.find((item) => item.name === query.trim()) || searched.matches[0];
  if (!exact) throw new Error(`No semantic symbol found for '${query.trim()}'`);
  const client = await getLspClient(exact.path, defaultCwd, requestedServer, workspace);
  await client.openDocument(exact.path);
  return { client, symbol: exact, query: query.trim() };
}

export async function runRepositoryIntelligence(options: {
  action: RepoIntelAction;
  workspace: string;
  defaultCwd: string;
  query?: string;
  path?: string;
  line?: number;
  column?: number;
  includeDeclaration?: boolean;
  server?: LspServerId | "auto";
  maxResults?: number;
}): Promise<RepoIntelResult> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 120, 1), 500);
  const requestedServer = options.server ?? "auto";
  const includeDeclaration = options.includeDeclaration ?? true;
  let query = options.query?.trim() || "";

  try {
    if (options.action === "symbol_search") {
      if (!query) throw new Error("query is required for symbol_search");
      const semantic = await semanticSymbolSearch(
        options.workspace,
        query,
        options.defaultCwd,
        requestedServer,
        maxResults,
        options.path
      );
      if (!semantic.matches.length) throw new Error(`No semantic symbols found for '${query}'`);
      return {
        action: options.action,
        mode: "semantic",
        workspace: options.workspace,
        query,
        matches: semantic.matches,
        truncated: semantic.matches.length >= maxResults,
      };
    }

    const resolved = await resolveSemanticSymbol(
      options.workspace,
      query || undefined,
      options.path,
      options.line,
      options.column,
      options.defaultCwd,
      requestedServer,
      maxResults
    );
    query = resolved.query;
    const uri = await resolved.client.openDocument(resolved.symbol.path);
    const referencesRaw = await resolved.client.requestAt(
      "textDocument/references",
      uri,
      resolved.symbol.line,
      resolved.symbol.column,
      { context: { includeDeclaration } }
    );
    const references = await withPreviews(
      await filterLocationsToWorkspace(options.workspace, collectSymbolLocations(referencesRaw, maxResults)),
      maxResults
    );

    if (options.action === "references") {
      return {
        action: options.action,
        mode: "semantic",
        workspace: options.workspace,
        query,
        symbol: resolved.symbol,
        references,
        total_references: references.length,
        truncated: references.length >= maxResults,
      };
    }

    const definitionsRaw = await resolved.client.requestAt(
      "textDocument/definition",
      uri,
      resolved.symbol.line,
      resolved.symbol.column
    );
    const definitions = await withPreviews(
      await filterLocationsToWorkspace(options.workspace, collectSymbolLocations(definitionsRaw, 20)),
      20
    );
    // Some language servers return only references from documents currently in
    // their project graph. Impact analysis should err toward broader coverage,
    // so merge a bounded lexical identifier scan with the semantic result.
    const lexicalReferences = await lexicalSearch(options.workspace, query, maxResults);
    const impactReferences = mergeLocations(references, lexicalReferences, maxResults);
    return {
      action: options.action,
      mode: "semantic",
      workspace: options.workspace,
      query,
      symbol: resolved.symbol,
      definitions,
      references: impactReferences,
      affected_files: groupAffectedFiles(impactReferences, 100),
      total_references: impactReferences.length,
      truncated: impactReferences.length >= maxResults,
    };
  } catch (semanticError) {
    if (!query && options.path && options.line && options.column) {
      await assertRepositoryPathInsideWorkspace(options.workspace, options.path);
      query = await identifierAtPosition(options.path, options.line, options.column);
    }
    if (!query) throw semanticError;
    const matches = await lexicalSearch(options.workspace, query, maxResults);
    const fallbackReason = semanticError instanceof Error ? semanticError.message : String(semanticError);
    if (options.action === "symbol_search") {
      return {
        action: options.action,
        mode: "lexical",
        workspace: options.workspace,
        query,
        matches,
        truncated: matches.length >= maxResults,
        fallback_reason: fallbackReason,
      };
    }
    if (options.action === "references") {
      return {
        action: options.action,
        mode: "lexical",
        workspace: options.workspace,
        query,
        symbol: options.path && options.line && options.column
          ? { path: options.path, line: options.line, column: options.column, name: query }
          : matches[0] || null,
        references: matches,
        total_references: matches.length,
        truncated: matches.length >= maxResults,
        fallback_reason: fallbackReason,
      };
    }
    return {
      action: options.action,
      mode: "lexical",
      workspace: options.workspace,
      query,
      symbol: options.path && options.line && options.column
        ? { path: options.path, line: options.line, column: options.column, name: query }
        : matches[0] || null,
      definitions: [],
      references: matches,
      affected_files: groupAffectedFiles(matches, 100),
      total_references: matches.length,
      truncated: matches.length >= maxResults,
      fallback_reason: fallbackReason,
    };
  }
}
