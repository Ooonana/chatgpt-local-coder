import assert from "node:assert/strict";

const runtime = await import("../dist/lib/runtime-state.js");
const dashboard = await import("../dist/lib/terminal-dashboard.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.stack || error}`);
    failed++;
  }
}

function baseModel(now, overrides = {}) {
  return {
    now,
    startedAtMs: now.getTime() - 1_000,
    width: 80,
    height: 24,
    mcpPort: 3000,
    adminPort: 3001,
    workspace: "C:\\Users\\test\\project",
    toolProfile: "slim",
    authEnabled: true,
    permission: "open: full machine access",
    transportMode: "sse",
    keepAliveMs: 10_000,
    sessionCount: 1,
    cpuPercent: 1.2,
    rssBytes: 10 * 1024 * 1024,
    heapBytes: 5 * 1024 * 1024,
    runtime: runtime.getRuntimeSnapshot(),
    processes: [],
    ptys: [],
    subagents: [],
    messages: [],
    color: false,
    ...overrides,
  };
}

function assertFits(frame, width, height) {
  const lines = frame.split("\n");
  assert.ok(lines.length <= height, `height ${lines.length} > ${height}\n${frame}`);
  assert.ok(
    lines.every((line) => dashboard.measureTerminalCells(line) <= width),
    `frame exceeds ${width} terminal cells\n${frame}`
  );
}

await test("runtime state tracks active, completed, errors and usage", async () => {
  runtime.resetRuntimeStateForTests();
  const read = runtime.beginToolCall({ tool: "read_text_file", kind: "READ", summary: "src/index.ts" });
  const exec = runtime.beginToolCall({ tool: "run_command", kind: "EXEC", summary: "npm test" });
  let snapshot = runtime.getRuntimeSnapshot();
  assert.equal(snapshot.active.length, 2);
  assert.deepEqual(snapshot.active.map((item) => item.tool), ["read_text_file", "run_command"]);

  runtime.finishToolCall(read, "ok");
  runtime.finishToolCall(exec, "error", "test failed");
  snapshot = runtime.getRuntimeSnapshot();
  assert.equal(snapshot.active.length, 0);
  assert.equal(snapshot.total_calls, 2);
  assert.equal(snapshot.total_ok, 1);
  assert.equal(snapshot.total_errors, 1);
  assert.equal(snapshot.recent[0].status, "error");
  assert.equal(snapshot.usage.find((item) => item.tool === "run_command")?.errors, 1);
});

await test("dashboard renders stable operational sections", async () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const snapshot = runtime.getRuntimeSnapshot();
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    startedAtMs: now.getTime() - 90_000,
    width: 110,
    height: 30,
    sessionCount: 2,
    cpuPercent: 12.5,
    rssBytes: 160 * 1024 * 1024,
    heapBytes: 64 * 1024 * 1024,
    runtime: snapshot,
    processes: [{ id: "bg1", pid: 123, command: "npm run dev", cwd: "C:\\x", started_at: now.toISOString(), running: true, exit_code: null, signal: null }],
    codingLoops: [{ status: "active", phase: "repair", attempts: [{}], max_attempts: 4, goal: "repair loop" }],
  }));
  for (const label of ["Local Coder", "Connection", "Active tools", "Workers", "Activity", "Usage", "CPU 12.5%", "last tool 0ms ago", "SSE keepalive 10s", "LOOPS 1", "LOOP REPAIR 1/4", "repair loop", "npm run dev"]) {
    assert.match(frame, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assertFits(frame, 110, 30);
  assert.equal(frame.split("\n").length, 30, "desktop dashboard should fill its fixed canvas height");
});

await test("dashboard uses color accents without changing terminal width", async () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 30,
    color: true,
    cpuPercent: 42,
  }));
  assert.match(frame, /\x1b\[/, "expected ANSI color sequences");
  assert.match(frame, /ONLINE/);
  assert.match(frame, /PROFILE/);
  assert.equal(frame.split("\n").length, 30);
  assertFits(frame, 120, 30);
});

await test("dashboard height preference defaults to 30 rows and stays bounded", async () => {
  assert.equal(dashboard.preferredTerminalDashboardRows(undefined), 30);
  assert.equal(dashboard.preferredTerminalDashboardRows("36"), 36);
  assert.equal(dashboard.preferredTerminalDashboardRows("8"), 20);
  assert.equal(dashboard.preferredTerminalDashboardRows("200"), 60);
  assert.equal(dashboard.preferredTerminalDashboardRows("auto"), null);
});

await test("dashboard shows elapsed time since last tool activity", async () => {
  runtime.resetRuntimeStateForTests();
  const id = runtime.beginToolCall({ tool: "read_text_file", kind: "READ", summary: "x" });
  runtime.finishToolCall(id, "ok");
  const snapshot = runtime.getRuntimeSnapshot();
  const finishedMs = Date.parse(snapshot.recent[0].finished_at);
  const now = new Date(finishedMs + 12_000);
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 90,
    height: 20,
    runtime: snapshot,
  }));
  assert.match(frame, /last tool 12s ago/);
  assertFits(frame, 90, 20);
});

await test("dashboard never exceeds a narrow viewport", async () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 46,
    height: 12,
    workspace: "C:\\very\\long\\workspace\\name",
    authEnabled: false,
    permission: "workspace: restricted",
  }));
  assertFits(frame, 46, 12);
});

await test("dashboard compact mode respects tiny resize dimensions", async () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  for (const [width, height] of [[27, 6], [12, 4], [1, 1]]) {
    const frame = dashboard.renderDashboardFrame(baseModel(now, { width, height }));
    assertFits(frame, width, height);
  }
});

await test("dashboard measures CJK terminal cells correctly", async () => {
  assert.equal(dashboard.measureTerminalCells("abc"), 3);
  assert.equal(dashboard.measureTerminalCells("한글"), 4);
  const now = new Date("2026-09-14T13:00:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 38,
    height: 10,
    workspace: "C:\\Users\\test\\프로젝트\\긴이름",
  }));
  assertFits(frame, 38, 10);
});

await test("non-interactive output does not force TUI", async () => {
  const previous = process.env.LOCAL_CODER_TUI;
  process.env.LOCAL_CODER_TUI = "off";
  assert.equal(dashboard.shouldUseTerminalDashboard(), false);
  if (previous === undefined) delete process.env.LOCAL_CODER_TUI;
  else process.env.LOCAL_CODER_TUI = previous;
});

runtime.resetRuntimeStateForTests();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);