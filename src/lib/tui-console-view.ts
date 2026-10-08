import { measureTerminalCells, renderDashboardFrame, sanitizeTerminalText, type DashboardRenderModel } from "./terminal-dashboard.js";
import type { ProjectRegistryEntry } from "./project-affinity.js";
import type { ActivityEntry } from "./activity-log.js";
import type { ConsoleSort, ConsoleViewState } from "./tui-console-state.js";

export interface TuiWorkspace {
  root: string;
  alias: string;
  registered: boolean;
  pinned: boolean;
  active: number;
  connected: number;
  lastUsed: string;
  uses: number;
}

export interface TuiPageData {
  state: ConsoleViewState;
  registry: ProjectRegistryEntry[];
  auditHistory: ActivityEntry[];
  liveHistory: ActivityEntry[];
}

const pathKey = (root: string) => root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const basename = (root: string) => root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root;

export function consoleWorkspaces(model: DashboardRenderModel, registry: ProjectRegistryEntry[], sort: ConsoleSort): TuiWorkspace[] {
  const workspaces = new Map<string, TuiWorkspace>();
  const ensure = (root: string, alias?: string): TuiWorkspace => {
    const key = pathKey(root);
    let result = workspaces.get(key);
    if (!result) {
      result = {
        root, alias: alias || basename(root), registered: false, pinned: false,
        active: 0, connected: 0, lastUsed: "", uses: 0,
      };
      workspaces.set(key, result);
    }
    return result;
  };
  for (const entry of registry) {
    const value = ensure(entry.root, entry.alias);
    value.alias = entry.alias;
    value.registered = true;
    value.pinned = Boolean(entry.pinned);
    value.lastUsed = entry.last_used_at;
    value.uses = entry.uses;
  }
  for (const session of model.sessions || []) {
    if (session.project_root) {
      const value = ensure(session.project_root, session.project_alias || undefined);
      if (session.connection === "connected") value.connected++;
    }
  }
  for (const tool of model.runtime.active) if (tool.project_root) ensure(tool.project_root).active++;
  for (const item of model.processes) if (item.running && item.project_root) ensure(item.project_root).active++;
  for (const item of model.ptys) if (item.running && item.project_root) ensure(item.project_root).active++;
  for (const item of model.subagents) if (item.running && item.requested_workspace) ensure(item.requested_workspace).active++;
  for (const loop of model.codingLoops || []) if (loop.status === "active") ensure(loop.source_workspace || loop.workspace).active++;
  return [...workspaces.values()].sort((a, b) => {
    if (sort === "name") return a.alias.localeCompare(b.alias);
    if (sort === "recent") return b.lastUsed.localeCompare(a.lastUsed);
    return Number(b.active > 0) - Number(a.active > 0)
      || b.active - a.active
      || Number(Boolean(b.connected)) - Number(Boolean(a.connected))
      || Number(b.pinned) - Number(a.pinned)
      || b.lastUsed.localeCompare(a.lastUsed);
  });
}

export function workspaceHasLiveWork(model: DashboardRenderModel, root: string): boolean {
  const key = pathKey(root);
  return (model.sessions || []).some((session) => session.connection === "connected" && session.project_root && pathKey(session.project_root) === key)
    || model.runtime.active.some((item) => item.project_root && pathKey(item.project_root) === key)
    || model.processes.some((item) => item.running && item.project_root && pathKey(item.project_root) === key)
    || model.ptys.some((item) => item.running && item.project_root && pathKey(item.project_root) === key)
    || model.subagents.some((item) => item.running && item.requested_workspace && pathKey(item.requested_workspace) === key)
    || (model.codingLoops || []).some((item) => item.status === "active" && pathKey(item.source_workspace || item.workspace) === key);
}

export function consoleHistory(data: TuiPageData): ActivityEntry[] {
  const all = [...data.liveHistory, ...data.auditHistory].sort((a, b) => b.time.localeCompare(a.time));
  return data.state.errorsOnly
    ? all.filter((item) => item.status === "error" || item.status === "blocked")
    : all;
}

