import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-tui-console-"));
const previous = {
  registry: process.env.MCP_PROJECT_REGISTRY_PATH,
  audit: process.env.AUDIT_LOG_PATH,
};
process.env.MCP_PROJECT_REGISTRY_PATH = path.join(scratch, "registry.json");
process.env.AUDIT_LOG_PATH = path.join(scratch, "audit.log");

const projects = await import("../dist/lib/project-affinity.js");
const actions = await import("../dist/lib/tui-console-state.js");
const views = await import("../dist/lib/tui-console-view.js");
const activity = await import("../dist/lib/activity-log.js");
const audit = await import("../dist/lib/audit.js");
const runtime = await import("../dist/lib/runtime-state.js");
let count = 0;
async function test(label, fn) {
  await fn();
  count++;
  console.log("OK  " + label);
}

function model(overrides = {}) {
  return {
    now: new Date("2026-10-08T08:00:00Z"),
    startedAtMs: Date.now() - 60000,
    width: 110,
    height: 32,
    mcpPort: 3000, adminPort: 3001,
    workspace: scratch, toolProfile: "slim", authEnabled: true,
    permission: "open: full machine access", transportMode: "sse",
    keepAliveMs: 10000, sessionCount: 0,
    cpuPercent: 1, rssBytes: 10000000, heapBytes: 5000000,
    runtime: runtime.getRuntimeSnapshot(),
    processes: [], ptys: [], subagents: [], codingLoops: [],
    sessions: [], messages: [], color: false,
    ...overrides,
  };
}
function fits(frame, width, height) {
  const dashboard = frame.split("\n");
  assert.equal(dashboard.length, height);
  for (const line of dashboard) {
    assert.ok(viewsWidth(line) <= width, "overflow: " + line);
  }
}
const { measureTerminalCells } = await import("../dist/lib/terminal-dashboard.js");
const viewsWidth = (line) => measureTerminalCells(line);

