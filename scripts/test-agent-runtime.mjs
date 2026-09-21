import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import { inspectProject } from "../dist/lib/project-inspection.js";
import { compactVerificationOutput, discoverVerificationRecipe } from "../dist/lib/verification.js";
import { getOperationRecord, listOperationHistory, recordOperationFinish, recordOperationStart } from "../dist/lib/operation-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, ".tool-test-tmp", "agent-runtime");
const fixture = path.join(tmp, "fixture");
process.env.MCP_OPERATION_STATE_DIR = path.join(tmp, "operations");
process.env.MCP_AGENT_TASK_STATE_DIR = path.join(tmp, "tasks");
process.env.MCP_VERIFICATION_CACHE_STATE_DIR = path.join(tmp, "verification-cache");
process.env.PERMISSIONS_CONFIG = path.join(tmp, "permissions.json");
process.env.LOCAL_HOOKS_CONFIG = path.join(tmp, "hooks.json");
process.env.SUBAGENT_CONFIG = path.join(tmp, "subagents.json");

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
function fail(name, error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (error) { fail(name, error); }
}

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(path.join(fixture, "src"), { recursive: true });
await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({
  name: "agent-runtime-fixture",
  scripts: {
    build: "node -e \"console.log('build')\"",
    test: "node -e \"console.log('test')\"",
    "test:integration": "node -e \"console.log('integration')\"",
  },
}, null, 2));
await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
await fs.writeFile(path.join(fixture, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
await fs.mkdir(path.join(fixture, "node_modules"), { recursive: true });
await fs.writeFile(path.join(fixture, "node_modules", ".package-lock.json"), "{}\n");
const olderNpmLockTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
await fs.utimes(path.join(fixture, "package-lock.json"), olderNpmLockTime, olderNpmLockTime);
const misleadingPnpmLockTime = new Date();
await fs.utimes(path.join(fixture, "pnpm-lock.yaml"), misleadingPnpmLockTime, misleadingPnpmLockTime);
await fs.writeFile(path.join(fixture, "src", "a.ts"), "export const a = 1;\n");
await fs.writeFile(path.join(fixture, "src", "b.ts"), "export const b = 2;\n");

await run("project inspection summarizes repo in one pass", async () => {
  const inspection = await inspectProject(fixture, 3);
  if (inspection.package?.name !== "agent-runtime-fixture") throw new Error(JSON.stringify(inspection));
  if (inspection.package?.manager !== "npm") throw new Error(`manager=${inspection.package?.manager}`);
  if (!inspection.languages.some((row) => row.extension === ".ts" && row.files === 2)) {
    throw new Error(JSON.stringify(inspection.languages));
  }
});

await run("verification recipe discovers standard package checks", async () => {
  const full = await discoverVerificationRecipe(fixture, "full");
  const labels = full.commands.map((item) => item.label);
  for (const expected of ["build", "test", "test:integration"]) {
    if (!labels.includes(expected)) throw new Error(`missing ${expected}: ${JSON.stringify(labels)}`);
  }
  if (full.commands.some((item) => /^(pnpm|yarn|bun)\s+run\s/.test(item.command))) {
    throw new Error(`secondary lockfile overrode the active npm installation: ${JSON.stringify(full.commands)}`);
  }
  if (!full.commands.some((item) => item.command === "npm run build")) {
    throw new Error(`npm build command not selected: ${JSON.stringify(full.commands)}`);
  }
});

await run("verification output keeps compact failure evidence", async () => {
  const compact = compactVerificationOutput("lots of normal output\n", "Error: expected true but got false\nstack line");
  if (!compact.excerpt.includes("Error:")) throw new Error(JSON.stringify(compact));
});

await run("operation history persists completion and detects interruption", async () => {
  await recordOperationStart({
    id: "done-op",
    label: "done",
    command: "echo done",
    cwd: fixture,
    status: "running",
    started_at: new Date().toISOString(),
  });
  await recordOperationFinish("done-op", { status: "completed", exit_code: 0, finished_at: new Date().toISOString(), stdout_tail: "done" });
  await recordOperationStart({
    id: "stale-op",
    label: "stale",
    command: "sleep 1",
    cwd: fixture,
    status: "running",
    started_at: new Date().toISOString(),
  });
  const done = await getOperationRecord("done-op", new Set());
  const stale = await getOperationRecord("stale-op", new Set());
  if (done?.effective_status !== "completed") throw new Error(JSON.stringify(done));
  if (stale?.effective_status !== "interrupted") throw new Error(JSON.stringify(stale));
  const list = await listOperationHistory({ active_ids: new Set(), limit: 10 });
  if (list.length < 2) throw new Error(JSON.stringify(list));
});

await run("operation retention never evicts a running record", async () => {
  const pressureDir = path.join(tmp, "operation-retention");
  await fs.rm(pressureDir, { recursive: true, force: true });
  await fs.mkdir(pressureDir, { recursive: true });
  const now = Date.now();
  const operations = [
    {
      id: "protected-running",
      command: "long-running",
      cwd: fixture,
      status: "running",
      started_at: new Date(now - 500_000).toISOString(),
    },
    ...Array.from({ length: 249 }, (_, index) => ({
      id: `terminal-${index}`,
      command: "done",
      cwd: fixture,
      status: "completed",
      started_at: new Date(now - 400_000 + index).toISOString(),
      finished_at: new Date(now - 399_000 + index).toISOString(),
      exit_code: 0,
    })),
  ];
  await fs.writeFile(path.join(pressureDir, "index.json"), JSON.stringify({ version: 1, operations }), "utf-8");
  const previous = process.env.MCP_OPERATION_STATE_DIR;
  process.env.MCP_OPERATION_STATE_DIR = pressureDir;
  try {
    await recordOperationStart({
      id: "new-running",
      command: "new",
      cwd: fixture,
      status: "running",
      started_at: new Date().toISOString(),
    });
    if (!(await getOperationRecord("protected-running", new Set(["protected-running", "new-running"])))) {
      throw new Error("existing running operation was evicted by history pressure");
    }
    const persisted = JSON.parse(await fs.readFile(path.join(pressureDir, "index.json"), "utf-8"));
    if (!persisted.operations.some((row) => row.id === "protected-running")) {
      throw new Error("protected running operation missing from persisted history");
    }
    if (persisted.operations.length > 250) throw new Error(`terminal operation history was not pruned: ${persisted.operations.length}`);
  } finally {
    process.env.MCP_OPERATION_STATE_DIR = previous;
    await fs.rm(pressureDir, { recursive: true, force: true });
  }
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(fixture, 20, [fixture], true);
const client = new Client({ name: "agent-runtime-test", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);
const call = async (name, args) => client.callTool({ name, arguments: args });

await run("agent runtime tools are exposed in slim", async () => {
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of ["read_files", "inspect_project", "verify_project", "process_history"]) {
    if (!names.has(name)) throw new Error(`${name} not exposed`);
  }
});

await run("read_files batches independent reads", async () => {
  const result = await call("read_files", {
    files: [
      { path: path.join(fixture, "src", "a.ts") },
      { path: path.join(fixture, "src", "b.ts"), head: 1 },
    ],
  });
  const rows = result.structuredContent?.data?.results;
  if (!Array.isArray(rows) || rows.length !== 2 || rows.some((row) => row.error)) throw new Error(JSON.stringify(result));
  if (!rows[0].content.includes("a = 1") || !rows[1].content.includes("b = 2")) throw new Error(JSON.stringify(rows));
});

await run("conditional reads require the full mtime+ctime revision pair", async () => {
  const file = path.join(fixture, "src", "a.ts");
  const first = await call("read_text_file", { path: file });
  const revision = first.structuredContent?.data;
  if (!revision?.mtime_ms || !revision?.ctime_ms) throw new Error(`missing revision metadata: ${JSON.stringify(first)}`);

  const unchanged = await call("read_text_file", {
    path: file,
    if_mtime_ms: revision.mtime_ms,
    if_ctime_ms: revision.ctime_ms,
  });
  if (unchanged.structuredContent?.data?.unchanged !== true) throw new Error(`matching revision was not compacted: ${JSON.stringify(unchanged)}`);

  const originalStat = await fs.stat(file);
  await fs.writeFile(file, "export const a = 9;\n");
  await fs.utimes(file, originalStat.atime, originalStat.mtime);
  const changed = await call("read_text_file", {
    path: file,
    if_mtime_ms: revision.mtime_ms,
    if_ctime_ms: revision.ctime_ms,
  });
  const changedData = changed.structuredContent?.data;
  if (changedData?.unchanged === true || !changedData?.content?.includes("a = 9")) {
    throw new Error(`stale conditional revision was accepted: ${JSON.stringify(changed)}`);
  }
  await fs.writeFile(file, "export const a = 1;\n");
});

await run("inspect_project MCP tool returns compact project state", async () => {
  const result = await call("inspect_project", { path: fixture, max_depth: 3 });
  const data = result.structuredContent?.data;
  if (data?.package?.name !== "agent-runtime-fixture" || !Array.isArray(data.languages)) throw new Error(JSON.stringify(result));
});

await run("verify_project supports discover and compact custom execution", async () => {
  const discovered = await call("verify_project", { path: fixture, preset: "discover" });
  if ((discovered.structuredContent?.data?.commands?.length || 0) < 3) throw new Error(JSON.stringify(discovered));
  const executed = await call("verify_project", {
    path: fixture,
    preset: "custom",
    commands: [{ label: "marker", command: "node -e \"console.log('VERIFY_OK')\"", timeout_seconds: 30 }],
  });
  const row = executed.structuredContent?.data?.results?.[0];
  if (!row || row.exit_code !== 0 || !row.excerpt.includes("VERIFY_OK")) throw new Error(JSON.stringify(executed));
});

await run("verify_project rejects affected_files outside the selected project", async () => {
  const outside = path.join(tmp, "outside-affected.txt");
  await fs.writeFile(outside, "outside\n");
  const result = await call("verify_project", {
    path: fixture,
    preset: "custom",
    commands: [{ label: "marker", command: "node -e \"process.exit(0)\"", timeout_seconds: 30 }],
    affected_files: [outside],
    use_cache: true,
  });
  if (!result.isError || !/affected_files path is outside the selected project/i.test(JSON.stringify(result))) {
    throw new Error(`outside affected_files was not rejected: ${JSON.stringify(result)}`);
  }
});

await run("verify_project does not persist cache entries when use_cache is false", async () => {
  const cacheFixture = path.join(tmp, "cache-fixture");
  await fs.mkdir(cacheFixture, { recursive: true });
  await fs.writeFile(path.join(cacheFixture, "package.json"), JSON.stringify({ name: "cache-fixture" }, null, 2));
  const source = path.join(cacheFixture, "source.js");
  await fs.writeFile(source, "export const value = 1;\n");
  const runGit = (...args) => {
    const result = spawnSync("git", args, { cwd: cacheFixture, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  };
  runGit("init", "-q");
  runGit("config", "user.email", "agent-runtime@example.invalid");
  runGit("config", "user.name", "Agent Runtime Test");
  runGit("add", ".");
  runGit("commit", "-qm", "init");
  await fs.rm(process.env.MCP_VERIFICATION_CACHE_STATE_DIR, { recursive: true, force: true });
  const result = await call("verify_project", {
    path: cacheFixture,
    preset: "custom",
    commands: [{ label: "marker", command: "node -e \"process.exit(0)\"", timeout_seconds: 30 }],
    affected_files: [source],
    use_cache: false,
  });
  if (result.isError) throw new Error(JSON.stringify(result));
  let cacheEntries = [];
  try { cacheEntries = await fs.readdir(process.env.MCP_VERIFICATION_CACHE_STATE_DIR); } catch {}
  if (cacheEntries.length) throw new Error(`cache was written with use_cache=false: ${cacheEntries.join(", ")}`);
});

await run("background process persists named operation history", async () => {
  const taskResult = await call("agent_task", {
    action: "start",
    title: "operation linkage",
    objective: "verify process history linkage",
    workspace: fixture,
    plan: ["run marker"],
  });
  const taskId = taskResult.structuredContent?.data?.task?.id;
  if (!taskId) throw new Error(JSON.stringify(taskResult));

  const started = await call("start_process", {
    command: "node -e \"setTimeout(()=>console.log('BG_OK'),80)\"",
    working_directory: fixture,
    label: "runtime-marker",
    task_id: taskId,
  });
  const id = started.structuredContent?.data?.id;
  if (!id) throw new Error(JSON.stringify(started));

  let finished = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = await call("process_output", { id, tail_chars: 10_000 });
    if (!output.structuredContent?.data?.running) {
      finished = true;
      break;
    }
  }
  if (!finished) throw new Error("background process did not finish");

  const history = await call("process_history", { id });
  const operation = history.structuredContent?.data?.operation;
  if (operation?.label !== "runtime-marker" || operation?.task_id !== taskId || operation?.effective_status !== "completed") {
    throw new Error(JSON.stringify(history));
  }
  if (!operation.stdout_tail?.includes("BG_OK")) throw new Error("operation history missing bounded stdout tail");
});

await run("instant background exit cannot race durable start persistence", async () => {
  const slowDir = path.join(tmp, "fast-exit-operations");
  await fs.rm(slowDir, { recursive: true, force: true });
  await fs.mkdir(slowDir, { recursive: true });
  const old = new Date(Date.now() - 60_000).toISOString();
  const padding = "x".repeat(20_000);
  const operations = Array.from({ length: 250 }, (_, index) => ({
    id: `old-${index}`,
    command: "old",
    cwd: fixture,
    status: "completed",
    started_at: old,
    finished_at: old,
    exit_code: 0,
    stdout_tail: padding,
    stderr_tail: padding,
  }));
  await fs.writeFile(path.join(slowDir, "index.json"), JSON.stringify({ version: 1, operations }), "utf-8");
  const previous = process.env.MCP_OPERATION_STATE_DIR;
  process.env.MCP_OPERATION_STATE_DIR = slowDir;
  try {
    const started = await call("start_process", {
      command: "node -e \"process.stdout.write('FAST_EXIT')\"",
      working_directory: fixture,
      label: "fast-exit",
    });
    const id = started.structuredContent?.data?.id;
    if (!id) throw new Error(JSON.stringify(started));
    let operation;
    for (let attempt = 0; attempt < 40; attempt++) {
      const history = await call("process_history", { id });
      operation = history.structuredContent?.data?.operation;
      if (operation?.effective_status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (operation?.effective_status !== "completed" || !operation.stdout_tail?.includes("FAST_EXIT")) {
      throw new Error(`fast process completion was lost: ${JSON.stringify(operation)}`);
    }
  } finally {
    process.env.MCP_OPERATION_STATE_DIR = previous;
    await fs.rm(slowDir, { recursive: true, force: true });
  }
});

await client.close().catch(() => {});
await server.close().catch(() => {});
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
