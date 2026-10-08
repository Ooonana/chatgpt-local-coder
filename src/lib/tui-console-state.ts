export type ConsoleTab = "overview" | "workspaces" | "history" | "workers" | "logs" | "help";
export type ConsoleSort = "active" | "recent" | "name";
export type ConsoleAction = "none" | "refresh" | "pin" | "forget" | "archive";

export interface ConsoleViewState {
  tab: ConsoleTab;
  selected: number;
  sort: ConsoleSort;
  errorsOnly: boolean;
  pending: "forget" | "archive" | null;
  notice: string;
}

export function initialConsoleView(): ConsoleViewState {
  return { tab: "overview", selected: 0, sort: "active", errorsOnly: false, pending: null, notice: "" };
}

/** A pure reducer keeps destructive keyboard commands behind confirmation. */
export function reduceConsoleKey(
  state: ConsoleViewState,
  key: string,
  count: number
): { state: ConsoleViewState; action: ConsoleAction } {
  const next = { ...state };
  const tabKeys: Record<string, ConsoleTab> = {
    "1": "overview", "2": "workspaces", "3": "history", "4": "workers", "5": "logs",
    "?": "help", "h": "help",
  };
  if (key === "escape") {
    if (next.pending) next.pending = null;
    else next.tab = "overview";
    next.notice = "";
    return { state: next, action: "none" };
  }
  if (key === "q") return { state: { ...next, tab: "overview", pending: null }, action: "none" };
  if (key in tabKeys || key === "tab") {
    const tabs: ConsoleTab[] = ["overview", "workspaces", "history", "workers", "logs"];
    next.tab = key === "tab" ? tabs[(tabs.indexOf(next.tab) + 1) % tabs.length] : tabKeys[key];
    next.selected = 0;
    next.pending = null;
    next.notice = "";
    return { state: next, action: next.tab === "history" || next.tab === "logs" || next.tab === "workspaces" ? "refresh" : "none" };
  }
  if (next.pending) {
    const pending = next.pending;
    next.pending = null;
    if (key === "enter" || key === "y") return { state: next, action: pending === "forget" ? "forget" : "archive" };
    next.notice = "Cancelled";
    return { state: next, action: "none" };
  }
  const length = Math.max(0, count);
  if (key === "up" || key === "k") next.selected = Math.max(0, next.selected - 1);
  else if (key === "down" || key === "j") next.selected = Math.min(length - 1, next.selected + 1);
  else if (key === "pageup") next.selected = Math.max(0, next.selected - 10);
  else if (key === "pagedown") next.selected = Math.min(length - 1, next.selected + 10);
  else if (key === "home") next.selected = 0;
  else if (key === "end") next.selected = Math.max(0, length - 1);
  else if (key === "r") return { state: next, action: "refresh" };
  else if (key === "s" && next.tab === "workspaces") {
    next.sort = next.sort === "active" ? "recent" : next.sort === "recent" ? "name" : "active";
    next.selected = 0;
  } else if (key === "e" && next.tab === "history") {
    next.errorsOnly = !next.errorsOnly;
    next.selected = 0;
  } else if (key === "p" && next.tab === "workspaces" && length) {
    return { state: next, action: "pin" };
  } else if (key === "x" && next.tab === "workspaces" && length) {
    next.pending = "forget";
  } else if (key === "c" && (next.tab === "history" || next.tab === "logs")) {
    next.pending = "archive";
  }
  next.selected = Math.max(0, Math.min(Math.max(0, length - 1), next.selected));
  return { state: next, action: "none" };
}