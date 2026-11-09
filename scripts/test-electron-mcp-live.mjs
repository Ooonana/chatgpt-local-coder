/**
 * Optional Windows Electron integration check using a disposable VS Code
 * instance and profile. No downloads and no attachment to an existing editor.
 * Run: node scripts/test-electron-mcp-live.mjs
 */
import assert from "node:assert/strict";
// This disposable Electron fixture must never prompt the real desktop user.
process.env.MCP_COMPUTER_APPROVAL_MODE = "off";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { computerUseMcpPresets, saveUpstreamConfig } from "../dist/lib/mcp-upstream-config.js";
import { registerComputerUseTools } from "../dist/tools/computer-use.js";
import { savePermissionConfig } from "../dist/lib/permissions.js";

if (process.platform !== "win32") {
  console.log("SKIP Electron live test: Windows required");
  process.exit(0);
}
const vscode = path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe");
try { await fs.access(vscode); }
catch {
  console.log("SKIP Electron live test: VS Code not installed");
  process.exit(0);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-electron-test-"));
const profile = path.join(dir, "vscode-profile");
const extensions = path.join(dir, "extensions");
const configPath = path.join(dir, "upstream.json");
const previousPermissions = process.env.PERMISSIONS_CONFIG;
process.env.PERMISSIONS_CONFIG = path.join(dir, "permissions.json");
const suffix = randomBytes(4).toString("hex");
let code;
let manager;
let client;
let server;

async function freeLocalPort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

try {
  savePermissionConfig({ profile: "open" });
  const port = await freeLocalPort();
  code = spawn(vscode, [
    "--user-data-dir=" + profile,
    "--extensions-dir=" + extensions,
    "--disable-extensions",
    "--disable-telemetry",
    "--new-window",
    "--force-renderer-accessibility",
    "--remote-debugging-port=" + port,
  ], { cwd: dir, windowsHide: false, stdio: "ignore" });
  assert.ok(code.pid, "Failed to launch isolated VS Code");
  // VS Code may outlive its launcher; it must not keep the Node test's event
  // loop alive after cleanup even when the original Code.exe PID was reused.
  code.unref();

  let cdp = false;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/version", {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok && (await res.json()).webSocketDebuggerUrl) {
        cdp = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(cdp, "Dedicated VS Code CDP port did not come online");
  console.log("OK isolated VS Code Electron CDP endpoint is reachable");

  const browser = {
    ...computerUseMcpPresets()[1],
    enabled: true,
    env: {
      AGENT_BROWSER_NAMESPACE: "lc-electron-" + suffix,
      AGENT_BROWSER_SESSION: "lc-electron-" + suffix,
    },
  };
  await saveUpstreamConfig({ version: 1, servers: [browser] }, configPath);
  manager = new McpUpstreamManager(configPath);
  await manager.init();
  const advertised = await manager.listTools(browser.id);
  assert.ok(advertised.some((tool) => tool.name === "agent_browser_connect"),
    "Electron CDP tool was lost during MCP pagination");

  server = new McpServer({ name: "local-coder-electron-test", version: "1.0" });
  registerComputerUseTools(server, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "local-coder-electron-client", version: "1.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name, args) => client.callTool({ name, arguments: args });

  const connected = await call("computer_act", {
    provider: "browser", tool: "agent_browser_connect",
    arguments: { target: String(port) }, allow_input: true,
  });
  assert.equal(connected.structuredContent?.ok, true,
    JSON.stringify(connected).slice(0, 2000));
  console.log("OK guarded MCP connected to localhost Electron CDP");

  const tabs = await call("computer_observe", {
    provider: "browser", tool: "agent_browser_tab_list",
  });
  assert.equal(tabs.structuredContent?.ok, true, JSON.stringify(tabs).slice(0, 1200));
  assert.ok(tabs.structuredContent?.data?.output?.length > 0, "No Electron CDP target surfaced");
  console.log("OK Electron windows/targets exposed through browser MCP");

  const snapshot = await call("computer_observe", {
    provider: "browser", tool: "agent_browser_snapshot",
  });
  assert.equal(snapshot.structuredContent?.ok, true, JSON.stringify(snapshot).slice(0, 2000));
  assert.ok(snapshot.structuredContent?.data?.output?.length > 10, "Electron accessibility snapshot is empty");
  console.log("OK Electron accessibility snapshot returned");

  await manager.disconnect(browser.id);
  const reconnected = await call("computer_observe", {
    provider: "browser", tool: "agent_browser_tab_list",
  });
  assert.equal(reconnected.structuredContent?.ok, true, JSON.stringify(reconnected).slice(0, 1600));
  console.log("OK Electron session continued after MCP transport reconnect");
} finally {
  console.log("CLEANUP Electron MCP test: closing connections and fixture");
  await client?.close().catch(() => undefined);
  console.log("CLEANUP Electron MCP test: client closed");
  await server?.close().catch(() => undefined);
  console.log("CLEANUP Electron MCP test: server closed");
  await manager?.shutdown().catch(() => undefined);
  console.log("CLEANUP Electron MCP test: upstream manager stopped");
  if (code?.pid) {
    // /T targets only the unique VS Code process tree started above.
    spawnSync("taskkill.exe", ["/PID", String(code.pid), "/T", "/F"], {
      encoding: "utf8", timeout: 12000, windowsHide: true,
    });
  }
  // Some Electron versions detach child processes from the initial launcher;
  // restrict any remaining cleanup strictly to the disposable profile path.
  const cleanup = [
    "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\"",
    "| Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" +
      dir.replaceAll("'", "''") + "') }",
    "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cleanup], {
    encoding: "utf8", timeout: 12000, windowsHide: true,
  });
  if (previousPermissions === undefined) delete process.env.PERMISSIONS_CONFIG;
  else process.env.PERMISSIONS_CONFIG = previousPermissions;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
  console.log("CLEANUP Electron MCP test: temporary profile removed");
}

// The agent-browser CDP daemon can leave a referenced native handle even after
// the MCP transport is closed. This is a standalone test CLI, not the server.
process.exit(0);