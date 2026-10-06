import { getRuntimeSnapshot, subscribeRuntimeState, type RuntimeSnapshot } from "./runtime-state.js";
import { setActivityConsoleEnabled } from "./activity-log.js";
import { getManagedProcessSnapshot } from "../tools/shell.js";
import { getPtySessionSnapshot } from "../tools/pty.js";
import { listSubagents } from "./subagent-manager.js";
import { listCodingLoops, type CodingLoopRecord } from "./coding-loop-store.js";
import type { SessionRuntimeState } from "./session-context.js";
import type { TunnelSnapshot } from "./tunnel-supervisor.js";

type LogLevel = "info" | "warn" | "error";

interface SystemMessage {
  time: string;
  level: LogLevel;
  text: string;
}

export interface DashboardOptions {
  mcpPort: number;
  adminPort: number;
  workspace: string;
  toolProfile: string;
  authEnabled: boolean;
  permission: string;
  transportMode: "sse" | "json";
  keepAliveMs: number;
  sessionCount: () => number;
  sessionSnapshot?: () => SessionRuntimeState[];
  tunnelSnapshot?: () => TunnelSnapshot;
}

export interface DashboardRenderModel {
  now: Date;
  startedAtMs: number;
  width: number;
  height: number;
  mcpPort: number;
  adminPort: number;
  workspace: string;
  toolProfile: string;
  authEnabled: boolean;
  permission: string;
  transportMode: "sse" | "json";
  keepAliveMs: number;
  sessionCount: number;
  sessions?: SessionRuntimeState[];
  tunnel?: TunnelSnapshot;
  cpuPercent: number;
  rssBytes: number;
  heapBytes: number;
  runtime: RuntimeSnapshot;
  processes: ReturnType<typeof getManagedProcessSnapshot>;
  ptys: ReturnType<typeof getPtySessionSnapshot>;
  subagents: ReturnType<typeof listSubagents>;
  codingLoops?: CodingLoopRecord[];
  messages: SystemMessage[];
  color: boolean;
}

