import { getRuntimeSnapshot, subscribeRuntimeState, clearCompletedToolHistory, type RuntimeSnapshot } from "./runtime-state.js";
import { emitKeypressEvents } from "node:readline";
import {
  setActivityConsoleEnabled, getRecentActivity, clearRecentActivity, loadAuditHistory,
  type ActivityEntry,
} from "./activity-log.js";
import { archiveCurrentAuditLog } from "./audit.js";
import {
  listRegisteredProjects, setRegisteredProjectPinned, forgetRegisteredProject,
  type ProjectRegistryEntry,
} from "./project-affinity.js";
import {
  initialConsoleView, reduceConsoleKey, type ConsoleViewState, type ConsoleSort,
} from "./tui-console-state.js";
import {
  consoleHistory, consoleItems, consoleWorkspaces, renderTuiConsolePage, workspaceHasLiveWork,
} from "./tui-console-view.js";
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
const MIN_DASHBOARD_ROWS = 20;
const MAX_DASHBOARD_ROWS = 60;

// Tool summaries, worker labels and hook diagnostics are untrusted terminal
// content. Strip control sequences before composing our own ANSI formatting.
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./gs, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function safeDashboardModel(input: DashboardRenderModel): DashboardRenderModel {
  return {
    ...input,
    workspace: sanitizeTerminalText(input.workspace),
    permission: sanitizeTerminalText(input.permission),
    toolProfile: sanitizeTerminalText(input.toolProfile),
    sessions: input.sessions?.map((session) => ({
      ...session,
      project_alias: session.project_alias == null ? null : sanitizeTerminalText(session.project_alias),
      project_root: session.project_root == null ? null : sanitizeTerminalText(session.project_root),
    })),
    runtime: {
      ...input.runtime,
      active: input.runtime.active.map((call) => ({
        ...call,
        tool: sanitizeTerminalText(call.tool),
        summary: sanitizeTerminalText(call.summary),
        project_root: call.project_root == null ? call.project_root : sanitizeTerminalText(call.project_root),
      })),
      recent: input.runtime.recent.map((call) => ({
        ...call,
        tool: sanitizeTerminalText(call.tool),
        summary: sanitizeTerminalText(call.summary),
        error: call.error === undefined ? undefined : sanitizeTerminalText(call.error),
      })),
    },
    processes: input.processes.map((item) => ({
      ...item,
      command: sanitizeTerminalText(item.command),
      label: item.label === undefined ? undefined : sanitizeTerminalText(item.label),
      project_root: item.project_root == null ? item.project_root : sanitizeTerminalText(item.project_root),
    })),
    ptys: input.ptys.map((item) => ({
      ...item,
      command: item.command == null ? null : sanitizeTerminalText(item.command),
      project_root: item.project_root == null ? null : sanitizeTerminalText(item.project_root),
    })),
    subagents: input.subagents.map((item) => ({
      ...item,
      label: item.label === undefined ? undefined : sanitizeTerminalText(item.label),
      objective: sanitizeTerminalText(item.objective),
      requested_workspace: sanitizeTerminalText(item.requested_workspace),
    })),
    codingLoops: input.codingLoops?.map((loop) => ({
      ...loop,
      goal: sanitizeTerminalText(loop.goal),
      workspace: sanitizeTerminalText(loop.workspace),
      source_workspace: sanitizeTerminalText(loop.source_workspace || loop.workspace),
    })),
    tunnel: input.tunnel ? {
      ...input.tunnel,
      last_error: input.tunnel.last_error === null ? null : sanitizeTerminalText(input.tunnel.last_error),
    } : undefined,
    messages: input.messages.map((message) => ({
      ...message,
      text: sanitizeTerminalText(message.text),
    })),
  };
}

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
  // Follow the real viewport unless the operator explicitly requests a cap.
  const value = (raw ?? "auto").trim().toLowerCase();
  if (["auto", "full", "off", "0", "false", "no"].includes(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(MIN_DASHBOARD_ROWS, Math.min(MAX_DASHBOARD_ROWS, parsed));
}

export function dashboardViewportHeight(terminalRows: number, preferredRows: number | null): number {
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? Math.trunc(terminalRows) : 24;
  return Math.max(1, preferredRows === null ? rows : Math.min(rows, preferredRows));
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
  if (!Number.isFinite(ms)) return "unknown";
  ms = Math.max(0, ms);
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

type ProjectSummaryKind = "project" | "machine" | "unbound";

interface ProjectSummary {
  key: string;
  kind: ProjectSummaryKind;
  root: string | null;
  label: string;
  transports: number;
  connectedTransports: number;
  activeTools: number;
  workers: number;
  loops: number;
}

interface DashboardAlert {
  severity: "ok" | "warn" | "error";
  label: string;
  text: string;
}

function normalizedProjectKey(root: string): string {
  return root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function projectSummaryKey(kind: ProjectSummaryKind, root?: string | null): string {
  return kind === "project" && root ? `project:${normalizedProjectKey(root)}` : kind;
}

function projectSummaryLabel(kind: ProjectSummaryKind, root?: string | null, alias?: string | null): string {
  if (kind === "machine") return "Machine / host";
  if (kind === "unbound") return "Unbound";
  return alias || (root ? shortWorkspace(root) : "Project");
}

function buildProjectSummaries(model: DashboardRenderModel): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();
  const ensure = (kind: ProjectSummaryKind, root?: string | null, alias?: string | null): ProjectSummary => {
    const key = projectSummaryKey(kind, root);
    const existing = projects.get(key);
    if (existing) {
      if (alias && existing.kind === "project") existing.label = alias;
      return existing;
    }
    const created: ProjectSummary = {
      key,
      kind,
      root: kind === "project" ? root || null : null,
      label: projectSummaryLabel(kind, root, alias),
      transports: 0,
      connectedTransports: 0,
      activeTools: 0,
      workers: 0,
      loops: 0,
    };
    projects.set(key, created);
    return created;
  };

  for (const session of model.sessions || []) {
    const kind: ProjectSummaryKind = session.workspace_kind === "project"
      ? "project"
      : session.workspace_kind === "machine"
        ? "machine"
        : "unbound";
    const summary = ensure(kind, session.project_root, session.project_alias);
    summary.transports++;
    if (session.connection === "connected") summary.connectedTransports++;
  }

  for (const call of model.runtime.active) {
    const kind: ProjectSummaryKind = call.project_root
      ? "project"
      : call.workspace_kind === "machine"
        ? "machine"
        : "unbound";
    ensure(kind, call.project_root).activeTools++;
  }

  for (const worker of model.processes.filter((item) => item.running)) {
    ensure(worker.project_root ? "project" : "machine", worker.project_root).workers++;
  }
  for (const worker of model.ptys.filter((item) => item.running)) {
    ensure(worker.project_root ? "project" : "machine", worker.project_root).workers++;
  }
  for (const worker of model.subagents.filter((item) => item.running)) {
    ensure(worker.requested_workspace ? "project" : "machine", worker.requested_workspace || null).workers++;
  }
  for (const loop of (model.codingLoops || []).filter((item) => item.status === "active")) {
    ensure("project", loop.source_workspace || loop.workspace).loops++;
  }

  return [...projects.values()].sort((a, b) => {
    const activeA = a.activeTools + a.workers + a.loops;
    const activeB = b.activeTools + b.workers + b.loops;
    if (activeA !== activeB) return activeB - activeA;
    if (a.connectedTransports !== b.connectedTransports) return b.connectedTransports - a.connectedTransports;
    if (a.kind !== b.kind) return a.kind === "project" ? -1 : b.kind === "project" ? 1 : a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
}

function primaryProjectLabel(projects: ProjectSummary[], fallbackWorkspace: string): string {
  const activeProject = projects.find((item) => item.kind === "project" && (item.activeTools + item.workers + item.loops) > 0);
  if (activeProject) return activeProject.label;
  const connectedProject = projects.find((item) => item.kind === "project" && item.connectedTransports > 0);
  return connectedProject?.label || shortWorkspace(fallbackWorkspace);
}

function projectLabelForRoot(projects: ProjectSummary[], root?: string | null, machine = false): string {
  if (root) {
    return projects.find((item) => item.kind === "project" && item.root && normalizedProjectKey(item.root) === normalizedProjectKey(root))?.label
      || shortWorkspace(root);
  }
  return machine ? "Machine" : "Unbound";
}

function disconnectedActiveCall(model: DashboardRenderModel, nowMs: number) {
  const sessions = new Map((model.sessions || []).map((session) => [session.session_id, session]));
  return model.runtime.active.find((call) => {
    if (!call.session_id || nowMs - call.started_ms < 3_000) return false;
    const owner = sessions.get(call.session_id);
    return owner && owner.connection !== "connected";
  });
}

function dashboardAlert(model: DashboardRenderModel, nowMs: number): DashboardAlert {
  const latestProblem = [...model.messages].reverse().find(
    (item) => item.level !== "info" && nowMs - Date.parse(item.time) < 15_000
  );
  if (latestProblem?.level === "error") {
    return {
      severity: "error",
      label: "ERROR",
      text: latestProblem.text,
    };
  }

  const lost = disconnectedActiveCall(model, nowMs);
  if (lost) {
    return {
      severity: "warn",
      label: "CHAT TRANSPORT LOST",
      text: `work continues · ${lost.tool} · ${formatDuration(nowMs - lost.started_ms)}`,
    };
  }

  const disconnectedProject = buildProjectSummaries(model).find((project) => {
    const work = project.activeTools + project.workers + project.loops;
    return project.kind === "project" &&
      work > 0 &&
      project.transports > 0 &&
      project.connectedTransports === 0;
  });
  if (disconnectedProject) {
    return {
      severity: "warn",
      label: "CHAT TRANSPORT LOST",
      text: `work continues in ${disconnectedProject.label} · ${disconnectedProject.workers} worker(s) · ${disconnectedProject.loops} loop(s)`,
    };
  }

  const stalled = model.processes.filter((item) => item.running && item.liveness === "possibly_stalled");
  if (stalled.length) {
    return {
      severity: "warn",
      label: "WORKER MAY BE STALLED",
      text: `${stalled.length} background worker(s) · inspect last activity before stopping`,
    };
  }
  const silent = model.processes.filter((item) => item.running && item.liveness === "silent");
  if (silent.length) {
    return {
      severity: "warn",
      label: "WORKER SILENT",
      text: `${silent.length} background worker(s) have had no output for over 2 minutes`,
    };
  }
  if (model.tunnel && !["online", "disabled", "not_configured", "stopped"].includes(model.tunnel.status)) {
    return {
      severity: "warn",
      label: "TUNNEL DEGRADED",
      text: model.tunnel.last_error || `status ${model.tunnel.status}`,
    };
  }
  if (latestProblem) return { severity: "warn", label: "WARN", text: latestProblem.text };
  return {
    severity: "ok",
    label: "SYSTEM HEALTHY",
    text: `${model.tunnel?.status === "online" ? "tunnel connected · " : ""}no stalled work · ${model.runtime.total_errors} runtime error(s)`,
  };
}

function alertRow(alert: DashboardAlert, width: number, color: boolean): string {
  const code = alert.severity === "error" ? "31;1" : alert.severity === "warn" ? "33;1" : "32;1";
  const symbol = alert.severity === "ok" ? "●" : alert.severity === "warn" ? "⚠" : "✕";
  return row(`${ansi(code, `${symbol} ${alert.label}`, color)}  ${alert.text}`, width, color);
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
  const projects = buildProjectSummaries(model);
  const alert = dashboardAlert(model, nowMs);
  const project = primaryProjectLabel(projects, model.workspace);
  const alertPrefix = alert.severity === "ok" ? "OK" : alert.severity === "warn" ? "WARN" : "ERROR";
  const lines = [
    `Local Coder  ONLINE  ${clock(model.now)}`,
    `PROJECT ${project}  MCP:${model.mcpPort}  TUN:${tunnel?.status || "n/a"}`,
    `WORK tools:${model.runtime.active.length} workers:${running} loops:${activeLoops.length} transports:${model.sessionCount}`,
    active ? `${spinner(nowMs, false)} ${active.tool} ${formatDuration(nowMs - active.started_ms)}  ${active.summary}` : running ? `${running} background worker(s) still running` : "idle · waiting for tool calls",
    `${alertPrefix} ${alert.label} · ${alert.text}`,
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

export function renderDashboardFrame(rawModel: DashboardRenderModel): string {
  const model = safeDashboardModel(rawModel);
  const width = Math.max(1, Number.isFinite(model.width) ? Math.trunc(model.width) : 80);
  const height = Math.max(1, Number.isFinite(model.height) ? Math.trunc(model.height) : 24);
  // The full operator layout needs 20 rows in its most compact crowded state
  // (tunnel + loop + active call + project overflow + worker overflow + Health).
  // Below that, prefer the compact view instead of clipping the pinned alert.
  if (width < 64 || height < 20) return compactDashboard(model, width, height);
  const inner = width - 2;
  const lines: string[] = [];
  const nowMs = model.now.getTime();
  const uptime = formatDuration(Math.max(0, nowMs - model.startedAtMs));
  const online = ansi("32;1", "● ONLINE", model.color);
  const activeLoops = (model.codingLoops || []).filter((loop) => loop.status === "active");
  const runningProcesses = model.processes.filter((item) => item.running);
  const runningPtys = model.ptys.filter((item) => item.running);
  const runningAgents = model.subagents.filter((item) => item.running);
  const projects = buildProjectSummaries(model);
  const alert = dashboardAlert(model, nowMs);
  const primaryProject = primaryProjectLabel(projects, model.workspace);
  const connectedTransports = (model.sessions || []).filter((session) => session.connection === "connected").length;

  const titleLeft = ` Local Coder `;
  const titleRight = ` ${online} `;
  if (width >= measureTerminalCells(titleLeft) + measureTerminalCells(titleRight) + 4) {
    const titleFill = Math.max(0, width - measureTerminalCells(titleLeft) - measureTerminalCells(titleRight) - 2);
    lines.push(`${tone("┌", model.color, "2")}${ansi("1", titleLeft, model.color)}${tone("─".repeat(titleFill), model.color, "2")}${titleRight}${tone("┐", model.color, "2")}`);
  } else {
    lines.push(`${tone("┌", model.color, "2")}${ansi("1", pad(" Local Coder", width - 2), model.color)}${tone("┐", model.color, "2")}`);
  }
  lines.push(row([
    metric("PROJECT", primaryProject, model.color, "37;1"),
    metric("TIME", clock(model.now), model.color),
    metric("UP", uptime, model.color),
    ansi("2", lastToolLabel(model.runtime, nowMs), model.color),
    metric("CPU", `${model.cpuPercent.toFixed(1)}%`, model.color, healthColor(model.cpuPercent)),
    metric("RSS", formatBytes(model.rssBytes), model.color),
  ].join("  "), width, model.color));

  lines.push(section("Overview", width, model.color));
  const keepAlive = model.transportMode === "sse" ? ` keepalive ${Math.round(model.keepAliveMs / 1000)}s` : "";
  lines.push(row([
    metric("MCP", `:${model.mcpPort}`, model.color),
    ansi("1", `${model.transportMode.toUpperCase()}${keepAlive}`, model.color),
    metric("TRANSPORTS", `${connectedTransports}/${model.sessionCount} connected`, model.color, connectedTransports ? "32;1" : "2"),
    metric("AUTH", model.authEnabled ? "ON" : "OFF", model.color, model.authEnabled ? "32;1" : "33;1"),
    metric("PROFILE", model.toolProfile, model.color),
    metric("PID", String(process.pid), model.color),
  ].join("  "), width, model.color));
  if (model.tunnel) {
    const tunnelCode = model.tunnel.status === "online"
      ? "32;1"
      : ["disabled", "not_configured", "stopped"].includes(model.tunnel.status)
        ? "2"
        : "33;1";
    lines.push(row([
      metric("TUNNEL", model.tunnel.status.toUpperCase(), model.color, tunnelCode),
      metric("READY", model.tunnel.status === "online" ? "YES" : "NO", model.color, model.tunnel.status === "online" ? "32;1" : "33;1"),
      metric("RESTARTS", String(model.tunnel.restarts), model.color),
      model.tunnel.last_ready_at ? ansi("2", `last ready ${formatDuration(Math.max(0, nowMs - Date.parse(model.tunnel.last_ready_at)))} ago`, model.color) : "",
      model.tunnel.reused_external ? ansi("2", "reused existing tunnel", model.color) : "",
    ].filter(Boolean).join("  "), width, model.color));
  }
  lines.push(row([
    metric("POLICY", model.permission.split(":", 1)[0], model.color, model.permission.startsWith("open") ? "32;1" : "33;1"),
    metric("HEAP", formatBytes(model.heapBytes), model.color),
    metric("CALLS", `${model.runtime.total_calls}`, model.color),
    metric("ERRORS", String(model.runtime.total_errors), model.color, model.runtime.total_errors ? "31;1" : "32;1"),
    metric("ADMIN", `:${model.adminPort}`, model.color),
  ].join("  "), width, model.color));


  lines.push(section(`Current work (${model.runtime.active.length} tools · ${activeLoops.length} loops)`, width, model.color));
  if (activeLoops.length) {
    const loop = activeLoops[0];
    const attempt = `${loop.attempts.length}/${loop.max_attempts}`;
    const lastAttempt = loop.attempts.at(-1);
    const verify = lastAttempt ? `verify ${lastAttempt.passed}✓/${lastAttempt.failed}✕` : "not verified";
    const loopProject = projectLabelForRoot(projects, loop.source_workspace || loop.workspace, false);
    lines.push(row(
      `${ansi("1", "LOOP", model.color)} ${ansi(loop.phase === "blocked" || loop.phase === "failed" ? "33;1" : "36;1", loop.phase.toUpperCase(), model.color)} ${ansi("2", attempt, model.color)}  ${loopProject}  ${loop.goal}  ·  ${verify}`,
      width,
      model.color
    ));
  }
  const busy = model.runtime.active.length + runningProcesses.length + runningPtys.length + runningAgents.length + projects.length > 0;
  const activityReserve = busy ? Math.min(5, model.runtime.recent.length || 1) : Math.min(20, model.runtime.recent.length || 1);
  const activeBudget = Math.max(1, height - lines.length - 9 - activityReserve);
  const activeSlots = Math.min(model.runtime.active.length || 1, height >= 36 ? 4 : 2, activeBudget);
  if (!model.runtime.active.length) {
    const workerCount = runningProcesses.length + runningPtys.length + runningAgents.length;
    lines.push(row(workerCount > 0
      ? `${ansi("36;1", "WORK CONTINUES", model.color)}  ·  ${workerCount} background worker(s) running without an active tool call`
      : `${ansi("2", "idle", model.color)}  ·  waiting for tool calls`, width, model.color));
  } else {
    for (const call of model.runtime.active.slice(0, activeSlots)) {
      const elapsed = formatDuration(nowMs - call.started_ms).padStart(6);
      const project = projectLabelForRoot(projects, call.project_root, call.workspace_kind === "machine");
      lines.push(row(`${spinner(nowMs, model.color)} ${kindLabel(call.kind, model.color)} ${ansi("1", call.tool.padEnd(20).slice(0, 20), model.color)} ${ansi("2", elapsed, model.color)}  ${ansi("2", project, model.color)}  ${call.summary}`, width, model.color));
    }
    if (model.runtime.active.length > activeSlots && height - lines.length > 10 + activityReserve) {
      lines.push(row(`… ${model.runtime.active.length - activeSlots} more active call(s)`, width));
    }
  }

  lines.push(section(`Projects / transports (${projects.length})`, width, model.color));
  const projectBudget = Math.max(1, height - lines.length - 7 - activityReserve);
  const projectSlots = Math.min(projects.length || 1, height >= 40 ? 8 : height >= 32 ? 5 : 2, projectBudget);
  if (!projects.length) {
    lines.push(row(ansi("2", "no project/transport activity yet", model.color), width, model.color));
  } else {
    for (const project of projects.slice(0, projectSlots)) {
      const work = project.activeTools + project.workers + project.loops;
      const workingWithoutChat = work > 0 && project.connectedTransports === 0;
      const symbol = work > 0 ? ansi(workingWithoutChat ? "33;1" : "32;1", "●", model.color) : ansi("2", "○", model.color);
      const state = workingWithoutChat
        ? ansi("33;1", "WORK CONTINUES", model.color)
        : work > 0
          ? ansi("32;1", "ACTIVE", model.color)
          : project.connectedTransports > 0
            ? ansi("2", "IDLE", model.color)
            : ansi("2", "OFFLINE", model.color);
      lines.push(row([
        symbol,
        ansi("1", project.label.padEnd(24).slice(0, 24), model.color),
        metric("CHAT", `${project.connectedTransports}/${project.transports}`, model.color),
        metric("TOOLS", String(project.activeTools), model.color),
        metric("WORKERS", String(project.workers), model.color),
        metric("LOOPS", String(project.loops), model.color),
        state,
      ].join("  "), width, model.color));
    }
    if (projects.length > projectSlots && height - lines.length > 8 + activityReserve) lines.push(row(`… ${projects.length - projectSlots} more workspace(s)`, width, model.color));
  }

  const runningCount = runningProcesses.length + runningPtys.length + runningAgents.length;
  lines.push(section(`Workers (${runningCount})`, width, model.color));
  const runningRows: Array<{ text: string; priority: number }> = [];
  for (const item of runningProcesses) {
    const project = projectLabelForRoot(projects, item.project_root, !item.project_root);
    const activityAge = Math.max(0, nowMs - Date.parse(item.last_activity_at));
    const state = item.liveness === "possibly_stalled"
      ? ansi("33;1", "STALLED?", model.color)
      : item.liveness === "silent"
        ? ansi("33;1", "SILENT", model.color)
        : ansi("32;1", "ACTIVE", model.color);
    runningRows.push({
      text: `BG    ${String(item.pid ?? "-").padEnd(7)} ${state}  ${formatDuration(nowMs - Date.parse(item.started_at)).padStart(6)}  ${project}  activity ${formatDuration(activityAge)} ago  ${item.label || item.command}`,
      priority: item.liveness === "possibly_stalled" ? 0 : item.liveness === "silent" ? 1 : 2,
    });
  }
  for (const item of runningPtys) {
    const project = projectLabelForRoot(projects, item.project_root, !item.project_root);
    runningRows.push({ text: `PTY   ${String(item.pid ?? "-").padEnd(7)} ${ansi("32;1", "ACTIVE", model.color)}  ${formatDuration(nowMs - Date.parse(item.started_at)).padStart(6)}  ${project}  ${item.command || "interactive shell"}`, priority: 2 });
  }
  for (const item of runningAgents) {
    const project = projectLabelForRoot(projects, item.requested_workspace, false);
    runningRows.push({ text: `AGENT ${String(item.pid ?? "-").padEnd(7)} ${ansi("32;1", "ACTIVE", model.color)}  ${formatDuration(nowMs - Date.parse(item.started_at)).padStart(6)}  ${project}  ${item.label || item.objective}`, priority: 2 });
  }
  runningRows.sort((a, b) => a.priority - b.priority);
  const workerBudget = Math.max(1, height - lines.length - 5 - activityReserve);
  const workerSlots = Math.min(runningRows.length || 1, height >= 40 ? 6 : height >= 32 ? 4 : 2, workerBudget);
  if (!runningRows.length) lines.push(row(`${ansi("2", "none", model.color)}  ·  no background process, PTY, or subagent`, width, model.color));
  else for (const item of runningRows.slice(0, workerSlots)) lines.push(row(item.text, width, model.color));
  if (runningRows.length > workerSlots && height - lines.length > 6 + activityReserve) lines.push(row(`… ${runningRows.length - workerSlots} more running item(s)`, width, model.color));

  lines.push(section("Activity", width, model.color));
  const footerReserve = 3;
  const recentSlots = Math.max(0, Math.min(20, height - lines.length - footerReserve));
  const recent = model.runtime.recent.slice(0, recentSlots);
  if (!recent.length && recentSlots > 0) lines.push(row(`${ansi("2", "no completed calls yet", model.color)}`, width));
  for (const item of recent) {
    const time = new Date(item.finished_at).toLocaleTimeString("en-GB", { hour12: false });
    const summary = item.status === "error" ? item.error || item.summary : item.summary;
    lines.push(row(`${toolStatusSymbol(item.status, model.color)} ${ansi("2", time, model.color)} ${kindLabel(item.kind, model.color)} ${ansi("1", item.tool.padEnd(21).slice(0, 21), model.color)} ${ansi("2", formatDuration(item.duration_ms).padStart(6), model.color)}  ${summary}`, width, model.color));
  }

  while (lines.length < height - 3) lines.push(row("", width, model.color));
  lines.push(section("Health", width, model.color));
  lines.push(alertRow(alert, width, model.color));
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
  let listRefreshTimer: NodeJS.Timeout | undefined;
  let codingLoops: CodingLoopRecord[] = [];
  let resizeTimer: NodeJS.Timeout | undefined;
  let renderQueued = false;
  let lastFrame = "";
  let lastFrameDimensions = "";
  let loopRefreshInFlight = false;
  let viewState = initialConsoleView();
  let registeredProjects: ProjectRegistryEntry[] = [];
  let auditHistory: ActivityEntry[] = [];
  let latestModel: DashboardRenderModel | null = null;
  let refreshPromise: Promise<void> | null = null;
  let pendingWorkspaceRoot: string | null = null;
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
    const dashboardHeight = dashboardViewportHeight(lastHeight, preferredRows);
    const model: DashboardRenderModel = {
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
    };
    latestModel = model;
    const frame = renderTuiConsolePage(model, {
      state: viewState, registry: registeredProjects,
      auditHistory, liveHistory: getRecentActivity(500),
    });
    const dimensions = `${lastWidth}x${dashboardHeight}`;
    if (frame === lastFrame && dimensions === lastFrameDimensions) return;
    const needsClear = dimensions !== lastFrameDimensions || lastWidth < 64 || dashboardHeight < 20;
    // CRLF keeps each row at column one even when the terminal does not
    // implement automatic newline mode. LF alone can indent following rows.
    process.stdout.write(`${needsClear ? CLEAR : CSI + "H"}${frame.replace(/\n/g, "\r\n")}`);
    lastFrame = frame;
    lastFrameDimensions = dimensions;
  };

  function queueRender(): void {
    if (renderQueued || stopped) return;
    renderQueued = true;
    setImmediate(render);
  }

  const unsubscribe = subscribeRuntimeState(queueRender);
  const refreshLists = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const [projects, history] = await Promise.all([
          listRegisteredProjects(), loadAuditHistory(200),
        ]);
        if (stopped) return;
        registeredProjects = projects;
        auditHistory = history;
        queueRender();
      } catch (error) {
        viewState.notice = "Refresh failed: " + String(error);
        queueRender();
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };
  void refreshLists();
  listRefreshTimer = setInterval(() => {
    if (viewState.tab === "workspaces" || viewState.tab === "history" || viewState.tab === "logs") {
      void refreshLists();
    }
  }, 5000);
  listRefreshTimer.unref?.();
  const refreshCodingLoops = async () => {
    if (stopped || loopRefreshInFlight) return;
    loopRefreshInFlight = true;
    try {
      codingLoops = await listCodingLoops(8);
      queueRender();
    } catch {
      // Keep the last successfully read loop snapshot during transient I/O.
    } finally {
      loopRefreshInFlight = false;
    }
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
  const stdin = process.stdin;
  const keyboardAvailable = Boolean(stdin.isTTY && typeof stdin.setRawMode === "function");
  const previousRawMode = Boolean(stdin.isRaw);
  const stdinWasPaused = stdin.isPaused();
  let keyboardEnabled = false;
  let keyActionInFlight = false;
  const queuedKeys: Array<{ text: string; key: { name?: string; ctrl?: boolean; shift?: boolean } }> = [];
  const onKeypress = (text: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    if (stopped) return;
    if (key.ctrl && key.name === "c") {
      // Raw mode does not synthesize SIGINT. Preserve the server's existing
      // signal handler rather than swallowing Ctrl+C inside the dashboard.
      process.kill(process.pid, "SIGINT");
      return;
    }
    if (keyActionInFlight) {
      // Don't silently swallow quick shortcuts while the registry/audit file
      // is loading or a previously confirmed mutation is being persisted.
      if (queuedKeys.length < 16) queuedKeys.push({ text, key });
      return;
    }
    const name = key.name === "return" ? "enter" : (key.name || text).toLowerCase();
    if (!name) return;
    const current = latestModel;
    if (!current) return;
    const before = viewState;
    const data = { state: before, registry: registeredProjects, auditHistory, liveHistory: getRecentActivity(500) };
    const rows = consoleItems(current, data);
    const selectedWorkspace = before.tab === "workspaces"
      ? consoleWorkspaces(current, registeredProjects, before.sort)[before.selected]
      : undefined;
    const outcome = reduceConsoleKey(before, name, rows.length);
    viewState = outcome.state;
    if (viewState.pending === "forget" && !before.pending) pendingWorkspaceRoot = selectedWorkspace?.root || null;
    if (!viewState.pending && outcome.action !== "forget") pendingWorkspaceRoot = null;
    queueRender();
    if (outcome.action === "none") return;
    keyActionInFlight = true;
    void (async () => {
      try {
        if (outcome.action === "refresh") await refreshLists();
        if (outcome.action === "pin") {
          if (!selectedWorkspace?.registered) throw new Error("This is a live-only workspace, not a saved registry entry.");
          if (!await setRegisteredProjectPinned(selectedWorkspace.root, !selectedWorkspace.pinned)) throw new Error("Workspace is no longer registered.");
          await refreshLists();
          viewState.notice = selectedWorkspace.pinned ? "Unpinned workspace" : "Pinned workspace";
        }
        if (outcome.action === "forget") {
          if (!selectedWorkspace || !pendingWorkspaceRoot
            || normalizedProjectKey(selectedWorkspace.root) !== normalizedProjectKey(pendingWorkspaceRoot)) {
            throw new Error("Selection changed; removal cancelled.");
          }
          if (!selectedWorkspace.registered) throw new Error("Live-only workspace has no registry entry.");
          const isBusy = (root: string) => {
            const fresh: DashboardRenderModel = {
              ...current, sessions: options.sessionSnapshot?.() ?? [],
              runtime: getRuntimeSnapshot(), processes: getManagedProcessSnapshot(),
              ptys: getPtySessionSnapshot(), subagents: listSubagents(), codingLoops,
            };
            return workspaceHasLiveWork(fresh, root);
          };
          if (!await forgetRegisteredProject(selectedWorkspace.root, isBusy)) throw new Error("Workspace is not registered.");
          pendingWorkspaceRoot = null;
          viewState.selected = Math.max(0, viewState.selected - 1);
          await refreshLists();
          viewState.notice = "Unregistered only; folder and files remain untouched.";
        }
        if (outcome.action === "archive") {
          const archivePath = await archiveCurrentAuditLog();
          clearRecentActivity();
          clearCompletedToolHistory();
          auditHistory = [];
          messages.length = 0;
          viewState.selected = 0;
          viewState.notice = archivePath
            ? "Active audit log archived safely; current history cleared."
            : "Current history cleared; no audit file existed.";
        }
      } catch (error) {
        viewState.notice = error instanceof Error ? error.message : String(error);
      } finally {
        keyActionInFlight = false;
        queueRender();
        const queued = queuedKeys.shift();
        if (queued && !stopped) setImmediate(() => onKeypress(queued.text, queued.key));
      }
    })();
  };
  if (keyboardAvailable) {
    try {
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.on("keypress", onKeypress);
      stdin.resume();
      keyboardEnabled = true;
    } catch {
      viewState.notice = "Keyboard input unavailable; see Admin UI for controls.";
    }
  }
  // The xterm window-size request is optional and is intentionally not sent
  // in auto mode: many Windows terminals ignore it or require user consent.
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
    if (listRefreshTimer) clearInterval(listRefreshTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    unsubscribe();
    process.stdout.off("resize", resize);
    if (keyboardEnabled) {
      stdin.off("keypress", onKeypress);
      try { stdin.setRawMode(previousRawMode); } catch {}
      if (stdinWasPaused) stdin.pause();
    }
    process.off("exit", stop);
    setActivityConsoleEnabled(true);
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    process.stdout.write(`${CURSOR_SHOW}${ALT_OFF}`);
  };

  process.once("exit", stop);
  return { active: true, renderNow: queueRender, stop };
}