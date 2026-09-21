import fs from "node:fs/promises";
import path from "node:path";

interface ProjectRegistryEntry {
  root: string;
  alias: string;
  last_used_at: string;
  uses: number;
}

interface ProjectRegistry {
  version: 1;
  active_root: string | null;
  entries: ProjectRegistryEntry[];
}

const ROOT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "CLAUDE.md"];
const MAX_RECENTS = 24;
const MAX_DETECTION_CACHE = 2048;
let activeRoot: string | null = null;
const detectionCache = new Map<string, string>();
let registryWriteQueue = Promise.resolve();

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
  return { version: 1, active_root: activeRoot, entries: [] };
}

async function writeRegistry(registry: ProjectRegistry): Promise<void> {
  const target = registryPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  await fs.rename(temp, target);
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

export async function recordProjectAffinity(inputPath: string): Promise<string> {
  const root = await detectProjectRoot(inputPath);
  activeRoot = root;
  await mutateRegistry(async () => {
    const registry = await readRegistry();
    const now = new Date().toISOString();
    const existing = registry.entries.find((entry) => path.resolve(entry.root) === path.resolve(root));
    if (existing) {
      existing.last_used_at = now;
      existing.uses = Math.max(0, existing.uses || 0) + 1;
    } else {
      registry.entries.push({ root, alias: aliasFor(root), last_used_at: now, uses: 1 });
    }
    registry.active_root = root;
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
  if (!activeRoot && fallback) await recordProjectAffinity(fallback).catch(() => undefined);
  const registry = await readRegistry();
  const root = activeRoot || registry.active_root || null;
  const entry = root ? registry.entries.find((item) => path.resolve(item.root) === path.resolve(root)) : undefined;
  return { active_root: root, active_alias: entry?.alias || (root ? aliasFor(root) : null), recents: registry.entries.slice(0, 12) };
}

export function clearProjectDetectionCache(): void {
  detectionCache.clear();
}
