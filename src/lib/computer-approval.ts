import { spawn } from "node:child_process";

export type ApprovalProvider = "desktop" | "browser";
export type ApprovalMode = "off" | "sensitive" | "all";

const SENSITIVE = new Set([
  "desktop_type", "desktop_set_value", "desktop_clear", "desktop_focus_window",
  "agent_browser_connect", "agent_browser_open", "agent_browser_tab_new",
  "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_select", "agent_browser_check", "agent_browser_uncheck",
]);
const WAITS = new Set([
  "desktop_wait", "agent_browser_wait_ms", "agent_browser_wait_for_selector",
  "agent_browser_wait_for_text", "agent_browser_wait_for_load",
]);
const leaseMs = 90_000;
const leases = new Map<string, number>();
const pending = new Map<string, Promise<boolean>>();

export function approvalMode(): ApprovalMode {
  const mode = (process.env.MCP_COMPUTER_APPROVAL_MODE ?? "sensitive").trim().toLowerCase();
  if (mode !== "off" && mode !== "sensitive" && mode !== "all") {
    throw new Error("MCP_COMPUTER_APPROVAL_MODE must be off, sensitive, or all");
  }
  return mode;
}

export function needsComputerApproval(tool: string, mode = approvalMode()): boolean {
  return mode !== "off" && !WAITS.has(tool) && (mode === "all" || SENSITIVE.has(tool));
}

/**
 * Operator confirmation is independent of caller-supplied allow_input.
 * It is defense in depth, not a security boundary against an unrestricted
 * local shell or an agent capable of controlling the approval window.
 */
async function windowsOperatorPrompt(provider: string, tool: string, scope: string): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Local computer approval needs an interactive Windows desktop");
  const body = "Local Coder requests computer control.\n\nProvider: " + provider +
    "\nAction: " + tool + "\nScope: " + scope.slice(0, 160).replace(/[\r\n\t]/g, " ") +
    "\n\nAllow access to this scope for up to 90 seconds? No denies the request.";
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$msg=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    "$result=[System.Windows.Forms.MessageBox]::Show($msg,'Local Coder - operator approval',[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning,[System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
    "if($result -eq [System.Windows.Forms.DialogResult]::Yes){exit 0}else{exit 3}",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ], { windowsHide: false, stdio: "ignore" });
    let settled = false;
    const finish = (approved: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(approved);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false, new Error("Operator confirmation timed out"));
    }, 30_000);
    child.on("error", (error) => finish(false, error));
    child.on("exit", (code) => finish(code === 0));
  });
}

export async function requireComputerApproval(
  provider: ApprovalProvider, tool: string, scope: string,
  confirm: (provider: string, tool: string, scope: string) => Promise<boolean> = windowsOperatorPrompt,
): Promise<void> {
  if (!needsComputerApproval(tool)) return;
  if (!scope || scope.length > 400) throw new Error("Computer approval requires a bounded scope");
  const key = provider + ":" + scope;
  const now = Date.now();
  for (const [name, expiry] of leases) if (expiry <= now) leases.delete(name);
  if ((leases.get(key) ?? 0) > now) return;
  let request = pending.get(key);
  if (!request) {
    request = confirm(provider, tool, scope);
    pending.set(key, request);
  }
  let allowed: boolean;
  try { allowed = await request; }
  finally { if (pending.get(key) === request) pending.delete(key); }
  if (!allowed) throw new Error("Computer input denied by the local operator");
  leases.set(key, Date.now() + leaseMs);
}