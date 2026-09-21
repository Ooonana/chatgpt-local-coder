import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

export interface WorkingTreeSnapshot {
  repo_root: string | null;
  status: string[];
  fingerprints: Record<string, string>;
}

export interface ShellMutationEvidence {
  tracked: boolean;
  repo_root: string | null;
  before: string[];
  after: string[];
  changed_paths: string[];
}

const MUTATING_PATTERN = /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|mkdir|rmdir|del|erase|move|copy|ren|rename-item|remove-item|set-content|add-content|out-file|new-item|npm\s+(?:install|uninstall)|pnpm\s+(?:add|remove|install)|yarn\s+(?:add|remove|install)|git\s+(?:add|restore|checkout|reset|clean|apply|commit|merge|rebase)|python(?:3)?\s+[^\r\n]*|py\s+[^\r\n]*|node\s+[^\r\n]*)/i;

export function commandMayMutate(command: string): boolean {
  return MUTATING_PATTERN.test(command) || />{1,2}\s*[^&|]/.test(command);
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.on("error", () => resolve({ code: 1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function statusEntries(records: string[]): Array<{ path: string; status: string }> {
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (firstPath) entries.push({ path: firstPath, status });
    if (/[RC]/.test(status) && index + 1 < records.length) {
      const secondPath = records[++index];
      if (secondPath) entries.push({ path: secondPath, status });
    }
  }
  return entries;
}

async function fingerprintPath(repoRoot: string, relativePath: string): Promise<string> {
  const target = path.resolve(repoRoot, relativePath);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(target)}`;
    if (!stat.isFile()) return `nonfile:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const hash = createHash("sha256");
    const handle = await fs.open(target, "r");
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return `file:${stat.mode}:${stat.size}:${hash.digest("hex")}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || "error";
    return `missing:${code}`;
  }
}

export async function captureWorkingTree(cwd: string): Promise<WorkingTreeSnapshot> {
  const rootResult = await git(["rev-parse", "--show-toplevel"], cwd);
  if (rootResult.code !== 0) return { repo_root: null, status: [], fingerprints: {} };
  const root = path.resolve(rootResult.stdout.trim());
  const statusResult = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  const rawStatus = statusResult.code === 0 ? statusResult.stdout.split("\0").filter(Boolean) : [];
  const status = [...rawStatus].sort();
  const fingerprints: Record<string, string> = {};
  for (const entry of statusEntries(rawStatus)) {
    fingerprints[entry.path] = `${entry.status}:${await fingerprintPath(root, entry.path)}`;
  }
  return { repo_root: root, status, fingerprints };
}

export function compareWorkingTrees(before: WorkingTreeSnapshot, after: WorkingTreeSnapshot): ShellMutationEvidence {
  const fingerprintPaths = new Set([...Object.keys(before.fingerprints), ...Object.keys(after.fingerprints)]);
  const changedFingerprints = [...fingerprintPaths].filter(
    (file) => before.fingerprints[file] !== after.fingerprints[file]
  );
  return {
    tracked: Boolean(before.repo_root || after.repo_root),
    repo_root: after.repo_root || before.repo_root,
    before: before.status,
    after: after.status,
    changed_paths: [...new Set(changedFingerprints)].sort(),
  };
}