export function consoleItems(model: DashboardRenderModel, data: TuiPageData): string[] {
  const state = data.state;
  if (state.tab === "workspaces") return consoleWorkspaces(model, data.registry, state.sort).map((item) => {
    const status = item.active ? "ACTIVE " + item.active : item.connected ? "CONNECTED" : "IDLE";
    return (item.pinned ? "* " : "  ") + item.alias.padEnd(22).slice(0, 22)
      + "  " + status.padEnd(12) + "  " + (item.registered ? "saved" : "live ") + "  " + item.root;
  });
  if (state.tab === "history") return consoleHistory(data).map((item) => {
    const date = item.time ? item.time.replace("T", " ").slice(5, 19) : "-";
    return date + "  " + (item.status || item.kind).padEnd(8).slice(0, 8)
      + "  " + (item.tool || item.action || item.kind).padEnd(20).slice(0, 20)
      + "  " + (item.summary || item.target || "");
  });
  if (state.tab === "workers") {
    const records: Array<{ priority: number; text: string }> = [];
    for (const item of model.processes) {
      const status = item.running ? item.liveness.toUpperCase() : "EXITED";
      records.push({
        priority: item.running ? item.liveness === "possibly_stalled" ? 0 : item.liveness === "silent" ? 1 : 2 : 4,
        text: "BG " + status.padEnd(11) + " pid=" + (item.pid ?? "-")
          + "  " + basename(item.project_root || item.cwd) + "  " + (item.label || item.command),
      });
    }
    for (const item of model.ptys) records.push({
      priority: item.running ? 2 : 4,
      text: "PTY " + (item.running ? "ACTIVE " : "EXITED ") + " pid=" + (item.pid ?? "-")
        + "  " + basename(item.project_root || item.cwd) + "  " + (item.command || "shell"),
    });
    for (const item of model.subagents) records.push({
      priority: item.running ? 2 : 4,
      text: "AGENT " + (item.running ? "ACTIVE " : "EXITED ") + " pid=" + (item.pid ?? "-")
        + "  " + basename(item.requested_workspace || "") + "  " + (item.label || item.objective),
    });
    return records.sort((a, b) => a.priority - b.priority).map((record) => record.text);
  }
  if (state.tab === "logs") {
    const captured = model.messages.map((item) => ({
      time: item.time,
      text: item.time.replace("T", " ").slice(5, 19) + "  " + item.level.toUpperCase().padEnd(5) + "  " + item.text,
    }));
    const historical = [...data.auditHistory, ...data.liveHistory].map((item) => ({
      time: item.time,
      text: item.time.replace("T", " ").slice(5, 19) + "  " + (item.status || item.kind).padEnd(5)
        + "  " + (item.tool || item.action || item.kind) + "  " + (item.summary || item.target || ""),
    }));
    return [...captured, ...historical].sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 500).map((entry) => entry.text);
  }
  if (state.tab === "help") return [
    "1-5      Overview / Workspaces / History / Workers / Logs",
    "Tab      Switch to the next view",
    "Up/Down, J/K, PageUp/PageDown, Home/End     Navigate",
    "S        Change workspace order (active / recent / name)",
    "P        Pin or unpin selected registered workspace",
    "X        Unregister selected workspace (requires confirmation)",
    "E        Toggle history errors-only filter",
    "R        Refresh saved workspaces and historical audit entries",
    "C        Archive active audit log and clear displayed history (confirm)",
    "Enter/Y  Confirm a pending action; Escape cancels",
    "Q/Esc    Return to overview; Ctrl+C stops Local Coder",
    "",
    "Unregistering never deletes folders, projects, source code, or Git worktrees.",
    "Connected or busy workspaces are protected from unregistering.",
    "Clear log archives the original audit file instead of destroying it.",
  ];
  return [];
}

function cropToWidth(value: string, width: number): string {
  const text = sanitizeTerminalText(value);
  if (measureTerminalCells(text) <= width) return text;
  const target = Math.max(0, width - 2);
  let result = "";
  for (const char of text) {
    if (measureTerminalCells(result + char) > target) break;
    result += char;
  }
  return result + (width >= 2 ? ".." : "");
}
function fit(value: string, width: number): string {
  const text = cropToWidth(value, Math.max(0, width));
  return text + " ".repeat(Math.max(0, width - measureTerminalCells(text)));
}
function framed(text: string, width: number, selected = false, color = false): string {
  if (width < 3) return cropToWidth(text, width);
  const contents = fit(" " + text, width - 2);
  return "│" + (selected && color ? "\x1b[7m" + contents + "\x1b[0m" : contents) + "│";
}