try {
  const alpha = path.join(scratch, "alpha");
  const beta = path.join(scratch, "beta");
  for (const dir of [alpha, beta]) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "package.json"), "{}");
    await projects.recordProjectAffinity(dir);
  }
  await test("registry listing includes real project paths", async () => {
    assert.equal((await projects.listRegisteredProjects()).length, 2);
  });
  await test("pin survives and reorders registry without deleting projects", async () => {
    assert.equal(await projects.setRegisteredProjectPinned(alpha, true), true);
    const list = await projects.listRegisteredProjects();
    assert.equal(list[0].root, alpha);
    assert.equal(list[0].pinned, true);
  });
  await test("busy workspace cannot be forgotten", async () => {
    await assert.rejects(
      projects.forgetRegisteredProject(alpha, (root) => root === alpha),
      /in use/i
    );
    assert.equal((await projects.listRegisteredProjects()).length, 2);
  });
  await test("unregister removes registry entry only, never project files", async () => {
    assert.equal(await projects.forgetRegisteredProject(beta), true);
    assert.equal((await projects.listRegisteredProjects()).length, 1);
    assert.equal(await fs.readFile(path.join(beta, "package.json"), "utf8"), "{}");
  });
  await test("keyboard reducer requires explicit confirmation for removal and logs", async () => {
    let state = actions.initialConsoleView();
    state = actions.reduceConsoleKey(state, "2", 2).state;
    assert.equal(state.tab, "workspaces");
    let step = actions.reduceConsoleKey(state, "x", 2);
    assert.equal(step.action, "none");
    assert.equal(step.state.pending, "forget");
    assert.equal(actions.reduceConsoleKey(step.state, "escape", 2).action, "none");
    step = actions.reduceConsoleKey(state, "x", 2);
    assert.equal(actions.reduceConsoleKey(step.state, "enter", 2).action, "forget");
    state = actions.reduceConsoleKey(state, "3", 2).state;
    step = actions.reduceConsoleKey(state, "c", 2);
    assert.equal(step.action, "none");
    assert.equal(actions.reduceConsoleKey(step.state, "y", 2).action, "archive");
    assert.equal(actions.reduceConsoleKey(state, "e", 2).state.errorsOnly, true);
    assert.equal(actions.reduceConsoleKey(state, "pagedown", 32).state.selected, 10);
  });
  await test("active project sorts ahead of pinned idle projects", async () => {
    const list = await projects.listRegisteredProjects();
    const sessions = [{
      session_id: "connected-beta", project_root: beta, project_alias: "beta",
      workspace_kind: "project", connection: "connected",
    }];
    const modelWithSessions = model({ sessions });
    const order = views.consoleWorkspaces(modelWithSessions, list, "active");
    assert.equal(order[0].root, beta);
    assert.equal(views.workspaceHasLiveWork(modelWithSessions, beta), true);
  });
  await test("workspace/history/log/worker/help pages fit multiple terminal sizes", async () => {
    const registry = await projects.listRegisteredProjects();
    const tabs = ["overview", "workspaces", "history", "workers", "logs", "help"];
    activity.appendActivity({ kind: "tool", tool: "verify_project", status: "ok", summary: "unit checks" });
    for (const [width, height] of [[110, 32], [72, 20], [240, 56], [29, 8]]) {
      for (const tab of tabs) {
        const state = { ...actions.initialConsoleView(), tab };
        const frame = views.renderTuiConsolePage(model({ width, height }), {
          state, registry, auditHistory: [], liveHistory: activity.getRecentActivity(100),
        });
        assert.ok(frame.length > 0);
        if (width >= 48 && height >= 12) fits(frame, width, height);
        else assert.ok(frame.split("\n").length <= height);
      }
    }
  });
  await test("log clearing archives historical records rather than deleting them", async () => {
    const completed = runtime.beginToolCall({ tool: "sample_task", kind: "EXEC" });
    runtime.finishToolCall(completed, "ok");
    const priorCount = runtime.getRuntimeSnapshot().total_calls;
    await audit.audit({ tool: "sample", action: "test", status: "ok", target: "workspace-test" });
    const oldContent = await fs.readFile(process.env.AUDIT_LOG_PATH, "utf8");
    const archive = await audit.archiveCurrentAuditLog();
    assert.ok(archive && archive.startsWith(path.join(scratch, ".mcp-state", "audit-archive")));
    assert.equal(await fs.readFile(archive, "utf8"), oldContent);
    await assert.rejects(fs.stat(process.env.AUDIT_LOG_PATH), { code: "ENOENT" });
    activity.clearRecentActivity();
    runtime.clearCompletedToolHistory();
    assert.equal(activity.getRecentActivity(100).length, 0);
    assert.equal(runtime.getRuntimeSnapshot().recent.length, 0);
    assert.equal(runtime.getRuntimeSnapshot().total_calls, priorCount);
    await audit.audit({ tool: "sample", action: "new-log", status: "ok" });
    const newContent = await fs.readFile(process.env.AUDIT_LOG_PATH, "utf8");
    assert.match(newContent, /new-log/);
  });
  await test("live keyboard navigation switches views and restores terminal mode", async () => {
    const { startTerminalDashboard } = await import("../dist/lib/terminal-dashboard.js");
    const stdout = process.stdout;
    const stdin = process.stdin;
    const originalWrite = stdout.write;
    const saved = ["isTTY", "columns", "rows"].map((key) => [key, Object.getOwnPropertyDescriptor(stdout, key)]);
    const savedInput = ["isTTY", "setRawMode"].map((key) => [key, Object.getOwnPropertyDescriptor(stdin, key)]);
    const beforeKeys = stdin.listenerCount("keypress");
    const previouslyPaused = stdin.isPaused();
    const oldTui = process.env.LOCAL_CODER_TUI;
    const oldHeight = process.env.LOCAL_CODER_TUI_HEIGHT;
    let terminal;
    const writes = [];
    const rawChanges = [];
    try {
      process.env.LOCAL_CODER_TUI = "on";
      process.env.LOCAL_CODER_TUI_HEIGHT = "auto";
      Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
      Object.defineProperty(stdout, "columns", { configurable: true, value: 110 });
      Object.defineProperty(stdout, "rows", { configurable: true, value: 32 });
      Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
      Object.defineProperty(stdin, "setRawMode", { configurable: true, value: (on) => rawChanges.push(on) });
      stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
      terminal = startTerminalDashboard({
        mcpPort: 3000, adminPort: 3001, workspace: scratch,
        toolProfile: "slim", authEnabled: true, permission: "open",
        transportMode: "sse", keepAliveMs: 10000,
        sessionCount: () => 0, sessionSnapshot: () => [],
      });
      assert.equal(terminal.active, true);
      assert.deepEqual(rawChanges, [true]);
      const press = async (name) => {
        stdin.emit("keypress", name, { name });
        await new Promise((resolve) => setTimeout(resolve, 100));
      };
      await press("2");
      assert.ok(writes.some((text) => text.includes("WORKSPACES")));
      // Other real live projects may appear ahead of our isolated saved test
      // entry. Navigate to the requested path rather than assuming row zero.
      for (let index = 0; index < 20 && !writes.at(-1)?.includes("PATH: " + alpha); index++) {
        await press("down");
      }
      assert.ok(writes.at(-1)?.includes("PATH: " + alpha), "saved project was not selectable");
      await press("p");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const registry = await projects.listRegisteredProjects();
      assert.equal(registry[0].pinned, false, "P should unpin selected workspace. Latest TUI: " + writes.at(-1)?.slice(-750));
      await press("x");
      assert.ok(writes.some((text) => text.includes("CONFIRM registry-only removal")));
      await press("escape");
      assert.equal((await projects.listRegisteredProjects()).length, 1);
      await press("3");
      assert.ok(writes.some((text) => text.includes("HISTORY")));
      await press("c");
      assert.ok(writes.some((text) => text.includes("CONFIRM archive audit log")));
      await press("escape");
      assert.ok(await fs.stat(process.env.AUDIT_LOG_PATH));
      await press("c");
      await press("enter");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await assert.rejects(fs.stat(process.env.AUDIT_LOG_PATH), { code: "ENOENT" });
      const preservedArchives = await fs.readdir(path.join(scratch, ".mcp-state", "audit-archive"));
      assert.ok(preservedArchives.length >= 2, "clearing via keyboard should archive rather than delete");
      await press("4");
      await press("5");
      await press("?");
      assert.ok(writes.some((text) => text.includes("HELP")));
      await press("2");
      for (let index = 0; index < 20 && !writes.at(-1)?.includes("PATH: " + alpha); index++) {
        await press("down");
      }
      assert.ok(writes.at(-1)?.includes("PATH: " + alpha));
      await press("x");
      await press("enter");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await projects.listRegisteredProjects()).length, 0);
      assert.equal(await fs.readFile(path.join(alpha, "package.json"), "utf8"), "{}");
    } finally {
      terminal?.stop();
      stdout.write = originalWrite;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(stdout, key, descriptor);
        else delete stdout[key];
      }
      for (const [key, descriptor] of savedInput) {
        if (descriptor) Object.defineProperty(stdin, key, descriptor);
        else delete stdin[key];
      }
      if (oldTui === undefined) delete process.env.LOCAL_CODER_TUI;
      else process.env.LOCAL_CODER_TUI = oldTui;
      if (oldHeight === undefined) delete process.env.LOCAL_CODER_TUI_HEIGHT;
      else process.env.LOCAL_CODER_TUI_HEIGHT = oldHeight;
      // The harness injects a fake interactive stdin on an inherited pipe.
      // Always stop reading it before exiting, otherwise an npm test chain
      // with an open stdin can hang after all assertions have passed.
      stdin.pause();
    }
    assert.equal(stdin.listenerCount("keypress"), beforeKeys);
    assert.deepEqual(rawChanges, [true, false]);
  });
  console.log("\n" + count + " interactive console checks passed");
} finally {
  if (previous.registry === undefined) delete process.env.MCP_PROJECT_REGISTRY_PATH;
  else process.env.MCP_PROJECT_REGISTRY_PATH = previous.registry;
  if (previous.audit === undefined) delete process.env.AUDIT_LOG_PATH;
  else process.env.AUDIT_LOG_PATH = previous.audit;
  await fs.rm(scratch, { recursive: true, force: true });
}