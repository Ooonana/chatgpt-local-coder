import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  computerUseMcpPresets,
  importMcpConfigFromFile,
  importCursorMcpConfig,
  loadUpstreamConfig,
  parseClaudeCodeConfig,
  parseMcpServersFile,
  parseOpenCodeConfig,
  saveUpstreamConfig,
} from "../dist/lib/mcp-upstream-config.js";
import { McpUpstreamManager, collectPaginatedTools } from "../dist/lib/mcp-upstream-manager.js";
import { refreshProxiedTools, jsonSchemaToZodShape } from "../dist/lib/mcp-tool-proxy.js";
import { registerMcpBridgeTools } from "../dist/tools/mcp-bridge.js";
import { createMcpServer } from "../dist/server-factory.js";
import { savePermissionConfig } from "../dist/lib/permissions.js";
import { getFreePort } from "./free-port.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp", "mcp-upstream");

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

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function spawnMockHttp(port) {
  return spawn(process.execPath, [path.join(root, "scripts/mock-http-mcp.mjs")], {
    env: { ...process.env, MOCK_HTTP_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const configPath = path.join(tmpDir, "upstream.json");
process.env.MCP_UPSTREAM_CONFIG = configPath;

await run("MCP pagination merges all tools, deduplicates and rejects broken cursors", async () => {
  const cursors = [];
  const merged = await collectPaginatedTools(async (cursor) => {
    cursors.push(cursor || "");
    if (!cursor) return { tools: [{ name: "first" }], nextCursor: "page2" };
    if (cursor === "page2") return { tools: [{ name: "first" }, { name: "second" }], nextCursor: "page3" };
    if (cursor === "page3") return { tools: [{ name: "third" }] };
    throw new Error("Unexpected cursor " + cursor);
  });
  if (merged.map((tool) => tool.name).join(",") !== "first,second,third" ||
    cursors.join(",") !== ",page2,page3") throw new Error("Paged tool enumeration lost tools");

  try {
    await collectPaginatedTools(async () => ({ tools: [], nextCursor: "repeated" }));
    throw new Error("Expected repeated cursor rejection");
  } catch (error) {
    if (!/repeated cursor/.test(error.message)) throw error;
  }
  try {
    await collectPaginatedTools(async () => ({ tools: [{ name: "one" }], nextCursor: "next" }),
      { maxPages: 1 });
    throw new Error("Expected page limit rejection");
  } catch (error) {
    if (!/page limit/.test(error.message)) throw error;
  }
  try {
    await collectPaginatedTools(async () => ({ tools: [{ name: "one" }, { name: "two" }] }),
      { maxTools: 1 });
    throw new Error("Expected tool limit rejection");
  } catch (error) {
    if (!/tool limit/.test(error.message)) throw error;
  }
});

await run("jsonSchemaToZodShape respects required fields", async () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
    required: ["a"],
  });
  const aParsed = shape.a.safeParse(undefined);
  const bParsed = shape.b.safeParse(undefined);
  if (aParsed.success) throw new Error("a should be required");
  if (!bParsed.success) throw new Error("b should be optional");
});

await run("computer-use MCP presets are opt-in, safe and idempotent", async () => {
  const presets = computerUseMcpPresets();
  if (presets.length !== 2 ||
    presets.some((server) => server.enabled || server.transport !== "stdio" || server.expose !== "meta_only")) {
    throw new Error("computer-use preset must be disabled and non-advertising");
  }
  if (!/agent-desktop(?:-win32-(?:x64|arm64)\.exe)?$/.test(presets[0].command) ||
    !/agent-browser(?:-win32-x64\.exe)?$/.test(presets[1].command) ||
    presets[1].args.join(" ") !== "mcp --tools all") {
    throw new Error("unexpected Vercel computer-use CLI arguments");
  }
  if (!presets[1].env.AGENT_BROWSER_PROFILE ||
    !presets[1].env.AGENT_BROWSER_NAMESPACE ||
    !presets[1].env.AGENT_BROWSER_SESSION) {
    throw new Error("browser preset must isolate and persist its automation session");
  }
  if (process.platform === "win32" &&
    presets[0].command.endsWith(".exe") &&
    presets[1].command.endsWith(".exe") &&
    (!path.isAbsolute(presets[0].command) || !path.isAbsolute(presets[1].command))) {
    throw new Error("Windows computer-use binaries must resolve to absolute executable paths");
  }
  await saveUpstreamConfig({ version: 1, servers: [] }, configPath);
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  try {
    const first = await manager.addMissingServers(presets);
    const second = await manager.addMissingServers(presets);
    if (first.length !== 2 || second.length !== 0) throw new Error("preset addition was not idempotent");
    await manager.upsertServer({ ...presets[0], name: "User customized", enabled: false });
    await manager.addMissingServers(presets);
    if (manager.getServerConfig(presets[0].id)?.name !== "User customized") {
      throw new Error("computer-use preset overwrote a user customization");
    }
  } finally {
    await manager.shutdown();
  }
});

await run("save and load upstream config", async () => {
  await saveUpstreamConfig(
    {
      version: 1,
      servers: [
        {
          id: "demo",
          name: "Demo",
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:3999/mcp",
          expose: "all",
        },
      ],
    },
    configPath
  );
  const loaded = await loadUpstreamConfig(configPath);
  if (loaded.servers.length !== 1 || loaded.servers[0].id !== "demo") {
    throw new Error(JSON.stringify(loaded));
  }
});

await run("concurrent upstream mutations preserve every server and atomic config", async () => {
  await saveUpstreamConfig({ version: 1, servers: [] }, configPath);
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  const makeServer = (id) => ({
    id,
    name: id,
    enabled: false,
    transport: "http",
    url: `http://127.0.0.1:3999/${id}`,
    expose: "none",
  });
  await Promise.all([
    manager.upsertServer(makeServer("parallel-a")),
    manager.upsertServer(makeServer("parallel-b")),
    manager.upsertServer(makeServer("parallel-c")),
  ]);
  const persisted = await loadUpstreamConfig(configPath);
  const ids = new Set(persisted.servers.map((server) => server.id));
  for (const id of ["parallel-a", "parallel-b", "parallel-c"]) {
    if (!ids.has(id)) throw new Error(`concurrent upstream mutation lost ${id}: ${JSON.stringify(persisted)}`);
  }
  const residue = (await fs.readdir(path.dirname(configPath))).filter((name) =>
    name.startsWith(path.basename(configPath) + ".") && name.endsWith(".tmp")
  );
  if (residue.length) throw new Error(`upstream config temp residue: ${residue.join(", ")}`);
  await manager.shutdown();
});

await run("concurrent import and manager upsert preserve both changes", async () => {
  await saveUpstreamConfig({ version: 1, servers: [] }, configPath);
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  const fixturePath = path.join(tmpDir, "parallel-import.json");
  await fs.writeFile(fixturePath, JSON.stringify({
    mcpServers: {
      imported: { url: "http://127.0.0.1:3999/imported" },
    },
  }), "utf-8");
  await Promise.all([
    importMcpConfigFromFile(fixturePath, "cursor", { merge: true }),
    manager.upsertServer({
      id: "managed",
      name: "Managed",
      enabled: false,
      transport: "http",
      url: "http://127.0.0.1:3999/managed",
      expose: "none",
    }),
  ]);
  const persisted = await loadUpstreamConfig(configPath);
  const ids = new Set(persisted.servers.map((server) => server.id));
  if (!ids.has("imported") || !ids.has("managed")) {
    throw new Error(`concurrent import/upsert lost an entry: ${JSON.stringify(persisted)}`);
  }
  await manager.reloadConfig();
  const managerIds = new Set(manager.listServerConfigs().map((server) => server.id));
  if (!managerIds.has("imported") || !managerIds.has("managed")) {
    throw new Error(`manager did not converge to persisted config: ${JSON.stringify(manager.listServerConfigs())}`);
  }
  await manager.shutdown();
});

await run("parse claude code mcp config", async () => {
  const fixture = {
    projects: {
      "/proj": {
        mcpServers: {
          gh: { type: "http", url: "http://127.0.0.1:3100/mcp" },
        },
      },
    },
    mcpServers: {
      local: { command: "node", args: ["srv.js"] },
    },
  };
  const parsed = parseClaudeCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse opencode mcp config", async () => {
  const fixture = {
    mcp: {
      demo: { type: "local", command: ["node", "srv.js"] },
      remote: { type: "remote", url: "http://127.0.0.1:3200/mcp" },
    },
  };
  const parsed = parseOpenCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse and import cursor mcp config", async () => {
  const fixture = {
    mcpServers: {
      unity: { command: "node", args: ["C:/tools/unity.js"], cwd: "C:/game" },
      crawl: { url: "http://127.0.0.1:3100/mcp" },
    },
  };
  const parsed = parseMcpServersFile(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
  const fixturePath = path.join(tmpDir, "cursor-mcp-fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture), "utf-8");
  const result = await importCursorMcpConfig(fixturePath, { merge: true });
  if (!result.imported.includes("unity") || !result.imported.includes("crawl")) {
    throw new Error(JSON.stringify(result.imported));
  }
});

const httpPort = await getFreePort();
const mockHttp = spawnMockHttp(httpPort);
try {
  await waitForHealth(`http://127.0.0.1:${httpPort}/health`);

  await run("manager connects to http upstream and lists tools", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "all",
          tool_prefix: "mockhttp",
        },
      ],
    });
    const tools = await manager.listTools("mockhttp");
    if (!tools.some((t) => t.name === "add")) throw new Error("add tool missing");
    const raw = await manager.callTool("mockhttp", "add", { a: 2, b: 3 });
    const text = JSON.stringify(raw);
    if (!text.includes("5")) throw new Error(text);
  });

  await run("enabled upstream exposes all tools as prefixed direct tools", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });
    const hub = new McpServer({ name: "test-hub", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    registerMcpBridgeTools(hub, manager);
    const proxied = await refreshProxiedTools(hub, manager);
    if (!proxied.includes("mockhttp__add")) throw new Error(JSON.stringify(proxied));
    const names = manager.getProxiedToolNames(manager.getServerConfig("mockhttp"), await manager.listTools("mockhttp"));
    if (!names.includes("mockhttp__add")) throw new Error(JSON.stringify(names));
  });

  await run("restrictive profiles block unknown/mutating upstream calls until explicitly allowed", async () => {
    const permissionsPath = path.join(tmpDir, "permissions.json");
    process.env.PERMISSIONS_CONFIG = permissionsPath;
    process.env.CHATGPT_TOOL_PROFILE = "full";
    savePermissionConfig({ profile: "read_only", path_roots: [root] });

    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });

    const hub = createMcpServer(root, 15, [root], true, manager);
    await refreshProxiedTools(hub, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "upstream-permission-test", version: "1.0.0" }, { capabilities: {} });
    await hub.connect(serverTransport);
    await client.connect(clientTransport);

    const expectBlocked = async (call) => {
      try {
        const result = await call();
        const text = JSON.stringify(result);
        if (/unrestricted runtime|must be explicitly enabled/i.test(text)) return;
        throw new Error(`expected permission block, got ${text}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (/unrestricted runtime|must be explicitly enabled/i.test(text)) return;
        throw error;
      }
    };

    try {
      await expectBlocked(() => client.callTool({ name: "mcp_call", arguments: { server_id: "mockhttp", tool: "add", arguments: { a: 1, b: 2 } } }));
      await expectBlocked(() => client.callTool({ name: "mockhttp__add", arguments: { a: 1, b: 2 } }));

      savePermissionConfig({
        profile: "custom",
        path_roots: [root],
        allow_write: false,
        allow_commands: false,
        allow_unsafe_runtimes: true,
      });

      const denied = await client.callTool({ name: "mcp_call", arguments: { server_id: "mockhttp", tool: "add", arguments: { a: 2, b: 3 } } }).catch((err) => err);
      if (!/write|permission|denied/i.test(String(JSON.stringify(denied)))) {
        throw new Error(`mcp_call allowed mutation with allow_write=false: ${JSON.stringify(denied)}`);
      }
      const directDenied = await client.callTool({
        name: "mockhttp__add", arguments: { a: 3, b: 4 },
      }).catch((err) => err);
      if (!/write|permission|denied/i.test(String(JSON.stringify(directDenied)))) {
        throw new Error(`direct upstream proxy bypassed allow_write=false: ${JSON.stringify(directDenied)}`);
      }
      savePermissionConfig({
        profile: "custom", path_roots: [root], allow_write: true,
        allow_commands: false, allow_unsafe_runtimes: true,
      });
      const rawBridge = await client.callTool({ name: "mcp_call", arguments: { server_id: "mockhttp", tool: "add", arguments: { a: 2, b: 3 } } });
      if (!JSON.stringify(rawBridge).includes("5")) throw new Error(`mcp_call was not allowed by explicit unsafe-runtime opt-in: ${JSON.stringify(rawBridge)}`);
      const direct = await client.callTool({ name: "mockhttp__add", arguments: { a: 3, b: 4 } });
      if (!JSON.stringify(direct).includes("7")) throw new Error(`direct proxy was not allowed by explicit unsafe-runtime opt-in: ${JSON.stringify(direct)}`);
    } finally {
      savePermissionConfig({ profile: "open" });
      await client.close().catch(() => undefined);
      await hub.close().catch(() => undefined);
      await manager.shutdown().catch(() => undefined);
    }
  });
} finally {
  mockHttp.kill("SIGTERM");
}

await run("manager connects to stdio mock upstream", async () => {
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  await manager.updateConfig({
    version: 1,
    servers: [
      {
        id: "mockstdio",
        name: "Mock Stdio",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [path.join(root, "scripts/mock-stdio-mcp.mjs")],
        expose: "all",
      },
    ],
  });
  const tools = await manager.listTools("mockstdio");
  if (!tools.some((t) => t.name === "echo")) throw new Error(JSON.stringify(tools));
  const raw = await manager.callTool("mockstdio", "echo", { message: "hi" });
  const text = JSON.stringify(raw);
  if (!text.includes("echo:hi")) throw new Error(text);
  await manager.disconnect("mockstdio");
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
