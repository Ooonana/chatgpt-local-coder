import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  bindCurrentSessionProject,
  getCurrentSessionId,
  getCurrentSessionState,
} from "./session-context.js";
import { sameResolvedPath } from "./path-identity.js";
import { atomicWriteText } from "./atomic-file.js";

interface ProjectRegistryEntry {
  root: string;
  alias: string;
  last_used_at: string;
  uses: number;
  identity?: string;
  previous_roots?: string[];
}

interface ProjectRegistry {
  version: 1;
  active_root: string | null;
  entries: ProjectRegistryEntry[];
}

const ROOT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "CLAUDE.md"];
const MAX_RECENTS = 24;
const MAX_DETECTION_CACHE = 2048;
const activeRoots = new Map<string, string>();
const detectionCache = new Map<string, string>();
let registryWriteQueue = Promise.resolve();
const execFileAsync = promisify(execFile);

function registryPath(): string {
  return path.resolve(process.env.MCP_PROJECT_REGISTRY_PATH?.trim() || path.join(process.cwd(), ".mcp-state", "projects.json"));
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function aliasFor(root: string): string {
  return path.basename(root.replace(/[\\/]+$/, "")) || "project";
}

function normalizeRemote(raw: string): string {
  let value = raw.trim().replace(/\\/g, "/").replace(/\.git$/i, "");
  const scp = value.match(/^git@([^:]+):(.+)$/i);
  if (scp) value = "ssh://" + scp[1] + "/" + scp[2];
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
    // GitHub repository paths are case-insensitive. Preserve pathname case for
    // generic/self-hosted Git servers where repository paths may be case-sensitive.
    const normalizedPathname = host === "github.com" ? pathname.toLowerCase() : pathname;
    return host + "/" + normalizedPathname;
  } catch {
    return value;
  }
}

async function projectIdentity(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "config", "--get", "remote.origin.url"],
      { windowsHide: true, timeout: 3_000, maxBuffer: 32 * 1024 }
    );
    const remote = normalizeRemote(stdout);
    return remote ? "git:" + remote : undefined;
  } catch {
    return undefined;
  }
}

async function pathMissingOnAvailableFilesystem(candidate: string): Promise<boolean> {
  if (await exists(candidate)) return false;
  const filesystemRoot = path.parse(path.resolve(candidate)).root;
  // A temporarily detached/unavailable drive must not make a project look
  // "moved"; wait until that filesystem is reachable again.
  return Boolean(filesystemRoot && await exists(filesystemRoot));
}

function cacheDetection(key: string, root: string): void {
  detectionCache.delete(key);
  detectionCache.set(key, root);
  while (detectionCache.size > MAX_DETECTION_CACHE) {
    const oldest = detectionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    detectionCache.delete(oldest);
  }
}

async function readRegistry(): Promise<ProjectRegistry> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(), "utf-8")) as ProjectRegistry;
    if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { version: 1, active_root: null, entries: [] };
}

async function writeRegistry(registry: ProjectRegistry): Promise<void> {
  const target = registryPath();
  await atomicWriteText(target, JSON.stringify(registry, null, 2) + "\n");
}

