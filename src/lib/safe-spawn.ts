import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

export interface SafeSpawnSpec {
  file: string;
  args: string[];
  resolved_executable: string;
  shim?: string;
}

async function capture(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env: env ?? process.env });
    let stdout = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: stdout.trim() });
    };
    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < 64_000) stdout += data.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function hasPathComponent(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function selectWindowsCandidate(candidates: string[]): string | null {
  const priority = [".exe", ".com", ".cmd", ".bat"];
  for (const extension of priority) {
    const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(extension));
    if (match) return match;
  }
  return candidates[0] ?? null;
}

async function resolveWindowsExecutable(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (hasPathComponent(command)) return path.resolve(command);
  const found = await capture("where.exe", [command], env);
  if (found.code !== 0 || !found.stdout) return command;
  const candidates = found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return selectWindowsCandidate(candidates) ?? command;
}

function expandDp0(value: string, shimPath: string): string {
  return path.resolve(value.replace(/%dp0%/gi, path.dirname(shimPath)));
}

async function resolveNpmCmdShim(shimPath: string, args: string[]): Promise<SafeSpawnSpec> {
  const text = await fs.readFile(shimPath, "utf-8");

  // Standard npm Node shim:
  //   "%_prog%" "%dp0%\node_modules\pkg\bin\cli.js" %*
  const nodeMatch = text.match(/"%_prog%"\s+"([^"]+\.(?:c?m?js))"\s+%\*/i);
  if (nodeMatch) {
    const script = expandDp0(nodeMatch[1], shimPath);
    await fs.access(script);
    const localNode = path.join(path.dirname(shimPath), "node.exe");
    let node = process.execPath;
    try {
      await fs.access(localNode);
      node = localNode;
    } catch {}
    return { file: node, args: [script, ...args], resolved_executable: script, shim: shimPath };
  }

  // Native npm shim (for example OpenCode):
  //   "%dp0%\node_modules\pkg\bin\tool.exe" %*
  const nativeMatch = text.match(/"([^"]*%dp0%[^"]*\.(?:exe|com))"\s+%\*/i);
  if (nativeMatch) {
    const executable = expandDp0(nativeMatch[1], shimPath);
    await fs.access(executable);
    return { file: executable, args: [...args], resolved_executable: executable, shim: shimPath };
  }

  throw new Error(
    `Refusing to execute Windows batch shim through a command shell because arguments may contain untrusted prompt text: ${shimPath}. Configure the underlying .exe/.js executable instead.`
  );
}

export async function resolveSafeSpawnSpec(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<SafeSpawnSpec> {
  if (process.platform !== "win32") {
    return { file: command, args: [...args], resolved_executable: command };
  }

  const resolved = await resolveWindowsExecutable(command, env);
  const extension = path.extname(resolved).toLowerCase();
  if (extension === ".cmd") return resolveNpmCmdShim(resolved, args);
  if (extension === ".bat") {
    throw new Error(
      `Refusing to execute .bat subagent/delegate runner through a command shell: ${resolved}. Configure a native executable or Node script instead.`
    );
  }
  return { file: resolved, args: [...args], resolved_executable: resolved };
}