const CSI = "\x1b[";
const ALT_ON = `${CSI}?1049h`;
const ALT_OFF = `${CSI}?1049l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR = `${CSI}2J${CSI}H`;
const ANSI_RE = /\x1B\[[0-?]*[ -\/]*[@-~]/g;
const DEFAULT_DASHBOARD_ROWS = 44;
const MIN_DASHBOARD_ROWS = 20;
const MAX_DASHBOARD_ROWS = 60;

function ansi(code: string, text: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function tone(text: string, color: boolean, code = "2"): string {
  return ansi(code, text, color);
}

function metric(label: string, value: string, color: boolean, valueCode = "37"): string {
  return `${ansi("2", label, color)} ${ansi(valueCode, value, color)}`;
}

function healthColor(percent: number): string {
  if (percent >= 70) return "31;1";
  if (percent >= 35) return "33;1";
  return "32;1";
}

export function preferredTerminalDashboardRows(raw = process.env.LOCAL_CODER_TUI_HEIGHT): number | null {
  const value = (raw ?? String(DEFAULT_DASHBOARD_ROWS)).trim().toLowerCase();
  if (["auto", "full", "off", "0", "false", "no"].includes(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DASHBOARD_ROWS;
  return Math.max(MIN_DASHBOARD_ROWS, Math.min(MAX_DASHBOARD_ROWS, parsed));
}

function codePointWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (/\p{Mark}/u.test(char)) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function measureTerminalCells(value: string): number {
  const plain = value.replace(ANSI_RE, "");
  let cells = 0;
  for (const char of plain) cells += codePointWidth(char);
  return cells;
}

function crop(value: string, width: number): string {
  if (width <= 0) return "";
  if (measureTerminalCells(value) <= width) return value;
  const plain = value.replace(ANSI_RE, "");
  if (width === 1) return ".";
  const target = Math.max(0, width - 2);
  let cells = 0;
  let out = "";
  for (const char of plain) {
    const next = codePointWidth(char);
    if (cells + next > target) break;
    out += char;
    cells += next;
  }
  return `${out}..`;
}

function pad(value: string, width: number): string {
  const fitted = crop(value, width);
  return fitted + " ".repeat(Math.max(0, width - measureTerminalCells(fitted)));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function clock(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function shortWorkspace(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}

function section(title: string, width: number, color = false, code = "1"): string {
  if (width < 4) return crop("-", width);
  const safeTitle = crop(title, Math.max(1, width - 7));
  const label = `─ ${safeTitle} `;
  const line = `├${label}${"─".repeat(Math.max(0, width - measureTerminalCells(label) - 2))}┤`;
  return tone(line, color, code);
}

function row(content: string, width: number, color = false): string {
  if (width < 3) return crop(content, width);
  return `${tone("│", color, "2")}${pad(` ${content}`, Math.max(0, width - 2))}${tone("│", color, "2")}`;
}

function toolStatusSymbol(status: "ok" | "error", color: boolean): string {
  return status === "ok" ? ansi("32", "✓", color) : ansi("31", "✕", color);
}

function kindLabel(kind: string, color: boolean): string {
  return ansi("2", kind.padEnd(4), color);
}

function spinner(nowMs: number, color: boolean): string {
  const frames = ["|", "/", "-", "\\"];
  return ansi("36", frames[Math.floor(nowMs / 250) % frames.length], color);
}

function latestToolActivityMs(runtime: RuntimeSnapshot): number | null {
  let latest = runtime.recent[0]?.finished_at ? Date.parse(runtime.recent[0].finished_at) : Number.NaN;
  if (!Number.isFinite(latest)) latest = Number.NEGATIVE_INFINITY;
  for (const item of runtime.active) latest = Math.max(latest, item.started_ms);
  return Number.isFinite(latest) && latest > 0 ? latest : null;
}

function lastToolLabel(runtime: RuntimeSnapshot, nowMs: number): string {
  const latest = latestToolActivityMs(runtime);
  return latest === null ? "last tool never" : `last tool ${formatDuration(Math.max(0, nowMs - latest))} ago`;
}

function compactDashboard(model: DashboardRenderModel, width: number, height: number): string {
  const nowMs = model.now.getTime();
  const running =
    model.processes.filter((item) => item.running).length +
    model.ptys.filter((item) => item.running).length +
    model.subagents.filter((item) => item.running).length;
  const active = model.runtime.active[0];
  const activeLoops = (model.codingLoops || []).filter((loop) => loop.status === "active");
  const tunnel = model.tunnel;
  const lastTool = lastToolLabel(model.runtime, nowMs);
  const lines = [
    `Local Coder ONLINE ${clock(model.now)}`,
    `MCP:${model.mcpPort} S:${model.sessionCount} ${model.transportMode.toUpperCase()} T:${tunnel?.status || "n/a"} A:${model.runtime.active.length} L:${activeLoops.length}`,
    `calls:${model.runtime.total_calls} err:${model.runtime.total_errors} work:${running} ${lastTool}`,
    active ? `${spinner(nowMs, false)} ${active.tool} ${formatDuration(nowMs - active.started_ms)}` : "idle",
  ];
  return lines.slice(0, height).map((line) => crop(line, width)).join("\n");
}

function finishFrame(lines: string[], width: number, height: number, color = false): string {
  if (height <= 0 || width <= 0) return "";
  if (lines.length < height) {
    const bottom = lines.at(-1) || "";
    const hasBottomBorder = bottom.replace(ANSI_RE, "").startsWith("└");
    const body = hasBottomBorder ? lines.slice(0, -1) : [...lines];
    const footer = hasBottomBorder ? bottom : tone(`└${"─".repeat(Math.max(0, width - 2))}┘`, color, "2");
    while (body.length < height - 1) body.push(row("", width, color));
    body.push(footer);
    return body.join("\n");
  }
  if (lines.length === height) return lines.join("\n");
  if (height === 1) return crop(lines[0] || "", width);
  const clipped = lines.slice(0, height - 1);
  clipped.push(width >= 3 ? `└${"─".repeat(Math.max(0, width - 2))}┘` : crop("-", width));
  return clipped.join("\n");
}

export function renderDashboardFrame(model: DashboardRenderModel): string {
  const width = Math.max(1, Math.min(Math.trunc(model.width || 80), 160));
  const height = Math.max(1, Math.trunc(model.height || 24));
  if (width < 28 || height < 7) return compactDashboard(model, width, height);
  const inner = width - 2;
  const lines: string[] = [];
  const nowMs = model.now.getTime();
  const uptime = formatDuration(Math.max(0, nowMs - model.startedAtMs));
  const online = ansi("32;1", "● ONLINE", model.color);
  const activeLoops = (model.codingLoops || []).filter((loop) => loop.status === "active");

  const titleLeft = ` Local Coder `;
  const titleRight = ` ${online} `;
  if (width >= measureTerminalCells(titleLeft) + measureTerminalCells(titleRight) + 4) {
    const titleFill = Math.max(0, width - measureTerminalCells(titleLeft) - measureTerminalCells(titleRight) - 2);
    lines.push(`${tone("┌", model.color, "2")}${ansi("1", titleLeft, model.color)}${tone("─".repeat(titleFill), model.color, "2")}${titleRight}${tone("┐", model.color, "2")}`);
  } else {
    lines.push(`${tone("┌", model.color, "2")}${ansi("1", pad(" Local Coder", width - 2), model.color)}${tone("┐", model.color, "2")}`);
  }
  lines.push(row([
    metric("TIME", clock(model.now), model.color),
    metric("UP", uptime, model.color),
    ansi("2", lastToolLabel(model.runtime, nowMs), model.color),
    metric("PID", String(process.pid), model.color),
    metric("CPU", `${model.cpuPercent.toFixed(1)}%`, model.color, healthColor(model.cpuPercent)),
    metric("RSS", formatBytes(model.rssBytes), model.color),
    metric("HEAP", formatBytes(model.heapBytes), model.color),
  ].join("  "), width, model.color));

  lines.push(section("Connection", width, model.color));
  const keepAlive = model.transportMode === "sse" ? ` keepalive ${Math.round(model.keepAliveMs / 1000)}s` : "";
  lines.push(row([
    metric("MCP", `:${model.mcpPort}`, model.color),
    ansi("1", `${model.transportMode.toUpperCase()}${keepAlive}`, model.color),
    metric("TRANSPORTS", String(model.sessionCount), model.color),
    metric("AUTH", model.authEnabled ? "ON" : "OFF", model.color, model.authEnabled ? "32;1" : "33;1"),
    metric("PROFILE", model.toolProfile, model.color),
  ].join("  "), width, model.color));
  if (model.tunnel) {
    const tunnelCode = model.tunnel.status === "online"
      ? "32;1"
      : ["disabled", "not_configured", "stopped"].includes(model.tunnel.status)
        ? "2"
        : "33;1";
    lines.push(row([
      metric("TUNNEL", model.tunnel.status.toUpperCase(), model.color, tunnelCode),
      metric("HEALTH", `:${model.tunnel.health_port}`, model.color),
      metric("RESTARTS", String(model.tunnel.restarts), model.color),
      model.tunnel.reused_external ? ansi("2", "reused existing tunnel", model.color) : "",
    ].filter(Boolean).join("  "), width, model.color));
  }
  lines.push(row([
    metric("WORKSPACE", shortWorkspace(model.workspace), model.color),
    metric("POLICY", model.permission.split(":", 1)[0], model.color, model.permission.startsWith("open") ? "32;1" : "33;1"),
    metric("LOOPS", String(activeLoops.length), model.color),
    metric("ADMIN", `:${model.adminPort}`, model.color),
  ].join("  "), width, model.color));


  if (activeLoops.length && height >= 20) {
    const loop = activeLoops[0];
    const attempt = `${loop.attempts.length}/${loop.max_attempts}`;
    lines.push(row(`${ansi("1", "LOOP", model.color)} ${loop.phase.toUpperCase()} ${ansi("2", attempt, model.color)}  ${loop.goal}`, width, model.color));
  }

  lines.push(section(`Active tools (${model.runtime.active.length})`, width, model.color));
  const activeSlots = height >= 30 ? 5 : height >= 24 ? 4 : height >= 20 ? 3 : 1;
  if (!model.runtime.active.length) {
    lines.push(row(`${ansi("2", "idle", model.color)}  ·  waiting for tool calls`, width, model.color));
  } else {
    for (const call of model.runtime.active.slice(0, activeSlots)) {
      const elapsed = formatDuration(nowMs - call.started_ms).padStart(6);
      lines.push(row(`${spinner(nowMs, model.color)} ${kindLabel(call.kind, model.color)} ${ansi("1", call.tool.padEnd(22).slice(0, 22), model.color)} ${ansi("2", elapsed, model.color)}  ${call.summary}`, width, model.color));
    }
    if (model.runtime.active.length > activeSlots) {
      lines.push(row(`… ${model.runtime.active.length - activeSlots} more active call(s)`, width));
    }
  }

  const runningProcesses = model.processes.filter((item) => item.running);
  const runningPtys = model.ptys.filter((item) => item.running);
  const runningAgents = model.subagents.filter((item) => item.running);
  const runningCount = runningProcesses.length + runningPtys.length + runningAgents.length;
  if (height >= 15) lines.push(section(`Workers (${runningCount})`, width, model.color));
  const runningRows: string[] = [];
  for (const item of runningProcesses) {
    runningRows.push(`BG    ${String(item.pid ?? "-").padEnd(7)} ${formatDuration(nowMs - Date.parse(item.started_at)).padStart(6)}  ${item.command}`);
  }
  for (const item of runningPtys) {
    runningRows.push(`PTY   ${String(item.pid ?? "-").padEnd(7)} ${formatDuration(nowMs - Date.parse(item.started_at)).padStart(6)}  ${item.command || "interactive shell"}`);
  }
  for (const item of runningAgents) {
    runningRows.push(`AGENT ${String(item.pid ?? "-").padEnd(7)} ${formatDuration(nowMs - Date.parse(item.started_at)).padStart(6)}  ${item.label || item.objective}`);
  }
  if (height >= 15) {
    const workerSlots = height >= 30 ? 4 : height >= 24 ? 3 : height >= 20 ? 2 : 1;
    if (!runningRows.length) lines.push(row(`${ansi("2", "none", model.color)}  ·  no background process, PTY, or subagent`, width, model.color));
    else for (const item of runningRows.slice(0, workerSlots)) lines.push(row(item, width, model.color));
    if (runningRows.length > workerSlots) lines.push(row(`… ${runningRows.length - workerSlots} more running item(s)`, width));
  }

  const silentWorkers = runningProcesses.filter((process) => process.liveness === "silent").length;
  const stalledWorkers = runningProcesses.filter((process) => process.liveness === "possibly_stalled").length;
  if ((silentWorkers || stalledWorkers) && height >= 20) {
    lines.push(row(
      ansi("33;1", `WORKER LIVENESS · ${silentWorkers} silent · ${stalledWorkers} possibly stalled`, model.color),
      width,
      model.color
    ));
  }

  lines.push(section("Activity", width, model.color));
  const footerReserve = height >= 18 ? 4 : 2;
  const recentSlots = Math.max(1, Math.min(20, height - lines.length - footerReserve));
  const recent = model.runtime.recent.slice(0, recentSlots);
  if (!recent.length) lines.push(row(`${ansi("2", "no completed calls yet", model.color)}`, width));
  for (const item of recent) {
    const time = new Date(item.finished_at).toLocaleTimeString("en-GB", { hour12: false });
    const summary = item.status === "error" ? item.error || item.summary : item.summary;
    lines.push(row(`${toolStatusSymbol(item.status, model.color)} ${ansi("2", time, model.color)} ${kindLabel(item.kind, model.color)} ${ansi("1", item.tool.padEnd(21).slice(0, 21), model.color)} ${ansi("2", formatDuration(item.duration_ms).padStart(6), model.color)}  ${summary}`, width, model.color));
  }

  if (height >= 18) {
    lines.push(section("Usage", width, model.color));
    const usage = model.runtime.usage.slice(0, 6).map((item) => {
      const repeated = item.repeated_calls ? ` r${item.repeated_calls}` : "";
      return `${item.tool} ${item.calls} p95:${formatDuration(item.p95_duration_ms)} ${formatBytes(item.total_result_bytes)}${repeated}`;
    }).join("  ·  ");
    lines.push(row(usage || ansi("2", "No tool usage yet", model.color), width, model.color));
  }

  const latestProblem = [...model.messages].reverse().find(
    (item) => item.level !== "info" && nowMs - Date.parse(item.time) < 15_000
  );
  if (latestProblem) {
    const label = latestProblem.level === "error" ? ansi("31;1", "ERROR", model.color) : ansi("33;1", "WARN", model.color);
    lines.push(row(`${label} ${latestProblem.text}`, width, model.color));
  } else {
    const permission = model.permission.split(":", 1)[0];
    lines.push(row(`${metric("POLICY", permission, model.color, permission === "open" ? "32;1" : "33;1")}  ·  ${ansi("2", lastToolLabel(model.runtime, nowMs), model.color)}  ·  ${metric("CALLS", `${model.runtime.total_calls}/${model.runtime.total_errors} err`, model.color, model.runtime.total_errors ? "31;1" : "32;1")}  ·  ${ansi("2", "Ctrl+C stop", model.color)}`, width, model.color));
  }
  lines.push(tone(`└${"─".repeat(inner)}┘`, model.color, "2"));
  return finishFrame(lines, width, height, model.color);
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function tuiPreference(): "auto" | "on" | "off" {
  const raw = (process.env.LOCAL_CODER_TUI || "auto").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(raw)) return "off";
  if (["1", "true", "on", "yes"].includes(raw)) return "on";
  return "auto";
}

export function shouldUseTerminalDashboard(): boolean {
  const pref = tuiPreference();
  if (pref === "off") return false;
  if (pref === "on") return Boolean(process.stdout.isTTY);
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.CI);
}

export function startTerminalDashboard(options: DashboardOptions): {
  active: boolean;
  renderNow: () => void;
  stop: () => void;
} {
  if (!shouldUseTerminalDashboard()) {
    return { active: false, renderNow: () => {}, stop: () => {} };
  }

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const messages: SystemMessage[] = [];
  const color = !process.env.NO_COLOR;
  const startedAtMs = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let codingLoopTimer: NodeJS.Timeout | undefined;
  let codingLoops: CodingLoopRecord[] = [];
  let resizeTimer: NodeJS.Timeout | undefined;
  let renderQueued = false;
  let previousCpu = process.cpuUsage();
  let previousCpuAt = Date.now();
  let cpuPercent = 0;
  let lastWidth = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;
  let lastHeight = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 30;
  const preferredRows = preferredTerminalDashboardRows();

  const capture = (level: LogLevel, args: unknown[]) => {
    const text = formatConsoleArgs(args);
    if (!text) return;
    messages.push({ time: new Date().toISOString(), level, text });
    if (messages.length > 40) messages.shift();
    queueRender();
  };

  console.log = (...args: unknown[]) => capture("info", args);
  console.warn = (...args: unknown[]) => capture("warn", args);
  console.error = (...args: unknown[]) => capture("error", args);
  setActivityConsoleEnabled(false);

  const sampleCpu = () => {
    const now = Date.now();
    if (now - previousCpuAt < 200) return;
    const elapsedUs = Math.max(1, (now - previousCpuAt) * 1000);
    const delta = process.cpuUsage(previousCpu);
    cpuPercent = ((delta.user + delta.system) / elapsedUs) * 100;
    previousCpu = process.cpuUsage();
    previousCpuAt = now;
  };

  const render = () => {
    if (stopped) return;
    renderQueued = false;
    sampleCpu();
    const memory = process.memoryUsage();
    if (process.stdout.columns && process.stdout.columns > 0) lastWidth = process.stdout.columns;
    if (process.stdout.rows && process.stdout.rows > 0) lastHeight = process.stdout.rows;
    const dashboardHeight = preferredRows === null ? lastHeight : Math.min(lastHeight, preferredRows);
    const frame = renderDashboardFrame({
      now: new Date(),
      startedAtMs,
      width: lastWidth,
      height: dashboardHeight,
      mcpPort: options.mcpPort,
      adminPort: options.adminPort,
      workspace: options.workspace,
      toolProfile: options.toolProfile,
      authEnabled: options.authEnabled,
      permission: options.permission,
      transportMode: options.transportMode,
      keepAliveMs: options.keepAliveMs,
      sessionCount: options.sessionCount(),
      sessions: options.sessionSnapshot?.() ?? [],
      tunnel: options.tunnelSnapshot?.(),
      cpuPercent,
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
      runtime: getRuntimeSnapshot(),
      processes: getManagedProcessSnapshot(),
      ptys: getPtySessionSnapshot(),
      subagents: listSubagents(),
      codingLoops,
      messages,
      color,
    });
    process.stdout.write(`${CLEAR}${frame}`);
  };

  function queueRender(): void {
    if (renderQueued || stopped) return;
    renderQueued = true;
    setImmediate(render);
  }

  const unsubscribe = subscribeRuntimeState(queueRender);
  const refreshCodingLoops = async () => {
    try {
      codingLoops = await listCodingLoops(8);
      queueRender();
    } catch {}
  };
  void refreshCodingLoops();
  codingLoopTimer = setInterval(() => void refreshCodingLoops(), 2000);
  codingLoopTimer.unref?.();
  const resize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(queueRender, 40);
    resizeTimer.unref?.();
  };
  process.stdout.on("resize", resize);
  const resizeRequest = preferredRows !== null && lastHeight < preferredRows
    ? `${CSI}8;${preferredRows};${Math.max(40, lastWidth)}t`
    : "";
  process.stdout.write(`${ALT_ON}${CURSOR_HIDE}${resizeRequest}`);
  render();
  timer = setInterval(render, 500);
  timer.unref?.();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (codingLoopTimer) clearInterval(codingLoopTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    unsubscribe();
    process.stdout.off("resize", resize);
    setActivityConsoleEnabled(true);
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    process.stdout.write(`${CURSOR_SHOW}${ALT_OFF}`);
  };

  process.once("exit", stop);
  return { active: true, renderNow: queueRender, stop };
}