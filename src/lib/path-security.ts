import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import {
  assertPathAllowed,
  canUseAnyAbsolutePath,
  getEffectivePathRoots,
} from "./permissions.js";

let defaultCwd = process.cwd();

export function setDefaultCwd(cwd: string): void {
  defaultCwd = path.resolve(cwd);
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** @deprecated use setDefaultCwd; retained for compatibility. */
export function setAllowedRoots(roots: string[]): void {
  if (roots.length > 0) setDefaultCwd(roots[0]);
}

/** Returns the effective Local Coder path roots for the active permission profile. */
export function getAllowedRoots(): string[] {
  const restricted = getEffectivePathRoots();
  return restricted.length ? restricted : [defaultCwd];
}

/** @deprecated permission profiles now control path access. */
export function setFullDiskAccess(_enabled: boolean): void {}

export function getFullDiskAccess(): boolean {
  return canUseAnyAbsolutePath();
}

function pathWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (!relative) return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve symlinks/junctions in the longest existing prefix while preserving
 * any not-yet-created suffix. This prevents an in-workspace junction from
 * turning a lexically safe path into a write outside the configured roots.
 */
export async function canonicalizePotentialPath(inputPath: string): Promise<string> {
  let cursor = path.resolve(inputPath);
  const missing: string[] = [];

  while (true) {
    try {
      const real = await fsp.realpath(cursor);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(inputPath);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertCanonicalPathAllowed(resolved: string): Promise<void> {
  const roots = getEffectivePathRoots();
  if (!roots.length) return;

  const [target, ...canonicalRoots] = await Promise.all([
    canonicalizePotentialPath(resolved),
    ...roots.map(canonicalizePotentialPath),
  ]);
  if (canonicalRoots.some((root) => pathWithinRoot(target, root))) return;

  throw new Error(
    `Permission denied: resolved path escapes configured roots through a symlink/junction: ${resolved} -> ${target}`
  );
}

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);
  assertPathAllowed(resolved);
  await assertCanonicalPathAllowed(resolved);
  return resolved;
}

export function getMachineRoots(): string[] {
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        fs.accessSync(`${letter}:\\`, fs.constants.R_OK);
        drives.push(`${letter}:\\`);
      } catch {}
    }
    return drives.length ? drives : ["C:\\"];
  }
  return ["/", os.homedir()];
}
