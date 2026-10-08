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
    sessions: [{
      session_id: "session-project",
      default_workspace: "C:\\x",
      workspace_kind: "project",
      project_root: "C:\\x",
      project_alias: "project-x",
      connection: "connected",
      created_at: now.toISOString(),
      last_client_activity_at: now.toISOString(),
      disconnected_at: null,
      closed_at: null,
    }],
    processes: [{
      id: "bg1",
      pid: 123,
      label: "dev server",
      command: "npm run dev",
      cwd: "C:\\x",
      project_root: "C:\\x",
      started_at: new Date(now.getTime() - 30_000).toISOString(),
      running: true,
      exit_code: null,
      signal: null,
      last_activity_at: new Date(now.getTime() - 1_000).toISOString(),
      liveness: "active",
    }],
    codingLoops: [{
      status: "active",
      phase: "repair",
      attempts: [{ passed: 3, failed: 1 }],
      max_attempts: 4,
      goal: "repair loop",
      source_workspace: "C:\\x",
      workspace: "C:\\x",
    }],
  }));
  for (const label of ["Local Coder", "Overview", "Current work", "Projects / transports", "Workers", "Activity", "Health", "CPU 12.5%", "last tool 0ms ago", "SSE keepalive 10s", "LOOP REPAIR", "repair loop", "project-x", "dev server"]) {
    assert.match(frame, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assertFits(frame, 110, 30);
  const frameLines = frame.split("\n");
  assert.equal(frameLines.length, 30, "desktop dashboard should fill its fixed canvas height");
  assert.match(frameLines.at(-3) || "", /Health/, "Health section should stay pinned above the footer");
});

await test("dashboard uses restrained state colors without changing terminal width", async () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 30,
    color: true,
    cpuPercent: 42,
  }));
  assert.match(frame, /\x1b\[/, "expected ANSI state accents");
  assert.match(frame, /ONLINE/);
  assert.match(frame, /PROFILE/);
  assert.doesNotMatch(frame, /\x1b\[(34|35)(;1)?m/, "routine dashboard text should not use blue/magenta accents");
  assert.equal(frame.split("\n").length, 30);
  assertFits(frame, 120, 30);
});

await test("dashboard defaults to automatic resizing and explicit height caps stay bounded", async () => {
  assert.equal(dashboard.preferredTerminalDashboardRows(undefined), null);
  assert.equal(dashboard.preferredTerminalDashboardRows("36"), 36);
  assert.equal(dashboard.preferredTerminalDashboardRows("8"), 20);
  assert.equal(dashboard.preferredTerminalDashboardRows("200"), 60);
  assert.equal(dashboard.preferredTerminalDashboardRows("auto"), null);
  assert.equal(dashboard.preferredTerminalDashboardRows("invalid"), null);
  assert.equal(dashboard.dashboardViewportHeight(68, null), 68);
  assert.equal(dashboard.dashboardViewportHeight(68, 44), 44);
  assert.equal(dashboard.dashboardViewportHeight(18, 44), 18);
  assert.equal(dashboard.dashboardViewportHeight(1, null), 1);
});

await test("resize sequence uses all available rows and wide columns, with no clipping", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T03:00:00.000Z");
  const sizes = [[120, 30], [218, 72], [76, 21], [38, 9], [280, 54], [1, 1]];
  for (const [width, height] of sizes) {
    const actualRows = dashboard.dashboardViewportHeight(height, null);
    const frame = dashboard.renderDashboardFrame(baseModel(now, { width, height: actualRows, color: true }));
    assertFits(frame, width, height);
    if (width >= 64 && height >= 20) {
      assert.equal(frame.split("\n").length, height, `${width}x${height} should fill the viewport`);
      assert.equal(dashboard.measureTerminalCells(frame.split("\n")[0]), width, "wide header should fill viewport");
      assert.match(frame.split("\n").at(-3) || "", /Health/, "Health should stay pinned");
    }
  }
});

