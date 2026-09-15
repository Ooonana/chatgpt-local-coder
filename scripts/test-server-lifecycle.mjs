import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./free-port.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-lifecycle-"));

function isolatedEnv(mcpPort, adminPort) {
  return {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    MCP_TOKEN: "",
    ADMIN_TOKEN: "",
    LOCAL_CODER_TUI: "off",
    MCP_UPSTREAM_CONFIG: path.join(tmp, `upstream-${mcpPort}.json`),
    PERMISSIONS_CONFIG: path.join(tmp, `permissions-${mcpPort}.json`),
    LOCAL_HOOKS_CONFIG: path.join(tmp, `hooks-${mcpPort}.json`),
    SUBAGENT_CONFIG: path.join(tmp, `subagents-${mcpPort}.json`),
    AUDIT_LOG_PATH: path.join(tmp, `audit-${mcpPort}.log`),
    WORKSPACE_PATH: root,
  };
}

function spawnServer(mcpPort, adminPort) {
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root,
    env: isolatedEnv(mcpPort, adminPort),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  return { child, output: () => output };
}

async function waitForHealth(port, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`health timeout on ${port}`);
}

async function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function listen(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return server;
}

async function portIsClosed(port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    const closed = () => {
      socket.destroy();
      resolve(true);
    };
    socket.once("error", closed);
    socket.once("timeout", closed);
  });
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

try {
  await test("SIGTERM exits cleanly and releases both listeners", async () => {
    const [mcpPort, adminPort] = await getFreePorts(2);
    const server = spawnServer(mcpPort, adminPort);
    await waitForHealth(mcpPort);
    await waitForHealth(adminPort);
    server.child.kill("SIGTERM");
    const exited = await waitForExit(server.child);
    if (process.platform === "win32") {
      assert.ok(
        exited.code === 0 || (exited.code === null && exited.signal === "SIGTERM"),
        server.output()
      );
    } else {
      assert.equal(exited.code, 0, server.output());
    }
    assert.equal(await portIsClosed(mcpPort), true, `MCP port ${mcpPort} still open`);
    assert.equal(await portIsClosed(adminPort), true, `Admin port ${adminPort} still open`);
  });

  await test("occupied admin port fails fast without leaving MCP listener", async () => {
    const [mcpPort, adminPort] = await getFreePorts(2);
    const blocker = await listen(adminPort);
    try {
      const candidate = spawnServer(mcpPort, adminPort);
      const exited = await waitForExit(candidate.child);
      assert.equal(exited.code, 1, candidate.output());
      assert.match(candidate.output(), /EADDRINUSE|admin server error/i);
      assert.equal(await portIsClosed(mcpPort), true, `MCP port ${mcpPort} leaked`);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  await test("occupied MCP port fails fast without leaving admin listener", async () => {
    const [mcpPort, adminPort] = await getFreePorts(2);
    const blocker = await listen(mcpPort);
    try {
      const candidate = spawnServer(mcpPort, adminPort);
      const exited = await waitForExit(candidate.child);
      assert.equal(exited.code, 1, candidate.output());
      assert.match(candidate.output(), /EADDRINUSE|MCP server error/i);
      assert.equal(await portIsClosed(adminPort), true, `Admin port ${adminPort} leaked`);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} lifecycle test(s) passed`);
if (process.exitCode) process.exit(process.exitCode);
