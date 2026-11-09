import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerComputerUseTools } from "../dist/tools/computer-use.js";
import {
  allowedComputerUseTools,
  validateComputerUseTool,
} from "../dist/lib/computer-use-policy.js";
import { savePermissionConfig } from "../dist/lib/permissions.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-computer-use-"));
const previousPermissions = process.env.PERMISSIONS_CONFIG;
process.env.PERMISSIONS_CONFIG = path.join(root, "permissions.json");
const invoked = [];
const manager = {
  getServerConfig(id) {
    return {
      id, enabled: true, transport: "stdio", expose: "meta_only",
    };
  },
  async listTools(id) {
    const provider = id.includes("desktop") ? "desktop" : "browser";
    return [...allowedComputerUseTools(provider, "observe"),
      ...allowedComputerUseTools(provider, "act")].map((name) => ({ name }));
  },
  async callTool(id, tool, args) {
    invoked.push({ id, tool, args });
    if (args.simulateFailure) {
      return { structuredContent: { exitCode: 1, response: { ok: false, error: "ACTION_FAILED" } } };
    }
    if (tool.endsWith("_snapshot")) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { text: "Ready" } }) }] };
    }
    if (tool.endsWith("_screenshot")) {
      return { content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { result: "done" } }) }] };
  },
};

let client;
let server;
try {
  savePermissionConfig({ profile: "open" });
  assert.throws(() => validateComputerUseTool("browser", "observe", "agent_browser_eval", {}), /allowlisted/);
  assert.throws(() => validateComputerUseTool("desktop", "act", "desktop_clipboard_set", {}), /allowlisted/);
  assert.throws(() => validateComputerUseTool("browser", "act", "agent_browser_open", { url: "file:///etc/passwd" }), /http/);
  assert.throws(() => validateComputerUseTool("browser", "act", "agent_browser_open", { url: "javascript:alert(1)" }), /http/);
  console.log("OK computer-use safety allowlist and navigation protocols");

  server = new McpServer({ name: "computer-use-test", version: "1.0.0" });
  registerComputerUseTools(server, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "computer-use-test-client", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name, args) => client.callTool({ name, arguments: args });

  let result = await call("computer_observe", { provider: "desktop", tool: "desktop_snapshot" });
  assert.equal(result.structuredContent?.ok, true);
  assert.match(JSON.stringify(result), /Ready/);
  console.log("OK read-only desktop observation");

  savePermissionConfig({ profile: "read_only", path_roots: [root] });
  result = await call("computer_observe", { provider: "desktop", tool: "desktop_snapshot" });
  assert.match(JSON.stringify(result), /unrestricted runtime|explicitly enabled/);
  result = await call("computer_act", { provider: "desktop", tool: "desktop_click",
    arguments: { element: "e1" }, allow_input: true });
  assert.match(JSON.stringify(result), /permission|denied|disabled/i);
  savePermissionConfig({ profile: "open" });
  result = await call("computer_act", { provider: "desktop", tool: "desktop_click",
    arguments: { element: "e1" } });
  assert.match(JSON.stringify(result), /allow_input/);
  console.log("OK computer input requires permission and explicit opt-in");

  result = await call("computer_act", {
    provider: "browser", tool: "agent_browser_click", arguments: { selector: "button" },
    allow_input: true, expected_text: "Ready",
  });
  assert.equal(result.structuredContent?.ok, true);
  assert.equal(result.structuredContent?.data?.verification?.passed, true);
  assert.equal(invoked.filter((x) => x.tool === "agent_browser_click").length, 1);
  console.log("OK action verified by post-action DOM snapshot, exactly once");

  result = await call("computer_act", {
    provider: "desktop", tool: "desktop_click", arguments: { element: "e2" },
    allow_input: true, expected_text: "Not there", screenshot_on_failure: true,
  });
  assert.equal(result.structuredContent?.ok, false);
  assert.equal(result.structuredContent?.data?.verification?.passed, false);
  assert.ok(result.content?.some((item) => item.type === "image"));
  assert.equal(invoked.filter((x) => x.tool === "desktop_click").length, 1);
  console.log("OK failed verification returns screenshot and does not retry an input");

  result = await call("computer_act", {
    provider: "browser", tool: "agent_browser_click", arguments: { simulateFailure: true },
    allow_input: true, expected_text: "Ready",
  });
  assert.equal(result.structuredContent?.ok, false);
  assert.equal(result.structuredContent?.data?.verification?.checked, false);
  console.log("OK upstream nested error/exit code is not mistaken for success");
} finally {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (previousPermissions === undefined) delete process.env.PERMISSIONS_CONFIG;
  else process.env.PERMISSIONS_CONFIG = previousPermissions;
  await fs.rm(root, { recursive: true, force: true });
}