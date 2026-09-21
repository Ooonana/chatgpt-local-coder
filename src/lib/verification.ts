import fs from "fs/promises";
import path from "path";
import { detectPackageManager } from "./package-manager.js";

export interface VerificationCommand {
  label: string;
  command: string;
  timeout_seconds: number;
}

interface VerificationConfig {
  version?: number;
  quick?: Array<string | Partial<VerificationCommand>>;
  full?: Array<string | Partial<VerificationCommand>>;
}

const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_COMMANDS = 12;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandFromValue(value: string | Partial<VerificationCommand>, index: number): VerificationCommand | null {
  if (typeof value === "string") {
    const command = value.trim();
    return command ? { label: `check ${index + 1}`, command, timeout_seconds: DEFAULT_TIMEOUT_SECONDS } : null;
  }
  const command = value.command?.trim();
  if (!command) return null;
  const timeout = Number(value.timeout_seconds || DEFAULT_TIMEOUT_SECONDS);
  return {
    label: value.label?.trim() || `check ${index + 1}`,
    command,
    timeout_seconds: Number.isFinite(timeout) ? Math.min(Math.max(Math.trunc(timeout), 5), 3600) : DEFAULT_TIMEOUT_SECONDS,
  };
}

async function fromConfig(root: string, preset: "quick" | "full"): Promise<VerificationCommand[] | null> {
  const configPath = path.join(root, ".local-coder", "verification.json");
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as VerificationConfig;
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw new Error(`Unsupported verification config version: ${parsed.version}`);
    }
    const source = parsed[preset];
    if (!Array.isArray(source)) return null;
    return source
      .slice(0, MAX_COMMANDS)
      .map(commandFromValue)
      .filter((item): item is VerificationCommand => Boolean(item));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function packageJsonRecipe(root: string, preset: "quick" | "full"): Promise<VerificationCommand[]> {
  const packagePath = path.join(root, "package.json");
  if (!(await exists(packagePath))) return [];
  let pkg: { scripts?: Record<string, string>; packageManager?: string };
  try {
    pkg = JSON.parse(await fs.readFile(packagePath, "utf-8"));
  } catch {
    return [];
  }
  const scripts = pkg.scripts || {};
  const manager = await detectPackageManager(root, pkg.packageManager);
  const runScript = (name: string) => `${manager} run ${name}`;
  const names = preset === "quick"
    ? ["lint", "typecheck", "check", "build"]
    : ["lint", "typecheck", "check", "build", "test", "test:integration"];
  const commands: VerificationCommand[] = [];
  for (const name of names) {
    if (!scripts[name]) continue;
    commands.push({
      label: name,
      command: runScript(name),
      timeout_seconds: name.startsWith("test") ? 600 : DEFAULT_TIMEOUT_SECONDS,
    });
  }
  return commands;
}

async function languageRecipe(root: string, preset: "quick" | "full"): Promise<VerificationCommand[]> {
  if (await exists(path.join(root, "Cargo.toml"))) {
    return preset === "quick"
      ? [{ label: "cargo check", command: "cargo check", timeout_seconds: 300 }]
      : [
          { label: "cargo check", command: "cargo check", timeout_seconds: 300 },
          { label: "cargo test", command: "cargo test", timeout_seconds: 600 },
        ];
  }
  if (await exists(path.join(root, "go.mod"))) {
    return [{ label: "go test", command: "go test ./...", timeout_seconds: 600 }];
  }
  return [];
}

export async function discoverVerificationRecipe(
  root: string,
  preset: "quick" | "full"
): Promise<{ source: "config" | "auto"; commands: VerificationCommand[] }> {
  const configured = await fromConfig(root, preset);
  if (configured) return { source: "config", commands: configured };

  const commands = await packageJsonRecipe(root, preset);
  if (!commands.length) commands.push(...await languageRecipe(root, preset));
  if (await exists(path.join(root, ".git"))) {
    commands.push({ label: "git diff --check", command: "git diff --check", timeout_seconds: 60 });
  }
  return { source: "auto", commands: commands.slice(0, MAX_COMMANDS) };
}

export function compactVerificationOutput(stdout: string, stderr: string, maxChars = 8_000) {
  const combined = `${stdout}\n${stderr}`.trim();
  const important = combined
    .split(/\r?\n/)
    .filter((line) => /\b(error|fail(?:ed|ure)?|fatal|exception|traceback|assert(?:ion)?|warning)\b/i.test(line))
    .slice(0, 40)
    .join("\n");
  const tail = combined.length > maxChars ? combined.slice(-maxChars) : combined;
  return {
    excerpt: important.slice(0, maxChars) || tail,
    output_chars: combined.length,
    truncated: combined.length > maxChars,
  };
}
