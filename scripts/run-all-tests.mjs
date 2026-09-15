/** Full verification suite for ChatGPT Local Coder readiness. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseMcpResponseText } from "./mcp-test-response.mjs";
import { getFreePorts } from "./free-port.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-all-tests-"));
const [mcpPort, adminPort] = await getFreePorts(2);

function runProcess(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    let executable = command;
    let spawnArgs = args;
    if (command === "npm" && process.env.npm_execpath) {
      executable = process.execPath;
      spawnArgs = [process.env.npm_execpath, ...args];
    }
    const child = spawn(executable, spawnArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exit ${code}`))));
  });
}

function runNode(script, env = {}) {
  return runProcess(process.execPath, [path.join(root, script)], env);
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout ${url}`);
}

const isolatedEnv = {
  WORKSPACE_PATH: root,
  MCP_TOKEN: "",
  ADMIN_TOKEN: "",
  LOCAL_CODER_TUI: "off",
  CHATGPT_TOOL_PROFILE: "slim",
  PERMISSIONS_CONFIG: path.join(scratch, "permissions.json"),
  LOCAL_HOOKS_CONFIG: path.join(scratch, "hooks.json"),
  SUBAGENT_CONFIG: path.join(scratch, "subagents.json"),
  MCP_UPSTREAM_CONFIG: path.join(scratch, "upstream.json"),
  MCP_EDIT_TRANSACTION_STATE_DIR: path.join(scratch, "edit-transactions"),
  MCP_CODING_LOOP_STATE_DIR: path.join(scratch, "coding-loops"),
  MCP_CONTEXT_CAPSULE_STATE_DIR: path.join(scratch, "context-capsules"),
  MCP_CODING_LOOP_WORKTREE_ROOT: path.join(scratch, "worktrees"),
  MCP_JSON_RESPONSE: "false",
  MCP_SSE_KEEPALIVE_MS: "1000",
};

console.log("=== Full npm test suite ===");
await runProcess("npm", ["test"], isolatedEnv);

console.log("\n=== Integration (spawn server) ===");
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    ...isolatedEnv,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    LOCAL_CODER_TUI: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (data) => (serverLog += data));
server.stderr?.on("data", (data) => (serverLog += data));

try {
  const health = await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  if (!health.instructions?.tool_profile) throw new Error("health missing instructions");
  if (!String(health.permission || "").includes("open:")) throw new Error("health missing isolated open permission status");
  if (health.transportMode !== "sse" || health.sseKeepAliveMs !== 1000) throw new Error("health missing SSE keepalive configuration");
  console.log(`OK  health: profile=${health.instructions.tool_profile}, memory=${health.instructions.memory_files?.length ?? 0} files`);

  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

  const uiRes = await fetch(`http://127.0.0.1:${adminPort}/ui`);
  const uiHtml = await uiRes.text();
  if (!uiRes.ok || !uiHtml.includes('id="overview-last-tool"') || !uiHtml.includes('id="dash-active"') || !uiHtml.includes('id="dash-transactions"') || !uiHtml.includes('id="dash-loops"') || !uiHtml.includes('id="dash-capsules"')) {
    throw new Error("admin UI page missing live runtime overview");
  }
  const uiJsRes = await fetch(`http://127.0.0.1:${adminPort}/ui/app.js`);
  const uiJs = await uiJsRes.text();
  if (!uiJsRes.ok || !uiJs.includes("renderRuntimeOverview")) throw new Error("admin UI JavaScript not served");
  const uiCssRes = await fetch(`http://127.0.0.1:${adminPort}/ui/styles.css`);
  const uiCss = await uiCssRes.text();
  if (!uiCssRes.ok || !uiCss.includes(".overview-hero") || !uiCss.includes(".runtime-row")) {
    throw new Error("admin UI stylesheet not served");
  }
  console.log("OK  admin UI live overview assets");

  const runtime = await (await fetch(`http://127.0.0.1:${adminPort}/api/runtime`)).json();
  if (!Array.isArray(runtime.agent_tasks) || !Array.isArray(runtime.operations) || !Array.isArray(runtime.edit_transactions) || !Array.isArray(runtime.coding_loops) || !Array.isArray(runtime.context_capsules) || !Array.isArray(runtime.state_errors)) {
    throw new Error("admin runtime missing persistent agent task/operation/transaction/coding-loop/context-capsule state");
  }
  console.log("OK  admin agent runtime state");

  const permissions = await (await fetch(`http://127.0.0.1:${adminPort}/api/permissions`)).json();
  if (permissions.config?.profile !== "open") throw new Error("admin permissions endpoint incorrect");
  const hooks = await (await fetch(`http://127.0.0.1:${adminPort}/api/hooks`)).json();
  if (hooks.config?.enabled !== false) throw new Error("admin hooks endpoint incorrect");
  const subagents = await (await fetch(`http://127.0.0.1:${adminPort}/api/subagents`)).json();
  if (subagents.config?.enabled !== false || subagents.chatgpt_subscription_reuse !== false) {
    throw new Error("admin subagents endpoint incorrect");
  }
  console.log("OK  admin permissions/hooks/subagents APIs");

  const preview = await (await fetch(`http://127.0.0.1:${adminPort}/api/instructions/preview`)).json();
  if (!preview.preview?.includes("Agent workflow")) throw new Error("instructions preview missing agent prompt");
  if (!preview.preview?.includes("Permission policy:")) throw new Error("instructions preview missing permission policy");
  console.log(`OK  instructions preview ${preview.total_chars} chars`);

  const initRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no session id");

  const listRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listText = await listRes.text();
  const listJson = parseMcpResponseText(listText, listRes.headers.get("content-type") || "");
  const tools = listJson?.result?.tools || [];
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of [
    "apply_patch",
    "read_files",
    "inspect_project",
    "verify_project",
    "repo_intel",
    "edit_transaction",
    "coding_loop",
    "coding_loop_status",
    "context_capsule",
    "process_history",
    "run_commands_parallel",
    "pty",
    "lsp",
    "view_image",
    "subagent",
    "delegate_status",
  ]) {
    if (!names.has(required)) throw new Error(`${required} missing from tools/list`);
  }
  console.log(`OK  tools/list: ${tools.length} tools, ${Math.round(Buffer.byteLength(listText, "utf-8") / 1024)}KB`);

  await runNode("scripts/test-mcp-session.mjs", { ...isolatedEnv, PORT: String(mcpPort) });
  console.log("OK  test-mcp-session");
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  if (process.platform === "win32" && server.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
  } else {
    server.kill("SIGTERM");
  }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}

console.log("\n=== ALL TESTS PASSED ===");
