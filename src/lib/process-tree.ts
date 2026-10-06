import { spawn, type ChildProcess } from "node:child_process";
import { getWinShell } from "./win-shell.js";

const WINDOWS_DESCENDANT_PROBE_TIMEOUT_MS = 2_500;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export function osProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function windowsDescendantPids(rootPid: number): Promise<number[]> {
  const shellInfo = getWinShell();
  const script = [
    `$rootPid = ${rootPid}`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
    "$pending = @($rootPid)",
    "$found = @()",
    "while ($pending.Count -gt 0) {",
    "  $parent = $pending[0]",
    "  if ($pending.Count -eq 1) { $pending = @() } else { $pending = @($pending[1..($pending.Count-1)]) }",
    "  $children = @($all | Where-Object { $_.ParentProcessId -eq $parent } | ForEach-Object { [int]$_.ProcessId })",
    "  foreach ($childPid in $children) {",
    "    if ($found -notcontains $childPid) { $found += $childPid; $pending += $childPid }",
    "  }",
    "}",
    "$found | ConvertTo-Json -Compress",
  ].join("; ");
  return await new Promise<number[]>((resolve) => {
    const probe = spawn(shellInfo.shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { probe.kill("SIGKILL"); } catch {}
      finish([]);
    }, WINDOWS_DESCENDANT_PROBE_TIMEOUT_MS);
    timer.unref?.();
    probe.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    probe.on("error", () => finish([]));
    probe.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        finish([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const values = Array.isArray(parsed) ? parsed : [parsed];
        finish(values.map(Number).filter((value) => Number.isInteger(value) && value > 0));
      } catch {
        finish([]);
      }
    });
  });
}

async function taskkillPid(pid: number, force: boolean, tree: boolean, tolerateMissing = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = ["/PID", String(pid)];
    if (tree) args.push("/T");
    if (force) args.push("/F");
    const killer = spawn("taskkill.exe", args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch {}
      if (!osProcessAlive(pid)) finish();
      else finish(new Error(`taskkill timed out for PID ${pid}`));
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    timer.unref?.();
    killer.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    killer.on("error", (error) => finish(error));
    killer.on("close", (code) => {
      if (code === 0 || (tolerateMissing && !osProcessAlive(pid))) finish();
      else finish(new Error(`taskkill failed for PID ${pid} with exit ${code}: ${stderr.trim()}`));
    });
  });
}

export async function waitForPidsExit(pids: number[], timeoutMs = 3_000): Promise<number[]> {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const deadline = Date.now() + timeoutMs;
  let alive = unique.filter(osProcessAlive);
  while (alive.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = unique.filter(osProcessAlive);
  }
  return alive;
}

/**
 * Robust Windows process-tree termination. Descendants are snapshotted before
 * the root dies so children that reparent during taskkill are still cleaned up.
 */
export async function terminateWindowsProcessTree(rootPid: number, force = true): Promise<void> {
  const descendants = force ? await windowsDescendantPids(rootPid) : [];
  await taskkillPid(rootPid, force, true, !osProcessAlive(rootPid));
  if (!force) return;
  for (const pid of descendants.reverse()) {
    if (!osProcessAlive(pid)) continue;
    await taskkillPid(pid, true, true, true).catch(() => undefined);
  }
  const survivors = await waitForPidsExit([rootPid, ...descendants], 3_000);
  if (survivors.length) {
    throw new Error(`Forced termination left process(es) alive: ${survivors.join(", ")}`);
  }
}

export async function terminateChildProcessTree(child: ChildProcess, force = true): Promise<void> {
  if (!child.pid) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child.pid, force);
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}