await test("desktop activity renders the 20 latest completed tool calls", async () => {
  runtime.resetRuntimeStateForTests();
  for (let index = 0; index < 25; index++) {
    const id = runtime.beginToolCall({ tool: `activity_${String(index).padStart(2, "0")}`, kind: "READ", summary: `item ${index}` });
    runtime.finishToolCall(id, "ok");
  }
  const now = new Date();
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 44,
    runtime: runtime.getRuntimeSnapshot(),
  }));
  const activitySection = frame.split("├─ Activity ")[1]?.split("├─ Health ")[0] || "";
  for (let index = 5; index < 25; index++) assert.match(activitySection, new RegExp(`activity_${String(index).padStart(2, "0")}`));
  for (let index = 0; index < 5; index++) assert.doesNotMatch(activitySection, new RegExp(`activity_${String(index).padStart(2, "0")}`));
  assertFits(frame, 120, 44);
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

await test("dashboard makes disconnected active transport obvious while work continues", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-09-14T13:00:10.000Z");
  const snapshot = runtime.getRuntimeSnapshot();
  snapshot.active = [{
    id: "active-lost",
    tool: "run_command",
    kind: "EXEC",
    summary: "npm test",
    started_at: new Date(now.getTime() - 8_000).toISOString(),
    started_ms: now.getTime() - 8_000,
    session_id: "lost-session",
    project_root: "C:\\work\\alpha",
    workspace_kind: "project",
  }];
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 30,
    sessionCount: 1,
    runtime: snapshot,
    sessions: [{
      session_id: "lost-session",
      default_workspace: "C:\\work\\alpha",
      workspace_kind: "project",
      project_root: "C:\\work\\alpha",
      project_alias: "alpha",
      connection: "disconnected",
      created_at: new Date(now.getTime() - 60_000).toISOString(),
      last_client_activity_at: new Date(now.getTime() - 9_000).toISOString(),
      disconnected_at: new Date(now.getTime() - 7_000).toISOString(),
      closed_at: null,
    }],
  }));
  assert.match(frame, /CHAT TRANSPORT LOST/);
  assert.match(frame, /work continues/i);
  assert.match(frame, /WORK CONTINUES/);
  assert.match(frame, /alpha/);
  assert.match(frame, /CHAT 0\/1/);
  assertFits(frame, 120, 30);
});

await test("dashboard warns when background work continues after chat transport disconnects", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-09-14T13:10:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 124,
    height: 30,
    sessionCount: 1,
    sessions: [{
      session_id: "worker-lost-session",
      default_workspace: "C:\\work\\worker-project",
      workspace_kind: "project",
      project_root: "C:\\work\\worker-project",
      project_alias: "worker-project",
      connection: "disconnected",
      created_at: new Date(now.getTime() - 60_000).toISOString(),
      last_client_activity_at: new Date(now.getTime() - 12_000).toISOString(),
      disconnected_at: new Date(now.getTime() - 10_000).toISOString(),
      closed_at: null,
    }],
    processes: [{
      id: "worker-still-running",
      pid: 321,
      label: "full test suite",
      command: "npm test",
      cwd: "C:\\work\\worker-project",
      project_root: "C:\\work\\worker-project",
      started_at: new Date(now.getTime() - 70_000).toISOString(),
      running: true,
      exit_code: null,
      signal: null,
      last_activity_at: new Date(now.getTime() - 2_000).toISOString(),
      liveness: "active",
    }],
  }));
  assert.match(frame, /CHAT TRANSPORT LOST/);
  assert.match(frame, /work continues in worker-project/);
  assert.match(frame, /WORK CONTINUES/);
  assert.match(frame, /full test suite/);
  assertFits(frame, 124, 30);
});

