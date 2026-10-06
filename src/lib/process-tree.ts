import { spawn } from "node:child_process";
import { getWinShell } from "./persistent-shell.js";

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
    probe.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    probe.on("error", () => resolve([]));
    probe.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const values = Array.isArray(parsed) ? parsed : [parsed];
        resolve(values.map(Number).filter((value) => Number.isInteger(value) && value > 0));
      } catch {
        resolve([]);
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
    killer.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    killer.on("error", reject);
    killer.on("close", (code) => {
      if (code === 0 || (tolerateMissing && !osProcessAlive(pid))) resolve();
      else reject(new Error(`taskkill failed for PID ${pid} with exit ${code}: ${stderr.trim()}`));
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