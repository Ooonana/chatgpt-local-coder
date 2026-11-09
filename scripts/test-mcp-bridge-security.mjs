import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMcpBridgeTools } from "../dist/tools/mcp-bridge.js";
import { refreshProxiedTools } from "../dist/lib/mcp-tool-proxy.js";
import { savePermissionConfig } from "../dist/lib/permissions.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-mcp-security-"));
const previousPermissions = process.env.PERMISSIONS_CONFIG;
process.env.PERMISSIONS_CONFIG = path.join(dir, "permissions.json");
savePermissionConfig({ profile: "open" });
let config = { id: "sensitive", enabled: true, tool_prefix: "hidden", expose: "meta_only", tools: [] };
const available = ["allowed", "not_allowed", "structuredFailure", "nestedFailure", "textFailure"]
  .map((name) => ({ name, description: name, annotations: { readOnlyHint: true } }));
const calls = [];
const manager = {
  getServerConfig: (id) => id === "sensitive" ? config : undefined,
  listServerConfigs: () => [config],
  async listTools() { return available; },
  getProxiedToolNames(cfg, tools) {
    if (!cfg.enabled || cfg.expose === "none" || cfg.expose === "meta_only") return [];
    return tools.filter((item) =>
      (cfg.expose === "all" || cfg.tools.includes(item.name)) &&
      !(cfg.disabled_tools ?? []).includes(item.name)
    ).map((item) => (cfg.tool_prefix ?? cfg.id) + "__" + item.name);
  },
  async callTool(id, tool, args) {
    calls.push({ id, tool, args });
    if (tool === "structuredFailure") return { structuredContent: { ok: false, error: "EXPECTED_FAILURE" } };
    if (tool === "nestedFailure") return { structuredContent: { response: { ok: false, error: "NESTED_FAILED" } } };
    if (tool === "textFailure") return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "TEXT_FAILED" }) }] };
    return { structuredContent: { ok: true, output: "SUCCESS" } };
  },
  async listStatuses() { return []; },
  async reloadConfig() {},
};
const server = new McpServer({ name: "security-test", version: "1.0.0" });
registerMcpBridgeTools(server, manager);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "security-client", version: "1.0.0" }, { capabilities: {} });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const invoke = (name, args) => client.callTool({ name, arguments: args });
  const denied = async (tool) => {
    const response = await invoke("mcp_call", { server_id: "sensitive", tool }).catch((error) => error);
    assert.match(JSON.stringify(response), /not exposed|not allowed|disabled/i);
  };

  await denied("allowed");
  let list = await invoke("mcp_tools", { server_id: "sensitive" });
  assert.equal(list.structuredContent?.data?.count, 0);
  assert.equal(calls.length, 0);
  config = { ...config, expose: "none" };
  await denied("allowed");
  config = { ...config, expose: "allowlist", tools: ["allowed", "structuredFailure", "nestedFailure", "textFailure"] };
  await refreshProxiedTools(server, manager);
  await denied("not_allowed");
  list = await invoke("mcp_tools", { server_id: "sensitive" });
  assert.equal(list.structuredContent?.data?.count, 4);
  assert.equal(list.structuredContent?.data?.tools.some((item) => item.name === "not_allowed"), false);
  const good = await invoke("mcp_call", { server_id: "sensitive", tool: "allowed" });
  assert.equal(good.structuredContent?.ok, true);
  for (const tool of ["structuredFailure", "nestedFailure", "textFailure"]) {
    const failure = await invoke("mcp_call", { server_id: "sensitive", tool });
    assert.equal(failure.structuredContent?.ok, false, tool + " was reported as successful");
  }
  assert.equal(calls.length, 4, "Denied tools must never reach the upstream provider");
  savePermissionConfig({
    profile: "custom", path_roots: [dir], allow_write: false,
    allow_commands: false, allow_unsafe_runtimes: true,
  });
  const beforeProxy = calls.length;
  const untrustedReadOnly = await invoke("hidden__allowed", {}).catch((error) => error);
  assert.match(JSON.stringify(untrustedReadOnly), /write|permission|denied/i,
    "Upstream readOnlyHint=true must not bypass the Local Coder write restriction");
  assert.equal(calls.length, beforeProxy);
  savePermissionConfig({ profile: "open" });
  const proxiedAllowed = await invoke("hidden__allowed", {});
  assert.equal(proxiedAllowed.isError, undefined, JSON.stringify(proxiedAllowed));
  assert.equal(calls.length, beforeProxy + 1);
  console.log("OK upstream-supplied readOnlyHint cannot bypass direct proxy permissions");
  config = { ...config, expose: "all", disabled_tools: ["allowed"] };
  await denied("allowed");
  config = { ...config, enabled: false };
  await denied("not_allowed");
  console.log("OK MCP exposure policy rejects hidden/disabled tools before upstream calls");
  console.log("OK MCP upstream structured, nested and text failures propagate as errors");
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  if (previousPermissions === undefined) delete process.env.PERMISSIONS_CONFIG;
  else process.env.PERMISSIONS_CONFIG = previousPermissions;
  await fs.rm(dir, { recursive: true, force: true });
}