await test("dashboard highlights stalled worker with project and activity age", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-09-14T13:20:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 132,
    height: 30,
    processes: [{
      id: "stalled-bg",
      pid: 777,
      label: "long verification",
      command: "npm test",
      cwd: "C:\\work\\alpha",
      project_root: "C:\\work\\alpha",
      started_at: new Date(now.getTime() - 15 * 60_000).toISOString(),
      running: true,
      exit_code: null,
      signal: null,
      last_activity_at: new Date(now.getTime() - 11 * 60_000).toISOString(),
      liveness: "possibly_stalled",
    }],
  }));
  assert.match(frame, /STALLED\?/);
  assert.match(frame, /WORKER MAY BE STALLED/);
  assert.match(frame, /alpha/);
  assert.match(frame, /activity 11m00s ago/);
  assertFits(frame, 132, 30);
});

await test("active worker ordering surfaces stalled processes before routine work", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T02:00:00.000Z");
  const worker = (label, status, age) => ({
    id: label,
    pid: 1000 + age,
    label,
    command: label,
    cwd: "C:/work/active",
    project_root: "C:/work/active",
    started_at: new Date(now.getTime() - 900_000).toISOString(),
    last_activity_at: new Date(now.getTime() - age * 1000).toISOString(),
    running: true,
    exit_code: null,
    signal: null,
    liveness: status,
  });
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 136,
    height: 44,
    processes: [
      worker("routine-alpha", "active", 2),
      worker("routine-beta", "active", 3),
      worker("watch-this", "possibly_stalled", 660),
      worker("quiet-job", "silent", 180),
    ],
  }));
  const section = frame.split("├─ Workers ")[1]?.split("├─ Activity ")[0] || "";
  assert.ok(section.indexOf("watch-this") >= 0 && section.indexOf("quiet-job") >= 0);
  assert.ok(section.indexOf("watch-this") < section.indexOf("routine-alpha"));
  assert.ok(section.indexOf("quiet-job") < section.indexOf("routine-alpha"));
  assertFits(frame, 136, 44);
});

await test("worker-only activity is shown as working instead of idle", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T02:00:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 128,
    height: 36,
    processes: [{
      id: "still-working",
      pid: 2001,
      label: "compile",
      command: "npm run build",
      cwd: "C:/work/compile",
      project_root: "C:/work/compile",
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      running: true,
      exit_code: null,
      signal: null,
      liveness: "active",
    }],
  }));
  assert.match(frame, /WORK CONTINUES/);
  assert.doesNotMatch(frame.split("├─ Current work ")[1]?.split("├─ Projects ")[0] || "", /idle/);
  assertFits(frame, 128, 36);
});

await test("large TUI shows more than three active projects", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T02:00:00.000Z");
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    session_id: "visible-" + index,
    default_workspace: "C:/active/p" + index,
    workspace_kind: "project",
    project_root: "C:/active/p" + index,
    project_alias: "visible-" + index,
    connection: "connected",
    created_at: now.toISOString(),
    last_client_activity_at: now.toISOString(),
    disconnected_at: null,
    closed_at: null,
  }));
  const snapshot = runtime.getRuntimeSnapshot();
  snapshot.active = sessions.map((session, index) => ({
    id: "call-" + index,
    tool: "run_command",
    kind: "EXEC",
    summary: "working",
    started_at: now.toISOString(),
    started_ms: now.getTime(),
    session_id: session.session_id,
    project_root: session.project_root,
    workspace_kind: "project",
  }));
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 160,
    height: 60,
    sessionCount: sessions.length,
    runtime: snapshot,
    sessions,
  }));
  const projectRows = frame.split("├─ Projects / transports ")[1]?.split("├─ Workers ")[0] || "";
  for (let index = 0; index < 6; index++) assert.match(projectRows, new RegExp("visible-" + index));
  assertFits(frame, 160, 60);
});

