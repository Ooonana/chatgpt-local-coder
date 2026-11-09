/**
 * Optional live smoke test. No interaction with existing user applications.
 * Uses isolated temporary MCP configuration, leaving Local Coder's saved
 * upstream servers untouched. Run: node scripts/test-vercel-mcp-live.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { computerUseMcpPresets, saveUpstreamConfig } from "../dist/lib/mcp-upstream-config.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-vercel-mcp-"));
const configPath = path.join(dir, "upstreams.json");
const servers = computerUseMcpPresets().map((server) => ({ ...server, enabled: true }));
const manager = new McpUpstreamManager(configPath);
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>Local Coder browser fixture</title><h1>Before click</h1><button id='change'>Update</button><script>document.getElementById('change').onclick=()=>document.querySelector('h1').textContent='After click';</script>");
});

try {
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = fixture.address().port;
  await saveUpstreamConfig({ version: 1, servers }, configPath);
  await manager.init();
  for (const server of servers) {
    const tools = await manager.listTools(server.id);
    assert.ok(tools.length > 0, `No upstream tools from ${server.id}`);
    console.log(`OK ${server.id}: ${tools.length} MCP tools`);
    console.log("TOOLS", server.id, tools.slice(0, 12).map((tool) => tool.name).join(", "));
    if (server.id.endsWith("desktop")) {
      assert.ok(tools.some((tool) => tool.name === "desktop_list_apps"));
      const response = await manager.callTool(server.id, "desktop_list_apps", {});
      assert.equal(response?.isError, false);
      console.log("OK desktop accessibility: list-apps returned");
    } else {
      assert.ok(tools.some((tool) => tool.name === "agent_browser_open"));
      const url = "http://127.0.0.1:" + port + "/";
      const open = await manager.callTool(server.id, "agent_browser_open", { url });
      assert.equal(open?.isError, false, JSON.stringify(open).slice(0, 1400));
      const before = await manager.callTool(server.id, "agent_browser_snapshot", {});
      assert.match(JSON.stringify(before), /Before click/);
      const click = await manager.callTool(server.id, "agent_browser_click", { selector: "#change" });
      assert.equal(click?.isError, false, JSON.stringify(click).slice(0, 1400));
      const after = await manager.callTool(server.id, "agent_browser_snapshot", {});
      assert.match(JSON.stringify(after), /After click/);
      console.log("OK live Chrome navigation, accessibility snapshot and verified DOM click");

      // MCP transport reconnect must preserve the externally managed browser session.
      await manager.disconnect(server.id);
      const resumed = await manager.callTool(server.id, "agent_browser_snapshot", {});
      assert.match(JSON.stringify(resumed), /After click/);
      console.log("OK persistent browser session survived MCP transport reconnect");
      await manager.callTool(server.id, "agent_browser_close", {}).catch(() => undefined);
    }
  }
} finally {
  await manager.shutdown();
  await new Promise((resolve) => fixture.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}