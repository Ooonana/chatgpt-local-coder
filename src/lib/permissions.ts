import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteTextSync } from "./atomic-file.js";

export type PermissionProfile = "open" | "workspace" | "read_only" | "custom";

export interface PermissionConfig {
  version: 1;
  profile: PermissionProfile;
  path_roots?: string[];
  allow_write?: boolean;
  allow_commands?: boolean;
  allow_unsafe_runtimes?: boolean;
  command_allow_patterns?: string[];
  command_deny_patterns?: string[];
}

const DEFAULT_CONFIG: PermissionConfig = { version: 1, profile: "open" };
const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../profiles/permissions.json"
);
let runtimeWorkspaceRoots: string[] = [process.cwd()];

function configPath(): string {
  return path.resolve(process.env.PERMISSIONS_CONFIG || DEFAULT_CONFIG_PATH);
}

function normalizedRoot(value: string): string {
  return path.resolve(value);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeConfig(raw: Partial<PermissionConfig> | undefined): PermissionConfig {
  if (raw?.version !== undefined && raw.version !== 1) {
    throw new Error(`Unsupported permission config version: ${String(raw.version)}`);
  }
  const validProfiles: PermissionProfile[] = ["open", "workspace", "read_only", "custom"];
  if (raw?.profile !== undefined && !validProfiles.includes(raw.profile as PermissionProfile)) {
    throw new Error(`Invalid permission profile: ${String(raw.profile)}`);
  }
  const profile: PermissionProfile = (raw?.profile as PermissionProfile | undefined) ?? "open";
  const pathRoots = optionalStringArray(raw?.path_roots, "path_roots");
  const allowPatterns = optionalStringArray(raw?.command_allow_patterns, "command_allow_patterns");
  const denyPatterns = optionalStringArray(raw?.command_deny_patterns, "command_deny_patterns");
  for (const [field, patterns] of [["command_allow_patterns", allowPatterns], ["command_deny_patterns", denyPatterns]] as const) {
    for (const pattern of patterns ?? []) {
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        throw new Error(`${field} contains invalid regex '${pattern}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return {
    version: 1,
    profile,
    path_roots: pathRoots ? [...new Set(pathRoots.map(normalizedRoot))] : undefined,
    allow_write: optionalBoolean(raw?.allow_write, "allow_write"),
    allow_commands: optionalBoolean(raw?.allow_commands, "allow_commands"),
    allow_unsafe_runtimes: optionalBoolean(raw?.allow_unsafe_runtimes, "allow_unsafe_runtimes"),
    command_allow_patterns: allowPatterns,
    command_deny_patterns: denyPatterns,
  };
}

export function setPermissionWorkspaceRoots(roots: string[]): void {
  const next = [...new Set(roots.filter(Boolean).map(normalizedRoot))];
  runtimeWorkspaceRoots = next.length ? next : [process.cwd()];
}

export function getPermissionConfig(): PermissionConfig {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Partial<PermissionConfig>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new Error(
      `Failed to load permission config ${configPath()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function savePermissionConfig(next: Partial<PermissionConfig>): PermissionConfig {
  const normalized = normalizeConfig(next);
  atomicWriteTextSync(configPath(), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

export function getPermissionConfigPath(): string {
  return configPath();
}

export function getPermissionProfile(): PermissionProfile {
  return getPermissionConfig().profile;
}

export function getEffectivePathRoots(): string[] {
  const config = getPermissionConfig();
  if (config.profile === "open") return [];
  const configured = config.path_roots?.length ? config.path_roots : runtimeWorkspaceRoots;
  return [...new Set(configured.map(normalizedRoot))];
}

function pathWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (!relative) return true;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function isPathAllowed(targetPath: string): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open") return true;
  const target = path.resolve(targetPath);
  return getEffectivePathRoots().some((root) => pathWithinRoot(target, root));
}

export function assertPathAllowed(targetPath: string): void {
  if (isPathAllowed(targetPath)) return;
  const roots = getEffectivePathRoots();
  throw new Error(
    `Permission denied by '${getPermissionProfile()}' profile: path is outside configured roots (${roots.join(", ") || "none"}): ${path.resolve(targetPath)}`
  );
}

export function isReadOnly(): boolean {
  return getPermissionProfile() === "read_only";
}

export function canWriteFiles(): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open" || config.profile === "workspace") return true;
  if (config.profile === "read_only") return false;
  return config.allow_write === true;
}

export function canRunCommands(): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open" || config.profile === "workspace") return true;
  if (config.profile === "read_only") return false;
  return config.allow_commands === true;
}

export function canUseUnsafeRuntimes(): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open") return true;
  if (config.profile === "custom") return config.allow_unsafe_runtimes === true;
  return false;
}

export function canUseAnyAbsolutePath(): boolean {
  return getPermissionProfile() === "open";
}

function matchesPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "i").test(command);
  } catch {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function shouldBlockCommand(command: string): boolean {
  const config = getPermissionConfig();
  if (!canRunCommands()) return true;
  if (config.command_deny_patterns?.some((pattern) => matchesPattern(command, pattern))) return true;
  if (config.command_allow_patterns?.length) {
    return !config.command_allow_patterns.some((pattern) => matchesPattern(command, pattern));
  }
  return false;
}

export function describePermissionProfile(): string {
  const config = getPermissionConfig();
  if (config.profile === "open") {
    return "open: full machine access through Local Coder tools; paths, commands, and unsafe runtimes are unrestricted (OS ACLs still apply)";
  }
  if (config.profile === "workspace") {
    return `workspace: Local Coder path parameters/cwds are limited to ${getEffectivePathRoots().join(", ")}; writes and commands are allowed, unsafe runtimes are blocked. Command execution is application-level policy, not an OS sandbox.`;
  }
  if (config.profile === "read_only") {
    return `read_only: reads are limited to ${getEffectivePathRoots().join(", ")}; Local Coder writes, commands, and unsafe runtimes are blocked.`;
  }
  return `custom: roots=${getEffectivePathRoots().join(", ") || "none"}; writes=${canWriteFiles()}; commands=${canRunCommands()}; unsafe_runtimes=${canUseUnsafeRuntimes()}. This is application-level policy, not an OS sandbox.`;
}

export function requireWriteAllowed(targetPath?: string): void {
  if (!canWriteFiles()) {
    throw new Error(`Permission denied by '${getPermissionProfile()}' profile: file mutations are disabled`);
  }
  if (targetPath) assertPathAllowed(targetPath);
}

export function requireCommandAllowed(command: string, cwd?: string): void {
  if (cwd) assertPathAllowed(cwd);
  if (shouldBlockCommand(command)) {
    throw new Error(`Permission denied by '${getPermissionProfile()}' profile: command is not allowed: ${command}`);
  }
}

export function requireUnsafeRuntimeAllowed(kind: string): void {
  if (!canUseUnsafeRuntimes()) {
    throw new Error(
      `Permission denied by '${getPermissionProfile()}' profile: ${kind} is an unrestricted runtime and must be explicitly enabled with a custom profile`
    );
  }
}
