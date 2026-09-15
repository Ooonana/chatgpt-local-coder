import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import { shutdownManagedProcesses } from "../dist/tools/shell.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, ".tool-test-tmp", "modern-tools");

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
function fail(name, error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (error) { fail(name, error); }
}

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });
process.env.PERMISSIONS_CONFIG = path.join(tmp, "permissions.json");
process.env.LOCAL_HOOKS_CONFIG = path.join(tmp, "hooks.json");
process.env.SUBAGENT_CONFIG = path.join(tmp, "subagents.json");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(root, 15, [root], true);
const client = new Client({ name: "modern-tools-test", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);

const call = async (name, args) => client.callTool({ name, arguments: args });

await run("new tools are exposed in slim", async () => {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ["run_commands_parallel", "view_image", "lsp", "pty", "shell_reset", "directory_tree", "git_log", "subagent", "delegate_status"]) {
    if (!names.has(name)) throw new Error(`${name} not exposed`);
  }
  for (const name of ["delete_directory", "git_reset", "git_push", "mcp_call"]) {
    if (names.has(name)) throw new Error(`${name} should remain hidden in slim`);
  }
});

await run("parallel commands overlap in time", async () => {
  const command = process.platform === "win32"
    ? (label) => `Write-Output (\"${label}:\" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Start-Sleep -Milliseconds 500`
    : (label) => `${JSON.stringify(process.execPath)} -e "console.log('${label}:'+Date.now());setTimeout(()=>{},500)"`;
  const result = await call("run_commands_parallel", {
    concurrency: 2,
    commands: [{ command: command("A"), working_directory: tmp }, { command: command("B"), working_directory: tmp }],
  });
  const rows = result.structuredContent?.data?.results;
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error(JSON.stringify(result.structuredContent));
  if (rows.some((row) => row.exit_code !== 0)) throw new Error(JSON.stringify(rows));
  const stamps = rows.map((row) => Number(/:(\d+)/.exec(row.stdout)?.[1]));
  if (stamps.some((value) => !Number.isFinite(value))) throw new Error(`timestamps missing: ${JSON.stringify(rows)}`);
  if (Math.abs(stamps[0] - stamps[1]) > 300) throw new Error(`commands did not overlap: ${stamps.join(", ")}`);
});

await run("managed background processes are terminated by server shutdown cleanup", async () => {
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  const started = await call("start_process", { command, working_directory: tmp });
  const id = started.structuredContent?.data?.id;
  if (!id) throw new Error(JSON.stringify(started));
  await shutdownManagedProcesses();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const status = await call("process_status", { id });
  const row = status.structuredContent?.data?.processes?.[0];
  if (!row || row.running) throw new Error(`background process still running: ${JSON.stringify(row)}`);
});

await run("background process spawn failure stays inside the tool call", async () => {
  if (process.platform !== "win32") return;
  const previousShell = process.env.SHELL;
  process.env.SHELL = path.join(tmp, "missing", "pwsh.exe");
  let failedCleanly = false;
  try {
    const result = await call("start_process", { command: "Write-Output SHOULD_NOT_RUN", working_directory: tmp });
    failedCleanly = result.isError === true || /ENOENT|spawn/i.test(JSON.stringify(result));
  } catch (error) {
    failedCleanly = /ENOENT|spawn/i.test(String(error));
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
  if (!failedCleanly) throw new Error("spawn failure was not reported cleanly");
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === "run_command")) {
    throw new Error("MCP server stopped responding after spawn failure");
  }
});

await run("view_image returns MCP image content", async () => {
  const png = path.join(tmp, "pixel.png");
  const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9xkAAAAASUVORK5CYII=";
  await fs.writeFile(png, Buffer.from(onePixelPng, "base64"));
  const result = await call("view_image", { path: png });
  const image = result.content?.find((item) => item.type === "image");
  if (!image || image.mimeType !== "image/png" || !image.data) throw new Error(JSON.stringify(result));
});

await run("oversized native tool results fail explicitly before transport", async () => {
  const huge = path.join(tmp, "oversized.txt");
  await fs.writeFile(huge, "x".repeat(4 * 1024 * 1024), "utf-8");
  const result = await call("read_text_file", { path: huge });
  if (!result.isError) throw new Error(`expected transport-size error: ${JSON.stringify(result).slice(0, 500)}`);
  const text = JSON.stringify(result);
  if (!/safe transport limit|Narrow or chunk/.test(text)) throw new Error(text.slice(0, 1000));
});

await run("TypeScript LSP hover and definition", async () => {
  const file = path.join(tmp, "sample.ts");
  await fs.writeFile(file, "const value: number = 42;\nfunction twice(x: number){ return x * 2; }\nconsole.log(twice(value));\n");
  const hover = await call("lsp", { action: "hover", path: file, line: 3, column: 20 });
  const hoverText = JSON.stringify(hover.structuredContent?.data?.result || null);
  if (!hoverText.includes("value") || !hoverText.includes("number")) throw new Error(hoverText);
  const definition = await call("lsp", { action: "definition", path: file, line: 3, column: 20 });
  const defText = JSON.stringify(definition.structuredContent?.data?.result || null);
  if (!defText.includes("sample.ts")) throw new Error(defText);
  await call("lsp", { action: "shutdown", server: "typescript" });
});

await run("Python LSP hover and definition", async () => {
  const file = path.join(tmp, "sample.py");
  await fs.writeFile(file, "value: int = 42\ndef twice(x: int) -> int:\n    return x * 2\nprint(twice(value))\n");
  const hover = await call("lsp", { action: "hover", path: file, line: 4, column: 13 });
  const hoverText = JSON.stringify(hover.structuredContent?.data?.result || null);
  if (!hoverText.includes("value")) throw new Error(hoverText);
  const definition = await call("lsp", { action: "definition", path: file, line: 4, column: 13 });
  const defText = JSON.stringify(definition.structuredContent?.data?.result || null);
  if (!defText.includes("sample.py")) throw new Error(defText);
  await call("lsp", { action: "shutdown", server: "pyright" });
});

await run("PTY provides interactive terminal I/O", async () => {
  const started = await call("pty", { action: "start", working_directory: tmp, cols: 100, rows: 30 });
  const id = started.structuredContent?.data?.id;
  if (!id) throw new Error(JSON.stringify(started.structuredContent));
  try {
    await call("pty", { action: "read", id, wait_ms: 350, strip_ansi: true });
    const command = process.platform === "win32" ? "Write-Output PTY_TOOL_OK" : "echo PTY_TOOL_OK";
    await call("pty", { action: "write", id, input: command, append_newline: true });
    const output = await call("pty", {
      action: "read",
      id,
      wait_for: "PTY_TOOL_OK",
      wait_ms: 5000,
      strip_ansi: true,
    });
    const text = output.structuredContent?.data?.output || "";
    if (!text.includes("PTY_TOOL_OK")) throw new Error(`PTY output missing marker: ${JSON.stringify(text)}`);
    await call("pty", { action: "write", id, input: "exit", append_newline: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
  } finally {
    await call("pty", { action: "stop", id }).catch(() => {});
  }
});

await call("lsp", { action: "shutdown" }).catch(() => {});
await client.close().catch(() => {});
await server.close().catch(() => {});
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
