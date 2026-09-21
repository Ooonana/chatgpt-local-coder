import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { refreshProxiedTools } from "./mcp-tool-proxy.js";
import { runCodexSessionStartHooks } from "./codex-hooks.js";
import { runLocalHooks } from "./local-hooks.js";


const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_SSE_KEEPALIVE_MS = 10_000;
function boundedPositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

const SESSION_TTL_MS = boundedPositiveInt(
  process.env.MCP_SESSION_TTL_MS,
  7_200_000,
  60_000,
  7 * 24 * 60 * 60 * 1000
); // default 2h; stale IDs can still be recovered on demand
const CLOSED_SESSION_TTL_MS = boundedPositiveInt(
  process.env.MCP_CLOSED_SESSION_TTL_MS,
  900_000,
  60_000,
  24 * 60 * 60 * 1000
); // default 15m
const SESSION_MAX_RETAINED = boundedPositiveInt(
  process.env.MCP_SESSION_MAX_RETAINED,
  32,
  4,
  256
);
const SESSION_CLEANUP_INTERVAL_MS = boundedPositiveInt(
  process.env.MCP_SESSION_CLEANUP_MS,
  300_000,
  1_000,
  60 * 60 * 1000
); // default 5m
const SESSION_DELETE_GRACE_MS = boundedPositiveInt(
  process.env.MCP_SESSION_DELETE_GRACE_MS,
  45_000,
  1_000,
  5 * 60 * 1000
); // keep session after DELETE so in-flight tool calls can finish
const SESSION_RECOVERY_LOOPBACK_TIMEOUT_MS = boundedPositiveInt(
  process.env.MCP_SESSION_RECOVERY_TIMEOUT_MS,
  10_000,
  1_000,
  60_000
);

export const MCP_SSE_KEEPALIVE_MS = boundedPositiveInt(
  process.env.MCP_SSE_KEEPALIVE_MS,
  DEFAULT_SSE_KEEPALIVE_MS,
  1_000,
  60_000
);

export const MCP_JSON_RESPONSE = ["1", "true", "yes", "on"].includes(
  (process.env.MCP_JSON_RESPONSE || "false").trim().toLowerCase()
);

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

/**
 * Attach Mcp-Session-Id to the request before passing it to the transport.
 *
 * SDK >=1.29 wraps the Node transport around
 * WebStandardStreamableHTTPServerTransport and uses @hono/node-server to convert
 * IncomingMessage -> fetch Request. Hono reads `incoming.rawHeaders`, not
 * `incoming.headers`, so patching req.headers alone has no effect; both must be set.
 */
function withSessionIdHeader(
  req: Request,
  sessionId: string,
  protocolVersion: string
): Request {
  const headers = {
    ...req.headers,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  };
  const drop = new Set(["mcp-session-id", "mcp-protocol-version"]);
  const raw: string[] = [];
  const existing = req.rawHeaders || [];
  for (let i = 0; i < existing.length; i += 2) {
    if (drop.has(existing[i]?.toLowerCase())) continue;
    raw.push(existing[i], existing[i + 1]);
  }
  raw.push("mcp-session-id", sessionId, "mcp-protocol-version", protocolVersion);
  return Object.assign(req, { headers, rawHeaders: raw });
}

/**
 * ChatGPT can advertise an MCP protocol version newer than the installed SDK
 * supports during discovery. Passing that unknown version through makes the SDK
 * return 400 and can trigger repeated connector retries, so negotiate down to a
 * version that this SDK actually supports.
 */
function negotiateProtocolVersion(requested: string | undefined): string {
  if (requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
  closed?: boolean;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  touch(sessionId: string): void;
  count(): number;
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(session: McpSession, req: Request, res: Response, body?: unknown): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SESSION_RECOVERY_LOOPBACK_TIMEOUT_MS),
  });

  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId || !lastTransportErrors[sessionId]) return undefined;
  const message = lastTransportErrors[sessionId];
  delete lastTransportErrors[sessionId];
  return message;
}

