import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export type TunnelStatus = "disabled" | "not_configured" | "starting" | "online" | "degraded" | "stopped";

export interface TunnelSnapshot {
  managed: boolean;
  configured: boolean;
  status: TunnelStatus;
  tunnel_id: string | null;
  health_port: number;
  pid: number | null;
  started_at: string | null;
  last_ready_at: string | null;
  last_exit_at: string | null;
  last_exit_code: number | null;
  restarts: number;
  reused_external: boolean;
  last_error: string | null;
  log_tail: string;
}

const MAX_LOG_CHARS = 40_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

function boundedPort(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function appendBounded(current: string, value: string): string {
  const next = current + value;
  return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
}

async function ready(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const text = await response.text();
    return /ready|ok/i.test(text);
  } catch {
    return false;
  }
}

function tunnelExecutable(root: string): string | null {
  const configured = process.env.OPENAI_TUNNEL_CLIENT?.trim();
  if (configured && fsSync.existsSync(configured)) return path.resolve(configured);
  const local = path.join(root, "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
  if (fsSync.existsSync(local)) return local;
  return "tunnel-client";
}

async function writeProfile(root: string, port: number, healthPort: number, tunnelId: string): Promise<string> {
  const profileDir = path.join(root, "profiles");
  const profile = path.join(profileDir, "codex-local.yaml");
  const token = (process.env.MCP_TOKEN || "").trim();
  const mcpUrl = token
    ? `http://127.0.0.1:${port}/mcp/${token}`
    : `http://127.0.0.1:${port}/mcp`;
  const yaml = [
    "config_version: 1",
    "control_plane:",
    `  tunnel_id: ${tunnelId}`,
    "  api_key: env:OPENAI_TUNNEL_API_KEY",
    "log:",
    "  level: info",
    "  format: struct-text",
    "health:",
    `  listen_addr: 127.0.0.1:${healthPort}`,
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: ${mcpUrl}`,
    "",
  ].join("\n");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profile, yaml, "utf-8");
  return profile;
}

export function createTunnelSupervisor(options: {
  root: string;
  mcpPort: number;
}): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  snapshot: () => TunnelSnapshot;
} {
  const root = path.resolve(options.root);
  const healthPort = boundedPort(process.env.OPENAI_TUNNEL_HEALTH_PORT, 8080);
  const tunnelId = (process.env.OPENAI_TUNNEL_ID || "").trim();
  const apiKey = (process.env.OPENAI_TUNNEL_API_KEY || "").trim();
  const managed = truthy(process.env.LOCAL_CODER_MANAGE_TUNNEL);
  const configured = Boolean(tunnelId && apiKey);
  let child: ChildProcess | null = null;
  let stopping = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let restartAttempt = 0;
  let status: TunnelStatus = !managed ? "disabled" : configured ? "stopped" : "not_configured";
  let startedAt: string | null = null;
  let lastReadyAt: string | null = null;
  let lastExitAt: string | null = null;
  let lastExitCode: number | null = null;
  let restarts = 0;
  let reusedExternal = false;
  let lastError: string | null = null;
  let logTail = "";

  const snapshot = (): TunnelSnapshot => ({
    managed,
    configured,
    status,
    tunnel_id: tunnelId || null,
    health_port: healthPort,
    pid: child?.pid || null,
    started_at: startedAt,
    last_ready_at: lastReadyAt,
    last_exit_at: lastExitAt,
    last_exit_code: lastExitCode,
    restarts,
    reused_external: reusedExternal,
    last_error: lastError,
    log_tail: logTail,
  });

  const pollHealth = async () => {
    if (stopping || status === "disabled" || status === "not_configured") return;
    if (await ready(healthPort)) {
      status = "online";
      lastReadyAt = new Date().toISOString();
      restartAttempt = 0;
    } else if (child && child.exitCode === null) {
      status = "starting";
    } else if (!reusedExternal) {
      status = "degraded";
    }
  };

  const scheduleHealth = () => {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => void pollHealth(), 2_000);
    healthTimer.unref?.();
  };

  const scheduleRestart = (spawnAgain: () => Promise<void>) => {
    if (stopping || restartTimer || reusedExternal) return;
    const delay = BACKOFF_MS[Math.min(restartAttempt, BACKOFF_MS.length - 1)];
    restartAttempt++;
    restarts++;
    status = "degraded";
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void spawnAgain();
    }, delay);
    restartTimer.unref?.();
  };

  const spawnManaged = async (): Promise<void> => {
    if (stopping || !managed || !configured || child) return;
    const executable = tunnelExecutable(root);
    if (!executable) {
      status = "degraded";
      lastError = "tunnel-client executable not found";
      return;
    }
    try {
      const profile = await writeProfile(root, options.mcpPort, healthPort, tunnelId);
      status = "starting";
      startedAt = new Date().toISOString();
      lastError = null;
      const spawned = spawn(executable, ["run", "--profile-file", profile], {
        cwd: root,
        windowsHide: true,
        detached: false,
        env: {
          ...process.env,
          OPENAI_TUNNEL_API_KEY: apiKey,
          CONTROL_PLANE_API_KEY: apiKey,
          CONTROL_PLANE_TUNNEL_ID: tunnelId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      spawned.stdout!.on("data", (data: Buffer) => {
        logTail = appendBounded(logTail, data.toString());
      });
      spawned.stderr!.on("data", (data: Buffer) => {
        logTail = appendBounded(logTail, data.toString());
      });
      spawned.once("error", (error) => {
        lastError = error.message;
        status = "degraded";
      });
      spawned.once("close", (code) => {
        if (child === spawned) child = null;
        lastExitAt = new Date().toISOString();
        lastExitCode = code;
        if (stopping) {
          status = "stopped";
          return;
        }
        lastError = code === 0 ? "tunnel-client exited unexpectedly" : `tunnel-client exited with code ${code}`;
        scheduleRestart(spawnManaged);
      });
      scheduleHealth();
      void pollHealth();
    } catch (error) {
      child = null;
      lastError = error instanceof Error ? error.message : String(error);
      status = "degraded";
      scheduleRestart(spawnManaged);
    }
  };

  const start = async (): Promise<void> => {
    if (!managed) {
      status = "disabled";
      return;
    }
    if (!configured) {
      status = "not_configured";
      return;
    }
    stopping = false;
    if (await ready(healthPort)) {
      reusedExternal = true;
      status = "online";
      startedAt = new Date().toISOString();
      lastReadyAt = startedAt;
      scheduleHealth();
      return;
    }
    reusedExternal = false;
    await spawnManaged();
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (healthTimer) clearInterval(healthTimer);
    restartTimer = null;
    healthTimer = null;
    const current = child;
    child = null;
    if (current && current.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { current.kill("SIGKILL"); } catch {}
          resolve();
        }, 2_000);
        timer.unref?.();
        current.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          current.kill("SIGTERM");
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    status = managed ? "stopped" : "disabled";
  };

  return { start, stop, snapshot };
}