await test("operator dashboard neutralizes terminal controls inside external content", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T02:00:00.000Z");
  const snapshot = runtime.getRuntimeSnapshot();
  snapshot.active = [{
    id: "unsafe",
    tool: "run_command",
    kind: "EXEC",
    summary: "build\x1b[2J\x1b]0;spoof-title\x07\r\nhijacked",
    started_at: new Date(now.getTime() - 1000).toISOString(),
    started_ms: now.getTime() - 1000,
  }];
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 32,
    runtime: snapshot,
    color: true,
    messages: [{ level: "warn", time: now.toISOString(), text: "notice\x1b[H\x1b[0K\rspoof" }],
  }));
  assert.match(frame, /build/);
  assert.doesNotMatch(frame, /\x1b\[2J|\x1b\]|\x1b\[H|\x1b\[0K/);
  assert.doesNotMatch(dashboard.sanitizeTerminalText("\u202eabc\x1b[2J"), /\u202e|\x1b/);
  assertFits(frame, 120, 32);
});

await test("disconnect alerts outrank a recent unrelated warning", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T02:00:00.000Z");
  const snapshot = runtime.getRuntimeSnapshot();
  snapshot.active = [{
    id: "lost",
    tool: "verify_project",
    kind: "EXEC",
    summary: "validation",
    started_at: new Date(now.getTime() - 6000).toISOString(),
    started_ms: now.getTime() - 6000,
    session_id: "lost-transport",
    project_root: "C:/work/active",
    workspace_kind: "project",
  }];
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 32,
    runtime: snapshot,
    sessions: [{
      session_id: "lost-transport",
      default_workspace: "C:/work/active",
      workspace_kind: "project",
      project_root: "C:/work/active",
      project_alias: "active",
      connection: "disconnected",
      created_at: now.toISOString(),
      last_client_activity_at: now.toISOString(),
      disconnected_at: now.toISOString(),
      closed_at: null,
    }],
    messages: [{ level: "warn", time: now.toISOString(), text: "Routine warning" }],
  }));
  assert.match(frame.split("├─ Health ")[1] || "", /CHAT TRANSPORT LOST/);
  assertFits(frame, 120, 32);
});

await test("crowded responsive layouts always retain the Health footer", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-10-08T02:00:00.000Z");
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    session_id: "s" + index,
    default_workspace: "C:/work/p" + index,
    workspace_kind: "project",
    project_root: "C:/work/p" + index,
    project_alias: "project-" + index,
    connection: index < 8 ? "connected" : "disconnected",
    created_at: now.toISOString(),
    last_client_activity_at: now.toISOString(),
    disconnected_at: null,
    closed_at: null,
  }));
  const processes = sessions.map((session, index) => ({
    id: "p" + index,
    pid: 1100 + index,
    label: "worker-" + index,
    command: "npm test",
    cwd: session.project_root,
    project_root: session.project_root,
    started_at: now.toISOString(),
    last_activity_at: now.toISOString(),
    running: true,
    exit_code: null,
    signal: null,
    liveness: index === 7 ? "possibly_stalled" : "active",
  }));
  const snapshot = runtime.getRuntimeSnapshot();
  snapshot.active = sessions.slice(0, 6).map((session, index) => ({
    id: "call" + index,
    tool: "run_command",
    kind: "EXEC",
    summary: "working",
    started_at: now.toISOString(),
    started_ms: now.getTime() - 8000,
    session_id: session.session_id,
    project_root: session.project_root,
    workspace_kind: "project",
  }));
  for (const width of [64, 80, 100, 132, 160]) for (let height = 20; height <= 60; height += 2) {
    const frame = dashboard.renderDashboardFrame(baseModel(now, {
      width,
      height,
      runtime: snapshot,
      sessionCount: sessions.length,
      sessions,
      processes,
      color: true,
      codingLoops: [{ status: "active", phase: "verify", attempts: [], max_attempts: 4, goal: "work", source_workspace: "C:/work/p0", workspace: "C:/work/p0" }],
    }));
    assert.match(frame.split("\n").at(-3) || "", /Health/, "missing Health at " + width + "x" + height);
    assertFits(frame, width, height);
  }
});

