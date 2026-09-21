import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { VerificationCommand } from "./verification.js";
import { captureWorkingTree } from "./shell-mutation.js";

interface CachedVerification {
  version: 1;
  key: string;
  root: string;
  command: string;
  fingerprint: string;
  saved_at: string;
}

function cacheRoot(): string {
  return path.resolve(process.env.MCP_VERIFICATION_CACHE_STATE_DIR?.trim() || path.join(process.cwd(), ".mcp-state", "verification-cache"));
}

function cacheFile(key: string): string {
  return path.join(cacheRoot(), `${key}.json`);
}

function cacheTtlMs(): number {
  const parsed = Number(process.env.MCP_VERIFICATION_CACHE_TTL_SECONDS || 300);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300_000;
  return Math.min(Math.max(Math.trunc(parsed), 1), 3600) * 1000;
}

async function gitHead(root: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() || null : null));
  });
}

async function fileFingerprint(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return `nonfile:${stat.size}:${stat.mtimeMs}`;
    if (stat.size <= 2 * 1024 * 1024) {
      const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
      return `${stat.size}:${hash}`;
    }
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    return `missing:${(error as NodeJS.ErrnoException).code || "error"}`;
  }
}

export async function verificationFingerprint(root: string, command: string, affectedFiles: string[]): Promise<string | null> {
  const workingTree = await captureWorkingTree(root);
  if (!workingTree.repo_root) return null;
  const head = await gitHead(workingTree.repo_root);
  if (!head) return null;
  const hash = createHash("sha256");
  hash.update(path.resolve(root)).update("\0").update(command).update("\0").update(process.version).update("\0");
  hash.update(head).update("\0");
  for (const line of workingTree.status) hash.update("status=").update(line).update("\0");
  for (const [file, fingerprint] of Object.entries(workingTree.fingerprints).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update("dirty=").update(file).update("=").update(fingerprint).update("\0");
  }
  const files = [...new Set(affectedFiles.map((item) => path.resolve(root, item)))].sort();
  for (const file of files) hash.update(file).update("=").update(await fileFingerprint(file)).update("\0");
  for (const manifest of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    const target = path.join(root, manifest);
    try {
      await fs.access(target);
      hash.update(manifest).update("=").update(await fileFingerprint(target)).update("\0");
    } catch {}
  }
  return hash.digest("hex");
}

export async function hasVerificationCache(root: string, command: string, fingerprint: string): Promise<boolean> {
  const key = createHash("sha256").update(`${path.resolve(root)}\0${command}`).digest("hex");
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(key), "utf-8")) as CachedVerification;
    const ageMs = Date.now() - Date.parse(parsed.saved_at);
    return parsed.version === 1 && parsed.fingerprint === fingerprint && parsed.command === command && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= cacheTtlMs();
  } catch {
    return false;
  }
}

export async function saveVerificationCache(root: string, command: string, fingerprint: string): Promise<void> {
  const key = createHash("sha256").update(`${path.resolve(root)}\0${command}`).digest("hex");
  const value: CachedVerification = {
    version: 1,
    key,
    root: path.resolve(root),
    command,
    fingerprint,
    saved_at: new Date().toISOString(),
  };
  await fs.mkdir(cacheRoot(), { recursive: true });
  const target = cacheFile(key);
  const temp = `${target}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), "utf-8");
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export function selectIncrementalVerification(
  commands: VerificationCommand[],
  affectedFiles: string[],
  preset: "quick" | "full" | "custom"
): { commands: VerificationCommand[]; incremental: boolean; reason: string | null } {
  if (preset !== "quick" || !affectedFiles.length) return { commands, incremental: false, reason: null };
  const normalized = affectedFiles.map((item) => item.replace(/\\/g, "/").toLowerCase());
  const docsOnly = normalized.every((item) =>
    /(?:^|\/)(?:docs?|documentation)\//.test(item) ||
    /(?:^|\/)(?:readme|changelog|contributing|license)(?:\.[^/]+)?$/.test(item) ||
    /\.(?:md|mdx|rst)$/.test(item)
  );
  if (!docsOnly) return { commands, incremental: false, reason: null };
  const safe = commands.filter((item) => /git diff --check|lint.*(?:md|docs)|markdown/i.test(`${item.label} ${item.command}`));
  return {
    commands: safe.length ? safe : commands.filter((item) => /git diff --check/i.test(item.command)),
    incremental: true,
    reason: "docs-only change set",
  };
}