async function mutateRegistry<T>(work: () => Promise<T>): Promise<T> {
  const previous = registryWriteQueue;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registryWriteQueue = previous.catch(() => undefined).then(() => gate);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

export async function detectProjectRoot(inputPath: string): Promise<string> {
  const absolute = path.resolve(inputPath);
  const cached = detectionCache.get(absolute);
  if (cached) {
    cacheDetection(absolute, cached);
    return cached;
  }
  let current = absolute;
  try {
    if (!(await fs.stat(current)).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  const start = current;
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (await exists(path.join(current, marker))) {
        cacheDetection(absolute, current);
        cacheDetection(start, current);
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  cacheDetection(absolute, start);
  return start;
}

export async function isProjectRoot(candidate: string): Promise<boolean> {
  for (const marker of ROOT_MARKERS) {
    if (await exists(path.join(candidate, marker))) return true;
  }
  return false;
}

export async function recordProjectAffinity(inputPath: string): Promise<string> {
  const root = await detectProjectRoot(inputPath);
  const identity = await projectIdentity(root);
  const sessionId = getCurrentSessionId();
  if (sessionId) activeRoots.set(sessionId, root);
  bindCurrentSessionProject(root, aliasFor(root));
  await mutateRegistry(async () => {
    const registry = await readRegistry();
    const now = new Date().toISOString();
    const exactPath = registry.entries.find((entry) => sameResolvedPath(entry.root, root));
    const identityMatches = identity
      ? registry.entries.filter((entry) => entry.identity === identity)
      : [];
    const staleIdentityMatches: ProjectRegistryEntry[] = [];
    if (identity) {
      for (const entry of identityMatches) {
        if (sameResolvedPath(entry.root, root)) continue;
        if (await pathMissingOnAvailableFilesystem(entry.root)) staleIdentityMatches.push(entry);
      }
    }
    // Exact path always wins. Remote identity only reconciles a genuinely stale
    // path; two live clones of the same remote remain distinct projects.
    const existing = exactPath || staleIdentityMatches[0];
    if (existing) {
      if (!sameResolvedPath(existing.root, root)) {
        existing.previous_roots = [...new Set([...(existing.previous_roots || []), existing.root])]
          .filter((candidate) => !sameResolvedPath(candidate, root))
          .slice(-8);
        existing.root = root;
        existing.alias = aliasFor(root);
      }
      if (identity) existing.identity = identity;
      existing.last_used_at = now;
      existing.uses = Math.max(0, existing.uses || 0) + 1;
      const staleDuplicates = staleIdentityMatches.filter((entry) => entry !== existing);
      if (staleDuplicates.length) {
        const duplicateSet = new Set(staleDuplicates);
        for (const duplicate of staleDuplicates) {
          existing.uses += Math.max(0, duplicate.uses || 0);
          existing.previous_roots = [...new Set([
            ...(existing.previous_roots || []),
            duplicate.root,
            ...(duplicate.previous_roots || []),
          ])].filter((candidate) => !sameResolvedPath(candidate, root)).slice(-8);
        }
        registry.entries = registry.entries.filter((entry) => !duplicateSet.has(entry));
      }
    } else {
      registry.entries.push({ root, alias: aliasFor(root), last_used_at: now, uses: 1, ...(identity ? { identity } : {}) });
    }
    // Do not persist a process-global "active project". ChatGPT can create a
    // fresh MCP transport per tool call, and multiple chats may work on
    // different projects concurrently. The registry is recent-project history
    // only; execution scope is derived per tool call.
    registry.active_root = null;
    registry.entries.sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));
    registry.entries = registry.entries.slice(0, MAX_RECENTS);
    await writeRegistry(registry);
  }).catch(() => undefined);
  return root;
}

export async function resolveProjectReference(reference: string | undefined, fallback: string): Promise<string> {
  if (!reference?.trim()) return recordProjectAffinity(fallback);
  const raw = reference.trim();
  const registry = await readRegistry();
  const exactAlias = registry.entries.filter((entry) => entry.alias.toLowerCase() === raw.toLowerCase());
  if (exactAlias.length === 1) return recordProjectAffinity(exactAlias[0].root);
  if (exactAlias.length > 1) {
    const candidates = exactAlias.slice(0, 8).map((entry) => entry.root).join(", ");
    throw new Error(`Project alias '${raw}' is ambiguous (${exactAlias.length} matches): ${candidates}. Use an explicit path.`);
  }
  return recordProjectAffinity(path.isAbsolute(raw) ? raw : path.resolve(fallback, raw));
}

export async function getProjectAffinity(fallback?: string): Promise<{
  active_root: string | null;
  active_alias: string | null;
  recents: ProjectRegistryEntry[];
}> {
  const sessionId = getCurrentSessionId();
  const sessionRoot = sessionId ? activeRoots.get(sessionId) : undefined;
  if (!sessionRoot && fallback && getCurrentSessionState()?.workspace_kind === "project") {
    await recordProjectAffinity(fallback).catch(() => undefined);
  }
  const registry = await readRegistry();
  const root = (sessionId ? activeRoots.get(sessionId) : undefined) || null;
  const entry = root ? registry.entries.find((item) => sameResolvedPath(item.root, root)) : undefined;
  return { active_root: root, active_alias: entry?.alias || (root ? aliasFor(root) : null), recents: registry.entries.slice(0, 12) };
}

export function clearProjectDetectionCache(): void {
  detectionCache.clear();
}

export function clearProjectAffinitySession(sessionId: string): void {
  activeRoots.delete(sessionId);
}
