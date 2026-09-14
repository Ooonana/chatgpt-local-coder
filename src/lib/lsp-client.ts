import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";

export type LspServerId = "typescript" | "pyright" | "clangd" | "rust-analyzer" | "gopls";

interface LspServerDefinition {
  id: LspServerId;
  executable: string;
  args: string[];
  extensions: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DiagnosticsWaiter {
  resolve: (diagnostics: unknown[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SERVER_DEFINITIONS: LspServerDefinition[] = [
  {
    id: "typescript",
    executable: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  {
    id: "pyright",
    executable: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
  },
  {
    id: "clangd",
    executable: "clangd",
    args: [],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
  },
  {
    id: "rust-analyzer",
    executable: "rust-analyzer",
    args: [],
    extensions: [".rs"],
  },
  {
    id: "gopls",
    executable: "gopls",
    args: [],
    extensions: [".go"],
  },
];

const LANGUAGE_ID_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".rs": "rust",
  ".go": "go",
};

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sessions = new Map<string, LspClient>();

function localBinPath(executable: string): string | null {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(PACKAGE_ROOT, "node_modules", ".bin", `${executable}${suffix}`);
  return fs.existsSync(candidate) ? candidate : null;
}

function pathExecutable(executable: string): string | null {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [executable], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
}

export function resolveLspExecutable(executable: string): string | null {
  return localBinPath(executable) || pathExecutable(executable);
}

function resolveServerLaunch(definition: LspServerDefinition): { command: string; args: string[] } | null {
  if (definition.id === "typescript") {
    const entry = path.join(PACKAGE_ROOT, "node_modules", "typescript-language-server", "lib", "cli.mjs");
    if (fs.existsSync(entry)) return { command: process.execPath, args: [entry, ...definition.args] };
  }
  if (definition.id === "pyright") {
    const entry = path.join(PACKAGE_ROOT, "node_modules", "pyright", "langserver.index.js");
    if (fs.existsSync(entry)) return { command: process.execPath, args: [entry, ...definition.args] };
  }
  const command = resolveLspExecutable(definition.executable);
  return command ? { command, args: definition.args } : null;
}

export function languageIdForPath(filePath: string): string {
  return LANGUAGE_ID_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "plaintext";
}

export function chooseLspServer(filePath: string, requested: LspServerId | "auto" = "auto") {
  const extension = path.extname(filePath).toLowerCase();
  const definition = requested === "auto"
    ? SERVER_DEFINITIONS.find((item) => item.extensions.includes(extension))
    : SERVER_DEFINITIONS.find((item) => item.id === requested);
  if (!definition) return null;
  const launch = resolveServerLaunch(definition);
  return launch ? { ...definition, ...launch } : { ...definition, command: null, args: definition.args };
}

export function getLspServerStatus(filePath?: string) {
  const extension = filePath ? path.extname(filePath).toLowerCase() : null;
  return SERVER_DEFINITIONS.map((definition) => {
    const launch = resolveServerLaunch(definition);
    return {
      id: definition.id,
      executable: definition.executable,
      available: Boolean(launch),
      resolved_command: launch?.command ?? null,
      resolved_args: launch?.args ?? null,
      handles_file: extension ? definition.extensions.includes(extension) : null,
      extensions: definition.extensions,
    };
  });
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function hasWorkspaceMarker(dir: string): Promise<boolean> {
  for (const marker of [".git", "package.json", "tsconfig.json", "jsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod", "compile_commands.json"]) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  return false;
}

export async function inferLspWorkspace(filePath: string, fallback: string): Promise<string> {
  let dir = path.dirname(filePath);
  let nearest: string | null = null;
  while (true) {
    if (await hasWorkspaceMarker(dir)) {
      nearest = dir;
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (nearest) return nearest;
  return (await isDirectory(fallback)) ? fallback : path.dirname(filePath);
}

class LspClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnostics = new Map<string, unknown[]>();
  private diagnosticWaiters = new Map<string, DiagnosticsWaiter[]>();
  private openVersions = new Map<string, number>();
  private stderr = "";
  private initialized = false;

  constructor(
    readonly serverId: LspServerId,
    readonly command: string,
    readonly args: string[],
    readonly workspace: string
  ) {}

  async start(): Promise<void> {
    if (this.initialized && this.child) return;
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.command);
    const child = spawn(this.command, this.args, {
      cwd: this.workspace,
      windowsHide: true,
      shell,
      env: process.env,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-20000);
    });
    child.on("exit", (code, signal) => {
      this.initialized = false;
      this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`LSP server ${this.serverId} exited (${code ?? "?"}/${signal ?? "?"}). ${this.stderr}`.trim()));
      }
      this.pending.clear();
    });
    child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "chatgpt-local-coder", version: "1.0.0" },
      rootUri: pathToFileURL(this.workspace).href,
      workspaceFolders: [{ uri: pathToFileURL(this.workspace).href, name: path.basename(this.workspace) }],
      initializationOptions: this.serverId === "typescript"
        ? {
            tsserver: {
              fallbackPath: path.join(PACKAGE_ROOT, "node_modules", "typescript-lsp", "lib", "tsserver.js"),
            },
          }
        : undefined,
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
      },
    }, 20000);
    this.notify("initialized", {});
    this.initialized = true;
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error(`LSP server ${this.serverId} stdin is not writable`);
    const json = JSON.stringify(message);
    const bytes = Buffer.byteLength(json, "utf8");
    this.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  }

  private request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // Ignore malformed server output; stderr is returned in status/errors.
      }
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      const method = message.method;
      if (method === "textDocument/publishDiagnostics") {
        const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined;
        if (params?.uri) {
          const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
          this.diagnostics.set(params.uri, diagnostics);
          const waiters = this.diagnosticWaiters.get(params.uri) || [];
          this.diagnosticWaiters.delete(params.uri);
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(diagnostics);
          }
        }
      }
      if (message.id !== undefined) void this.handleServerRequest(message);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as { message?: string; code?: number };
        pending.reject(new Error(`LSP error ${error.code ?? ""}: ${error.message ?? JSON.stringify(error)}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const method = String(message.method);
    const id = message.id;
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = (message.params as { items?: unknown[] } | undefined)?.items;
      result = Array.isArray(items) ? items.map(() => null) : [];
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.workspace).href, name: path.basename(this.workspace) }];
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Local Coder LSP integration is read-only" };
    }
    this.send({ jsonrpc: "2.0", id, result });
  }

  async openDocument(filePath: string): Promise<string> {
    await this.start();
    const uri = pathToFileURL(filePath).href;
    const text = await fsp.readFile(filePath, "utf8");
    const languageId = languageIdForPath(filePath);
    const previous = this.openVersions.get(uri);
    this.diagnostics.delete(uri);
    if (previous === undefined) {
      this.openVersions.set(uri, 1);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else {
      const version = previous + 1;
      this.openVersions.set(uri, version);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  requestAt(method: string, uri: string, line: number, column: number, extra: Record<string, unknown> = {}) {
    return this.request(method, {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
      ...extra,
    });
  }

  requestDocument(method: string, uri: string) {
    return this.request(method, { textDocument: { uri } });
  }

  requestWorkspace(method: string, params: unknown) {
    return this.request(method, params);
  }

  waitForDiagnostics(uri: string, timeoutMs = 1500): Promise<unknown[]> {
    const existing = this.diagnostics.get(uri);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.diagnosticWaiters.get(uri) || [];
        this.diagnosticWaiters.set(uri, waiters.filter((waiter) => waiter.resolve !== resolve));
        resolve(this.diagnostics.get(uri) || []);
      }, timeoutMs);
      timer.unref?.();
      const waiters = this.diagnosticWaiters.get(uri) || [];
      waiters.push({ resolve, timer });
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  status() {
    return {
      server: this.serverId,
      command: this.command,
      args: this.args,
      workspace: this.workspace,
      running: Boolean(this.child),
      initialized: this.initialized,
      pid: this.child?.pid ?? null,
      open_documents: this.openVersions.size,
      stderr_tail: this.stderr.slice(-4000),
    };
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      if (this.initialized) await this.request("shutdown", null, 3000);
    } catch {}
    try {
      this.notify("exit", null);
    } catch {}
    const child = this.child;
    this.child = null;
    this.initialized = false;
    setTimeout(() => child.kill(), 250).unref?.();
  }
}

export async function getLspClient(
  filePath: string,
  fallbackWorkspace: string,
  requested: LspServerId | "auto" = "auto",
  workspaceOverride?: string
): Promise<LspClient> {
  const selected = chooseLspServer(filePath, requested);
  if (!selected) throw new Error(`No known language server for ${path.extname(filePath) || "this file type"}`);
  if (!selected.command) {
    throw new Error(`Language server '${selected.id}' is not installed or not on PATH (${selected.executable})`);
  }
  const workspace = workspaceOverride || await inferLspWorkspace(filePath, fallbackWorkspace);
  const key = `${selected.id}\0${workspace}\0${selected.command}`;
  let client = sessions.get(key);
  if (!client) {
    client = new LspClient(selected.id, selected.command, selected.args, workspace);
    sessions.set(key, client);
  }
  await client.start();
  return client;
}

export function activeLspSessions() {
  return [...sessions.values()].map((client) => client.status());
}

export async function shutdownLspSessions(server?: LspServerId): Promise<number> {
  let stopped = 0;
  for (const [key, client] of sessions) {
    if (server && client.serverId !== server) continue;
    await client.shutdown();
    sessions.delete(key);
    stopped++;
  }
  return stopped;
}
