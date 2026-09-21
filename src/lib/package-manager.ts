import fs from "node:fs/promises";
import path from "node:path";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

const LOCK_FILES: Record<PackageManagerName, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

const INSTALL_MARKERS: Record<PackageManagerName, string[]> = {
  npm: ["node_modules/.package-lock.json"],
  pnpm: ["node_modules/.pnpm"],
  yarn: ["node_modules/.yarn-state.yml", ".pnp.cjs"],
  bun: ["node_modules/.bun-tag"],
};

const TIE_BREAK_ORDER: PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];
const availabilityCache = new Map<string, boolean>();

function explicitManager(value: string | undefined): PackageManagerName | undefined {
  const normalized = value?.trim().split("@")[0]?.toLowerCase();
  return TIE_BREAK_ORDER.find((manager) => manager === normalized);
}

async function commandAvailable(command: PackageManagerName): Promise<boolean> {
  const cacheKey = `${process.env.PATH || ""}\0${command}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  let available = false;
  outer: for (const entry of pathEntries) {
    for (const suffix of suffixes) {
      try {
        await fs.access(path.join(entry.replace(/^"|"$/g, ""), `${command}${suffix}`));
        available = true;
        break outer;
      } catch {}
    }
  }

  availabilityCache.set(cacheKey, available);
  while (availabilityCache.size > 16) {
    const oldest = availabilityCache.keys().next().value as string | undefined;
    if (!oldest) break;
    availabilityCache.delete(oldest);
  }
  return available;
}

async function detectInstalledManager(root: string, candidates: PackageManagerName[]): Promise<PackageManagerName | undefined> {
  const matches: PackageManagerName[] = [];
  for (const manager of candidates) {
    for (const marker of INSTALL_MARKERS[manager]) {
      try {
        await fs.access(path.join(root, marker));
        matches.push(manager);
        break;
      } catch {}
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export async function detectPackageManager(root: string, packageManagerField?: string): Promise<PackageManagerName> {
  const explicit = explicitManager(packageManagerField);
  if (explicit) return explicit;

  const candidates: Array<{ manager: PackageManagerName; mtime_ms: number }> = [];
  for (const manager of TIE_BREAK_ORDER) {
    let newest = -1;
    for (const lockFile of LOCK_FILES[manager]) {
      try {
        const stat = await fs.stat(path.join(root, lockFile));
        if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
      } catch {}
    }
    if (newest >= 0) candidates.push({ manager, mtime_ms: newest });
  }

  if (candidates.length === 0) return "npm";
  if (candidates.length === 1) return candidates[0].manager;

  const installed = await detectInstalledManager(root, candidates.map((candidate) => candidate.manager));
  if (installed) return installed;

  const available: typeof candidates = [];
  for (const candidate of candidates) {
    if (await commandAvailable(candidate.manager)) available.push(candidate);
  }
  const pool = available.length ? available : candidates;
  pool.sort((a, b) => {
    const byMtime = b.mtime_ms - a.mtime_ms;
    if (byMtime !== 0) return byMtime;
    return TIE_BREAK_ORDER.indexOf(a.manager) - TIE_BREAK_ORDER.indexOf(b.manager);
  });
  return pool[0].manager;
}