async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const sessions: Record<string, McpSession> = {};
  const pendingRecoveries: Record<string, McpSession> = {};
  const recoveryFlights = new Map<string, Promise<McpSession | undefined>>();
  const deleteGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function touch(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function cancelDeleteGrace(sessionId: string): void {
    const timer = deleteGraceTimers[sessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete deleteGraceTimers[sessionId];
  }

  function scheduleDeleteGrace(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    console.log(
      `[MCP] Session DELETE — keeping it for ${SESSION_DELETE_GRACE_MS / 1000}s so in-flight tool calls can finish: ${sessionId}`
    );
    deleteGraceTimers[sessionId] = setTimeout(() => {
      delete deleteGraceTimers[sessionId];
      removeSession(sessionId, "client DELETE (grace expired)");
    }, SESSION_DELETE_GRACE_MS);
    deleteGraceTimers[sessionId].unref?.();
  }

  function removeSession(sessionId: string, reason: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (!session) return;
    delete sessions[sessionId];
    delete lastTransportErrors[sessionId];
    sessionOpChains.delete(sessionId);
    clearPendingRecovery(sessionId);
    getUpstreamManager().unregisterMcpServer(session.server);
    // Remove registry references before closing so SDK close callbacks cannot
    // re-arm grace retention for a session Local Coder has already evicted.
    void session.server.close().catch(() => undefined);
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
    void runLocalHooks("session_end", {
      workspace: config.workspaceRoot,
      session_id: sessionId,
      result: { reason },
    }).catch(() => undefined);
  }

  function clearPendingRecovery(sessionId: string): void {
    delete pendingRecoveries[sessionId];
  }

  function enforceSessionCapacity(protectedSessionId?: string): void {
    const entries = Object.entries(sessions);
    if (entries.length <= SESSION_MAX_RETAINED) return;
    const removable = entries
      .filter(([sid]) => sid !== protectedSessionId && !sessionOpChains.has(sid) && !pendingRecoveries[sid])
      .sort(([, a], [, b]) => {
        if (a.closed !== b.closed) return a.closed ? -1 : 1;
        return a.lastAccessedAt - b.lastAccessedAt;
      });
    while (Object.keys(sessions).length > SESSION_MAX_RETAINED && removable.length) {
      const [sid] = removable.shift()!;
      removeSession(sid, "session capacity exceeded");
    }
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    const hookInstructions = await runCodexSessionStartHooks().catch((error) => {
      console.warn("[MCP] Codex SessionStart hook failed:", error);
      return "";
    });
    const localSessionHook = await runLocalHooks("session_start", { workspace: config.workspaceRoot });
    if (!localSessionHook.allow) {
      throw new Error(localSessionHook.reason || "Session blocked by local session_start hook");
    }
    const localHookInstructions = localSessionHook.additional_context;
    const mcpServer = createMcpServer(
      config.workspaceRoot,
      config.shellTimeout,
      config.workspaceRoots,
      true,
      getUpstreamManager(),
      [config.projectMemoryInstructions, hookInstructions, localHookInstructions].filter(Boolean).join("\n\n")
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: preferredSessionId
        ? () => preferredSessionId
        : () => randomUUID(),
      // SSE is the SDK default and is safer for long-running tool calls because
      // it emits keepalive comment frames while the POST is still in progress.
      // JSON mode is retained only as an opt-in compatibility escape hatch.
      enableJsonResponse: MCP_JSON_RESPONSE,
      keepAliveMs: MCP_SSE_KEEPALIVE_MS,
      onsessioninitialized: (sid) => {
        const existing = sessions[sid];
        cancelDeleteGrace(sid);
        if (existing?.closed && existing.transport !== transport) {
          getUpstreamManager().unregisterMcpServer(existing.server);
          void existing.server.close().catch(() => undefined);
        }
        sessions[sid] = {
          transport,
          server: mcpServer,
          lastAccessedAt: Date.now(),
          createdAt: existing?.createdAt ?? Date.now(),
          closed: false,
        };
        clearPendingRecovery(sid);
        enforceSessionCapacity(sid);
        console.log(`[MCP] Session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        if (!sid) return;
        const current = sessions[sid];
        if (!current || current.transport !== transport) return;
        current.closed = true;
        scheduleDeleteGrace(sid);
      },
    });

    transport.onerror = (error) => {
      const sid = transport.sessionId;
      const message = error.message || String(error);
      if (sid) lastTransportErrors[sid] = message;
    };

    // Keep session alive across transient SSE disconnects; explicit DELETE cleans up.
    transport.onclose = () => {
      const sid = transport.sessionId;
      const current = sid ? sessions[sid] : undefined;
      if (!sid || !current || current.transport !== transport) return;
      current.closed = true;
      console.log(`[MCP] Transport closed for ${sid} (session kept for recovery)`);
    };

    await mcpServer.connect(transport);
    // Native tools must be available immediately. Upstream discovery can spawn
    // local processes or wait on remote MCPs, so publish it when ready instead.
    void refreshProxiedTools(mcpServer, getUpstreamManager())
      .then(() => mcpServer.sendToolListChanged())
      .catch((error) => console.warn("[MCP] Upstream tool refresh failed:", error));

    const sid = transport.sessionId ?? preferredSessionId ?? randomUUID();
    const initialized = sessions[sid];
    // During immediate recovery after a client DELETE, the grace window can
    // intentionally retain the old closed session under the same ID. Never
    // return that closed transport as the newly-built pending recovery session.
    // Once this transport actually initializes, onsessioninitialized replaces
    // the retained entry atomically.
    if (initialized?.transport === transport) return initialized;
    return {
      transport,
      server: mcpServer,
      lastAccessedAt: Date.now(),
      createdAt: initialized?.createdAt ?? Date.now(),
      closed: false,
    };
  }

  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "chatgpt-local-coder-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `[MCP] Recovery initialize failed: HTTP ${initResult.status} for ${staleSessionId}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `[MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions[staleSessionId]);
  }

  async function ensureRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<McpSession | undefined> {
    const existing = sessions[staleSessionId];
    if (existing && !existing.closed) return existing;

    const inFlight = recoveryFlights.get(staleSessionId);
    if (inFlight) return inFlight;

    const recovery = (async () => {
      let pending: McpSession | undefined;
      try {
        console.log(`[MCP] Attempting session recovery for stale ID: ${staleSessionId}`);
        pending = await buildSession(staleSessionId);
        pendingRecoveries[staleSessionId] = pending;

        const warmed = await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion);
        if (!warmed) {
          clearPendingRecovery(staleSessionId);
          if (sessions[staleSessionId]) removeSession(staleSessionId, "recovery failed");
          else await pending.server.close().catch(() => undefined);
          return undefined;
        }

        const recovered = sessions[staleSessionId];
        if (!recovered) {
          clearPendingRecovery(staleSessionId);
          await pending.server.close().catch(() => undefined);
          return undefined;
        }

        touch(staleSessionId);
        console.log(`[MCP] Session recovered: ${staleSessionId}`);
        return recovered;
      } catch (error) {
        clearPendingRecovery(staleSessionId);
        if (pending && !sessions[staleSessionId]) {
          await pending.server.close().catch(() => undefined);
        }
        throw error;
      }
    })();

    recoveryFlights.set(staleSessionId, recovery);
    try {
      return await recovery;
    } finally {
      if (recoveryFlights.get(staleSessionId) === recovery) {
        recoveryFlights.delete(staleSessionId);
      }
    }
  }

  return {
    get(sessionId: string) {
      const session = sessions[sessionId];
      return session?.closed ? undefined : session;
    },

    touch,

    count() {
      return Object.values(sessions).filter((session) => !session.closed).length;
    },

    sendSessionNotFound(res: Response, requestId: string | number | null = null) {
      const message =
        "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
      res.locals.mcpError = message;
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: requestId,
      });
    },

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
        const activeSid = session.transport.sessionId;
        if (activeSid) touch(activeSid);
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);
      if (sid) touch(sid);
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
      };
      // GET opens a long-lived SSE stream; handleRequest resolves only when that
      // stream closes. Serializing GET would hold the session queue indefinitely
      // and deadlock later POST calls (tools/list, tools/call), so serialize only
      // POST/DELETE operations.
      if (sid && req.method !== "GET") {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (isInitializeRequest(body)) {
        return false;
      }

      const protocolVersion = negotiateProtocolVersion(
        req.headers["mcp-protocol-version"] as string | undefined
      );
      const mcpPath = req.path || "/mcp";
      const recovered = await ensureRecoveredSession(staleSessionId, mcpPath, protocolVersion);
      if (!recovered) return false;

      const patchedReq = withSessionIdHeader(req, staleSessionId, protocolVersion);
      await enqueueSessionOp(staleSessionId, async () => {
        await recovered.transport.handleRequest(patchedReq, res, body);
      });
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of Object.entries(sessions)) {
          const ttlMs = session.closed ? CLOSED_SESSION_TTL_MS : SESSION_TTL_MS;
          if (now - session.lastAccessedAt > ttlMs) {
            void session.transport.close().catch(() => undefined);
            removeSession(sid, session.closed ? "closed-session TTL expired" : "idle TTL expired");
          }
        }
        for (const sid of Object.keys(pendingRecoveries)) {
          if (!sessions[sid]) clearPendingRecovery(sid);
        }
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest };
