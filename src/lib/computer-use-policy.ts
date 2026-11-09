/**
 * Only a deliberate subset of Vercel's MCP tools is reachable through
 * Local Coder's convenient computer-use entrypoints. Arbitrary shell, JS
 * evaluation, clipboard, credential, and destructive window operations do
 * not belong on this default surface.
 */
export type ComputerUseProvider = "desktop" | "browser";

export const COMPUTER_USE_PROVIDER_IDS: Record<ComputerUseProvider, string> = {
  desktop: "vercel-agent-desktop",
  browser: "vercel-agent-browser",
};

const OBSERVATIONS: Record<ComputerUseProvider, ReadonlySet<string>> = {
  desktop: new Set([
    "desktop_snapshot", "desktop_find", "desktop_get", "desktop_is",
    "desktop_screenshot", "desktop_list_apps", "desktop_list_windows",
    "desktop_list_displays", "desktop_list_surfaces", "desktop_status",
    "desktop_permissions",
  ]),
  browser: new Set([
    "agent_browser_read", "agent_browser_snapshot", "agent_browser_screenshot",
    "agent_browser_get_text", "agent_browser_get_url", "agent_browser_get_title",
    "agent_browser_tab_list", "agent_browser_tools_profiles",
    "agent_browser_get_cdp_url",
  ]),
};

const ACTIONS: Record<ComputerUseProvider, ReadonlySet<string>> = {
  desktop: new Set([
    "desktop_click", "desktop_double_click", "desktop_type",
    "desktop_set_value", "desktop_clear", "desktop_focus", "desktop_scroll",
    "desktop_scroll_to", "desktop_focus_window", "desktop_wait",
  ]),
  browser: new Set([
    "agent_browser_connect",
    "agent_browser_open", "agent_browser_click", "agent_browser_fill",
    "agent_browser_type", "agent_browser_press", "agent_browser_check",
    "agent_browser_uncheck", "agent_browser_select", "agent_browser_scroll",
    "agent_browser_wait_ms", "agent_browser_wait_for_selector",
    "agent_browser_wait_for_text", "agent_browser_wait_for_load",
    "agent_browser_back", "agent_browser_forward", "agent_browser_reload",
    "agent_browser_tab_new", "agent_browser_tab_switch",
  ]),
};

export function allowedComputerUseTools(provider: ComputerUseProvider, mode: "observe" | "act"): string[] {
  return [...(mode === "observe" ? OBSERVATIONS[provider] : ACTIONS[provider])];
}

export function validateComputerUseTool(
  provider: ComputerUseProvider,
  mode: "observe" | "act",
  tool: string,
  args: Record<string, unknown>,
): void {
  const allowed = mode === "observe" ? OBSERVATIONS[provider] : ACTIONS[provider];
  if (!allowed.has(tool)) {
    throw new Error("Computer-use " + mode + " tool is not allowlisted: " + tool);
  }
  const bytes = Buffer.byteLength(JSON.stringify(args), "utf8");
  if (bytes > 32_000) throw new Error("Computer-use arguments exceed 32 KB");
  if (tool === "agent_browser_connect") {
    if (Object.keys(args).some((key) => key !== "target")) {
      throw new Error("CDP connection accepts only target (no extra flags, session or namespace overrides)");
    }
    const target = args.target;
    if (typeof target !== "string" || !target.trim()) {
      throw new Error("CDP connection target is required");
    }
    if (/^\d{1,5}$/.test(target)) {
      const port = Number(target);
      if (port > 0 && port <= 65535) return;
    }
    try {
      const url = new URL(target);
      const host = url.hostname.toLowerCase();
      if ((url.protocol === "http:" || url.protocol === "ws:") &&
        ["localhost", "127.0.0.1", "[::1]"].includes(host) &&
        Number(url.port) > 0 && Number(url.port) <= 65535 &&
        !url.username && !url.password && !url.hash) return;
    } catch {}
    throw new Error("CDP targets must be localhost TCP ports or explicit loopback HTTP/WebSocket endpoints");
  }
  if (tool === "agent_browser_open" || tool === "agent_browser_tab_new") {
    const url = args.url;
    if (url !== undefined &&
      (typeof url !== "string" || !/^https?:\/\//i.test(url))) {
      throw new Error("Browser navigation accepts only http:// or https:// URLs");
    }
  }
}