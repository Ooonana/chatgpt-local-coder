import { spawn } from "child_process";
import { resolveSafeSpawnSpec } from "./safe-spawn.js";
import { terminateChildProcessTree } from "./process-tree.js";

export type DelegateId = "claude" | "codex" | "grok" | "opencode";
export type DelegatePromptChannel = "stdin" | "file" | "argv";

export interface DelegateSpec {
  id: DelegateId;
  binary: string;
  prompt_channel: DelegatePromptChannel;
  noninteractive_args: string[];
  version_args: string[];
}

export interface DelegateStatus {
  id: DelegateId;
  binary: string;
  path: string | null;
  available: boolean;
  version: string | null;
  prompt_channel: DelegatePromptChannel;
  noninteractive_args: string[];
}

export const DELEGATE_SPECS: DelegateSpec[] = [
  {
    id: "claude",
    binary: "claude",
    prompt_channel: "stdin",
    noninteractive_args: ["-p", "--output-format", "text"],
    version_args: ["--version"],
  },
  {
    id: "codex",
    binary: "codex",
    prompt_channel: "stdin",
    noninteractive_args: ["exec", "-"],
    version_args: ["--version"],
  },
  {
    id: "grok",
    binary: "grok",
    prompt_channel: "file",
    noninteractive_args: ["--prompt-file"],
    version_args: ["--version"],
  },
  {
    id: "opencode",
    binary: "opencode",
    prompt_channel: "argv",
    noninteractive_args: ["run"],
    version_args: ["--version"],
  },
];

const cache = new Map<DelegateId, DelegateStatus>();

async function runCapture(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    };
    const timer = setTimeout(() => {
      void terminateChildProcessTree(child, true).catch(() => {
        try { child.kill("SIGKILL"); } catch {}
      });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < 16_384) stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < 16_384) stderr += data.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

async function findOnPath(binary: string): Promise<string | null> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = await runCapture(command, [binary], 5000);
  if (result.code !== 0) return null;
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates[0] ?? null;

  // npm installs a POSIX shell shim without an extension *before* the .cmd shim.
  // Node's Windows spawn path cannot execute that extensionless shell script, so
  // prefer an actual Windows executable/shim when one is available.
  const priority = [".exe", ".com", ".cmd", ".bat"];
  for (const extension of priority) {
    const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(extension));
    if (match) return match;
  }
  return candidates[0] ?? null;
}

async function readVersion(executablePath: string, args: string[]): Promise<string | null> {
  const spec = await resolveSafeSpawnSpec(executablePath, args);
  const result = await runCapture(spec.file, spec.args, 10_000);
  const line = (result.stdout || result.stderr).split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ?? null;
}

export async function probeDelegates(refresh = false): Promise<DelegateStatus[]> {
  const results: DelegateStatus[] = [];
  for (const spec of DELEGATE_SPECS) {
    const cached = cache.get(spec.id);
    if (cached && !refresh) {
      results.push(cached);
      continue;
    }
    const executablePath = await findOnPath(spec.binary);
    const status: DelegateStatus = {
      id: spec.id,
      binary: spec.binary,
      path: executablePath,
      available: Boolean(executablePath),
      version: executablePath ? await readVersion(executablePath, spec.version_args) : null,
      prompt_channel: spec.prompt_channel,
      noninteractive_args: [...spec.noninteractive_args],
    };
    cache.set(spec.id, status);
    results.push(status);
  }
  return results;
}

export function clearDelegateProbeCache(): void {
  cache.clear();
}