await test("active projects are automatically listed before connected idle and offline projects", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-09-14T13:30:00.000Z");
  const snapshot = runtime.getRuntimeSnapshot();
  snapshot.active = [{
    id: "active-beta",
    tool: "run_command",
    kind: "EXEC",
    summary: "npm test",
    started_at: new Date(now.getTime() - 5_000).toISOString(),
    started_ms: now.getTime() - 5_000,
    session_id: "beta-session",
    project_root: "C:\\work\\beta",
    workspace_kind: "project",
  }];
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 132,
    height: 36,
    sessionCount: 3,
    runtime: snapshot,
    sessions: [
      {
        session_id: "alpha-session",
        default_workspace: "C:\\work\\alpha",
        workspace_kind: "project",
        project_root: "C:\\work\\alpha",
        project_alias: "alpha-idle",
        connection: "connected",
        created_at: now.toISOString(),
        last_client_activity_at: now.toISOString(),
        disconnected_at: null,
        closed_at: null,
      },
      {
        session_id: "beta-session",
        default_workspace: "C:\\work\\beta",
        workspace_kind: "project",
        project_root: "C:\\work\\beta",
        project_alias: "beta-active",
        connection: "connected",
        created_at: now.toISOString(),
        last_client_activity_at: now.toISOString(),
        disconnected_at: null,
        closed_at: null,
      },
      {
        session_id: "gamma-session",
        default_workspace: "C:\\work\\gamma",
        workspace_kind: "project",
        project_root: "C:\\work\\gamma",
        project_alias: "gamma-offline",
        connection: "disconnected",
        created_at: now.toISOString(),
        last_client_activity_at: new Date(now.getTime() - 60_000).toISOString(),
        disconnected_at: new Date(now.getTime() - 30_000).toISOString(),
        closed_at: null,
      },
    ],
  }));
  const projectsSection = frame.split("├─ Projects / transports ")[1]?.split("├─ Workers ")[0] || "";
  const beta = projectsSection.indexOf("beta-active");
  const alpha = projectsSection.indexOf("alpha-idle");
  const gamma = projectsSection.indexOf("gamma-offline");
  assert.ok(beta >= 0 && alpha >= 0 && gamma >= 0, projectsSection);
  assert.ok(beta < alpha, "active project should sort before connected idle project");
  assert.ok(alpha < gamma, "connected idle project should sort before offline project");
  assertFits(frame, 132, 36);
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
  assert.match(frame, /PROJECT/);
  assert.match(frame, /WORK/);
  assertFits(frame, 46, 12);
});

await test("short terminals keep the compact health alert instead of clipping desktop footer", async () => {
  runtime.resetRuntimeStateForTests();
  const now = new Date("2026-09-14T13:40:00.000Z");
  const frame = dashboard.renderDashboardFrame(baseModel(now, {
    width: 120,
    height: 19,
    sessionCount: 1,
    sessions: [{
      session_id: "short-lost-session",
      default_workspace: "C:\\work\\short",
      workspace_kind: "project",
      project_root: "C:\\work\\short",
      project_alias: "short-active",
      connection: "disconnected",
      created_at: now.toISOString(),
      last_client_activity_at: new Date(now.getTime() - 10_000).toISOString(),
      disconnected_at: new Date(now.getTime() - 8_000).toISOString(),
      closed_at: null,
    }],
    processes: [{
      id: "short-worker",
      pid: 999,
      label: "long build",
      command: "npm test",
      cwd: "C:\\work\\short",
      project_root: "C:\\work\\short",
      started_at: new Date(now.getTime() - 60_000).toISOString(),
      running: true,
      exit_code: null,
      signal: null,
      last_activity_at: new Date(now.getTime() - 1_000).toISOString(),
      liveness: "active",
    }],
  }));
  assert.match(frame, /WARN CHAT TRANSPORT LOST/);
  assert.match(frame, /work continues/);
  assertFits(frame, 120, 19);
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