/**
 * Optional Windows-only live UI integration check.
 * Launches a unique, disposable WinForms window; never operates on user apps.
 * Validates computer_observe -> accessibility ref -> computer_act -> snapshot,
 * plus screenshot fallback, then terminates only the fixture process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { registerComputerUseTools } from "../dist/tools/computer-use.js";
import { savePermissionConfig } from "../dist/lib/permissions.js";

if (process.platform !== "win32") {
  console.log("SKIP desktop live check: Windows required");
  process.exit(0);
}

const suffix = randomBytes(4).toString("hex");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-live-desktop-"));
const script = path.join(dir, "fixture.ps1");
const winTitle = "LC Isolated Window " + suffix;
const before = "LC_BEFORE_" + suffix;
const after = "LC_AFTER_" + suffix;
const buttonName = "LC_CHANGE_" + suffix;
const winPowerShell = path.join(process.env.WINDIR || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const previousPermissions = process.env.PERMISSIONS_CONFIG;
process.env.PERMISSIONS_CONFIG = path.join(dir, "permissions.json");

let fixturePid;
let client;
let server;
let manager;
try {
  await fs.writeFile(script, [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = '" + winTitle + "'",
    "$form.Width = 380",
    "$form.Height = 175",
    "$form.StartPosition = 'Manual'",
    "$form.Location = New-Object System.Drawing.Point(175,130)",
    "$label = New-Object System.Windows.Forms.Label",
    "$label.Text = '" + before + "'",
    "$label.AutoSize = $true",
    "$label.Location = New-Object System.Drawing.Point(20,24)",
    "$form.Controls.Add($label)",
    "$button = New-Object System.Windows.Forms.Button",
    "$button.Text = '" + buttonName + "'",
    "$button.Width = 180",
    "$button.Location = New-Object System.Drawing.Point(20,68)",
    "$button.Add_Click({ $label.Text = '" + after + "' })",
    "$form.Controls.Add($button)",
    "[System.Windows.Forms.Application]::Run($form)",
  ].join("\r\n"), "utf8");
  // Start-Process launches into the logged-in desktop session (a direct Node
  // spawn with windowsHide can create an inaccessible/hidden GUI window).
  const launcher = [
    "$proc = Start-Process -FilePath '" + winPowerShell.replaceAll("'", "''") + "'",
    "-ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File', '\"" + script.replaceAll("'", "''") + "\"') -PassThru",
  ].join(" ") + "; Write-Output $proc.Id";
  const launched = spawnSync(winPowerShell, ["-NoProfile", "-NonInteractive", "-Command", launcher], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  fixturePid = Number(launched.stdout?.trim());
  assert.ok(Number.isInteger(fixturePid) && fixturePid > 0,
    "Unable to launch isolated WinForms process: " + (launched.stderr || launched.error?.message || ""));

  savePermissionConfig({ profile: "open" });
  manager = new McpUpstreamManager();
  await manager.init();
  const desktopId = "vercel-agent-desktop";
  assert.equal(manager.getServerConfig(desktopId)?.enabled, true, "Desktop MCP provider must be enabled");

  let windowId;
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const windows = await manager.callTool(desktopId, "desktop_list_windows", {});
    const own = windows?.structuredContent?.data?.find(
      (win) => win.pid === fixturePid && win.title === winTitle,
    );
    if (own?.id) { windowId = own.id; break; }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  assert.ok(windowId, "Isolated test window not found via desktop_list_windows");

  server = new McpServer({ name: "local-coder-live-desktop-test", version: "1.0" });
  registerComputerUseTools(server, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "local-coder-live-desktop-client", version: "1.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name, args) => client.callTool({ name, arguments: args });

  const observed = await call("computer_observe", {
    provider: "desktop", tool: "desktop_snapshot",
    arguments: { window_id: windowId },
  });
  assert.equal(observed.structuredContent?.ok, true, JSON.stringify(observed).slice(0, 900));
  const tree = JSON.parse(observed.structuredContent.data.output).data?.tree;
  assert.match(JSON.stringify(tree), new RegExp(before));
  const findButton = (node) => {
    if (node?.name === buttonName && node.ref_id) return node.ref_id;
    for (const child of node?.children ?? []) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  };
  const ref = findButton(tree);
  assert.ok(ref, "Unique button ref was not addressable");
  console.log("OK isolated WinForms accessibility ref discovered");

  const clickArgs = {
    provider: "desktop", tool: "desktop_click",
    arguments: { ref_id: ref }, allow_input: true,
    verification_target: { window_id: windowId },
    screenshot_on_failure: true,
  };
  const acted = await call("computer_act", { ...clickArgs, expected_text: after });
  assert.equal(acted.structuredContent?.ok, true, JSON.stringify(acted).slice(0, 1900));
  assert.equal(acted.structuredContent?.data?.verification?.passed, true);
  assert.equal(acted.structuredContent?.data?.attempts, 1);
  console.log("OK real semantic click and window-scoped accessibility verification");

  const absent = await call("computer_act", { ...clickArgs, expected_text: "MISSING_" + suffix });
  assert.equal(absent.structuredContent?.ok, false, "Absent expected text must fail verification");
  assert.equal(absent.structuredContent?.data?.verification?.passed, false);
  assert.equal(absent.structuredContent?.data?.attempts, 1);
  const screenshotOutput = absent.content?.some((part) => part.type === "image") ||
    Boolean(absent.structuredContent?.data?.screenshot_fallback);
  assert.ok(screenshotOutput, "Missing expected state should return window-scoped screenshot fallback");
  console.log("OK live mismatch returns screenshot fallback without replay");
} finally {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await manager?.shutdown().catch(() => undefined);
  if (fixturePid) {
    try { process.kill(fixturePid); } catch {}
  }
  if (previousPermissions === undefined) delete process.env.PERMISSIONS_CONFIG;
  else process.env.PERMISSIONS_CONFIG = previousPermissions;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}