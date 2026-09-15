/**
 * Integration test: MCP session init, tool call, stale-session recovery.
 * Requires server running on PORT (default 3000).
 */
import { parseMcpResponseText } from "./mcp-test-response.mjs";

const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function mcpPost(path, body, sessionId, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = parseMcpResponseText(text, res.headers.get("content-type") || "");
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

async function mcpDelete(path, sessionId) {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
  });
  return { status: res.status, text: await res.text() };
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function initialize(path = "/mcp") {
  const { status, headers, json } = await mcpPost(
    path,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-mcp-session", version: "1.0.0" },
      },
    },
    null
  );

  if (status !== 200) throw new Error(`initialize HTTP ${status}: ${JSON.stringify(json)}`);
  const sessionId = headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing mcp-session-id header");
  return { sessionId, json };
}

let health;
await run("health endpoint", async () => {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  health = await res.json();
  if (health.status !== "ok") throw new Error(JSON.stringify(health));
});

let sessionId;
await run("initialize session on /mcp", async () => {
  const out = await initialize("/mcp");
  sessionId = out.sessionId;
});

await run("tools/list with valid session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (!json?.result?.tools?.some((t) => t.name === "run_command")) {
    throw new Error("run_command not in tools/list");
  }
});

await run("stale session auto-recovery", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000099";
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo stale-test" } },
    },
    fakeId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  if (status !== 200) {
    throw new Error(`expected recovery HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  }
  if (!json?.result) throw new Error(`recovery missing result: ${JSON.stringify(json)}`);
});

await run("parallel stale requests share one recovery", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000077";
  const headers = { "mcp-protocol-version": "2025-03-26" };
  const request = (id, marker) => mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: `echo ${marker}` } },
    },
    fakeId,
    headers
  );

  const [a, b] = await Promise.all([
    request(31, "parallel-recovery-a"),
    request(32, "parallel-recovery-b"),
  ]);
  for (const [label, result] of [["a", a], ["b", b]]) {
    if (result.status !== 200 || !result.json?.result) {
      throw new Error(`${label} recovery failed: HTTP ${result.status} ${JSON.stringify(result.json)}`);
    }
  }
});

await run("client DELETE can recover immediately without grace-window poisoning", async () => {
  const dedicated = await initialize("/mcp");
  const deleted = await mcpDelete("/mcp", dedicated.sessionId);
  if (deleted.status < 200 || deleted.status >= 300) {
    throw new Error(`DELETE failed HTTP ${deleted.status}: ${deleted.text}`);
  }
  const recovered = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo delete-recovery-ok" } },
    },
    dedicated.sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (recovered.status !== 200 || !recovered.json?.result) {
    throw new Error(`post-DELETE recovery failed: HTTP ${recovered.status} ${recovered.text.slice(0, 500)}`);
  }
});

await run("oversized JSON request fails locally with bounded 413 response", async () => {
  const huge = "x".repeat(9 * 1024 * 1024);
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "write_file", arguments: { path: "oversized.txt", content: huge } },
    }),
  });
  const text = await res.text();
  if (res.status !== 413) throw new Error(`expected HTTP 413, got ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (!String(json?.error?.message || "").includes("below 9 MiB")) {
    throw new Error(`unexpected 413 body: ${text.slice(0, 300)}`);
  }
});

await run("re-initialize with stale session header", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000088";
  const { status, headers, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-reinit", version: "1.0.0" },
      },
    },
    fakeId
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const newSession = headers.get("mcp-session-id");
  if (!newSession) throw new Error("missing new session id");
  sessionId = newSession;
});

await run("run_command after re-init", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { command: process.platform === "win32" ? "echo mcp-ok" : "echo mcp-ok" },
      },
    },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const text = JSON.stringify(json?.result ?? json);
  if (!text.includes("mcp-ok") && !json?.result?.content) {
    throw new Error(`unexpected result: ${text.slice(0, 300)}`);
  }
});

await run("long tool call stays alive with SSE keepalives", async () => {
  if (health?.transportMode !== "sse") throw new Error(`expected SSE transport, got ${health?.transportMode}`);
  if (!Number.isFinite(health?.sseKeepAliveMs) || health.sseKeepAliveMs > 2_000) {
    throw new Error(`test server keepalive must be <=2s, got ${health?.sseKeepAliveMs}`);
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
    "mcp-protocol-version": "2025-03-26",
  };
  const command = process.platform === "win32"
    ? "Start-Sleep -Seconds 3; Write-Output MCP_KEEPALIVE_OK"
    : "sleep 3; echo MCP_KEEPALIVE_OK";
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "run_command", arguments: { command } },
    }),
  });
  if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) throw new Error(`expected SSE Content-Type, got ${contentType}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let keepalives = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    keepalives = (text.match(/: keepalive/g) || []).length;
  }
  text += decoder.decode();
  const json = parseMcpResponseText(text, contentType);
  if (keepalives < 1) throw new Error(`no SSE keepalive observed: ${JSON.stringify(text.slice(0, 500))}`);
  if (!JSON.stringify(json).includes("MCP_KEEPALIVE_OK")) throw new Error(`missing final tool result: ${JSON.stringify(json)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);