export function renderTuiConsolePage(model: DashboardRenderModel, data: TuiPageData): string {
  const width = Math.max(1, Number.isFinite(model.width) ? Math.trunc(model.width) : 80);
  const height = Math.max(1, Number.isFinite(model.height) ? Math.trunc(model.height) : 24);
  const tabs = [
    ["1", "Overview", "overview"], ["2", "Workspaces", "workspaces"],
    ["3", "History", "history"], ["4", "Workers", "workers"],
    ["5", "Logs", "logs"], ["?", "Help", "help"],
  ];
  const nav = tabs.map(([key, label, tab]) =>
    data.state.tab === tab ? "[" + key + " " + label.toUpperCase() + "]" : key + " " + label
  ).join("  ");
  if (data.state.tab === "overview") {
    const lines = renderDashboardFrame(model).split("\n");
    if (width >= 64 && height >= 20 && lines.length >= 4) {
      lines[2] = framed(nav, width);
    } else {
      lines[0] = cropToWidth("LOCAL CODER | " + nav, width);
    }
    return lines.join("\n");
  }
  const items = consoleItems(model, data);
  const selected = Math.min(Math.max(0, data.state.selected), Math.max(0, items.length - 1));
  if (width < 48 || height < 12) {
    return [
      "Local Coder / " + data.state.tab.toUpperCase(),
      nav,
      ...items.slice(Math.max(0, selected - 1), Math.max(0, selected - 1) + Math.max(0, height - 3)),
      data.state.pending ? "CONFIRM Enter/Y or Esc" : "Arrows navigate | ? Help",
    ].slice(0, height).map((line) => cropToWidth(line, width)).join("\n");
  }
  const lines = [
    "┌" + "─".repeat(width - 2) + "┐",
    framed("LOCAL CODER  /  " + data.state.tab.toUpperCase() + "  |  MCP :" + model.mcpPort, width),
    framed(nav, width),
    framed("─ " + data.state.tab.toUpperCase() + " (" + items.length + ")"
      + (data.state.tab === "workspaces" ? "  sort: " + data.state.sort : "")
      + (data.state.tab === "history" && data.state.errorsOnly ? "  errors only" : ""), width),
  ];
  const capacity = Math.max(1, height - 9);
  const start = Math.min(Math.max(0, items.length - capacity), Math.max(0, selected - capacity + 1));
  const visible = items.slice(start, start + capacity);
  if (!visible.length) lines.push(framed("No entries. Press R to refresh.", width));
  else visible.forEach((text, index) => lines.push(framed(
    (start + index === selected ? "> " : "  ") + text, width, start + index === selected, model.color
  )));
  while (lines.length < height - 5) lines.push(framed("", width));
  const workspace = data.state.tab === "workspaces"
    ? consoleWorkspaces(model, data.registry, data.state.sort)[selected] : undefined;
  const detail = workspace
    ? "PATH: " + workspace.root + "   " + (workspace.pinned ? "PINNED  " : "") + workspace.uses + " uses"
    : items.length ? "Selected " + (selected + 1) + "/" + items.length : "No selection";
  lines.push(framed(detail, width));
  const instructions = data.state.tab === "workspaces"
    ? "P pin  X unregister  S sort  R reload" : data.state.tab === "history"
      ? "E errors-only  C archive/clear  R refresh" : data.state.tab === "logs"
        ? "C archive/clear logs  R refresh" : "Tab next  ? help";
  const confirmation = data.state.pending === "forget"
    ? "CONFIRM registry-only removal? Enter/Y confirms. Esc cancels."
    : data.state.pending === "archive"
      ? "CONFIRM archive audit log and clear live history? Enter/Y confirms."
      : data.state.notice || instructions;
  lines.push(framed(confirmation, width));
  lines.push(framed("Up/Down navigate   Tab next   Esc back   Ctrl+C stop", width));
  lines.push(framed("HEALTH  " + model.runtime.active.length + " active calls"
    + "  |  " + model.runtime.total_errors + " errors", width));
  lines.push("└" + "─".repeat(width - 2) + "┘");
  return lines.slice(0, height).join("\n");
}