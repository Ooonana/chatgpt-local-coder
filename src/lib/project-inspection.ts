import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { terminateChildProcessTree } from "./process-tree.js";
import { detectPackageManager } from "./package-manager.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".mcp-state",
  ".tool-test-tmp",
]);
const IMPORTANT_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "compose.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
];
const MAX_SCAN_FILES = 5_000;
const MAX_TOP_ENTRIES = 250;
const MAX_GIT_OUTPUT = 120_000;

export interface ProjectInspection {
  root: string;
  name: string;
  top_level: Array<{ name: string; type: "file" | "directory" }>;
  important_files: string[];
  languages: Array<{ extension: string; files: number }>;
  scanned_files: number;
  scan_truncated: boolean;
  package?: {
    name?: string;
    version?: string;
    manager?: string;
    scripts: string[];
  };
  git: {
    is_repo: boolean;
    branch?: string;
    head?: string;
    status?: string;
    changed_files?: number;
    error?: string;
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length > MAX_GIT_OUTPUT ? next.slice(-MAX_GIT_OUTPUT) : next;
}

async function killGitTree(child: ReturnType<typeof spawn>): Promise<void> {
  await terminateChildProcessTree(child, true).catch(() => {
    try { child.kill("SIGKILL"); } catch {}
  });
}

async function gitCapture(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      stderr = appendBounded(stderr, Buffer.from("git inspection timed out after 20s"));
      settled = true;
      void killGitTree(child).finally(() => {
        clearTimeout(timer);
        resolve({ code: 124, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    }, 20_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
    child.once("error", () => finish(127));
    child.once("close", (code) => finish(code ?? 1));
  });
}

async function inspectGit(root: string): Promise<ProjectInspection["git"]> {
  const inside = await gitCapture(["rev-parse", "--is-inside-work-tree"], root);
  if (inside.code !== 0 || inside.stdout !== "true") return { is_repo: false };
  const [branch, head, status] = await Promise.all([
    gitCapture(["branch", "--show-current"], root),
    gitCapture(["rev-parse", "--short=12", "HEAD"], root),
    gitCapture(["status", "--short", "--branch"], root),
  ]);
  const statusLines = status.stdout ? status.stdout.split(/\r?\n/) : [];
  const changed = statusLines.filter((line) => !line.startsWith("##")).length;
  return {
    is_repo: true,
    branch: branch.stdout || "(detached)",
    head: head.stdout || undefined,
    status: status.stdout || "Clean working tree",
    changed_files: changed,
    ...(status.code !== 0 ? { error: status.stderr || "git status failed" } : {}),
  };
}

async function inspectPackage(root: string, names: Set<string>): Promise<ProjectInspection["package"] | undefined> {
  if (!names.has("package.json")) return undefined;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf-8")) as {
      name?: string;
      version?: string;
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    return {
      name: raw.name,
      version: raw.version,
      manager: await detectPackageManager(root, raw.packageManager),
      scripts: Object.keys(raw.scripts || {}).sort(),
    };
  } catch {
    return { manager: await detectPackageManager(root), scripts: [] };
  }
}

export async function inspectProject(root: string, maxDepth = 4): Promise<ProjectInspection> {
  const resolved = path.resolve(root);
  const top = await fs.readdir(resolved, { withFileTypes: true });
  const topLevel = top
    .slice(0, MAX_TOP_ENTRIES)
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" as const : "file" as const }));
  const topNames = new Set(top.map((entry) => entry.name));
  const importantFiles: string[] = [];
  for (const name of IMPORTANT_FILES) {
    if (topNames.has(name) || await exists(path.join(resolved, name))) importantFiles.push(name);
  }

  const extensionCounts = new Map<string, number>();
  let scannedFiles = 0;
  let scanTruncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || scanTruncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanTruncated) break;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles++;
      if (scannedFiles >= MAX_SCAN_FILES) {
        scanTruncated = true;
        break;
      }
      const ext = path.extname(entry.name).toLowerCase() || "(no extension)";
      extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
    }
  }
  await walk(resolved, 0);

  const languages = [...extensionCounts.entries()]
    .map(([extension, files]) => ({ extension, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 20);

  const [git, pkg] = await Promise.all([inspectGit(resolved), inspectPackage(resolved, topNames)]);
  return {
    root: resolved,
    name: path.basename(resolved),
    top_level: topLevel,
    important_files: importantFiles,
    languages,
    scanned_files: scannedFiles,
    scan_truncated: scanTruncated,
    ...(pkg ? { package: pkg } : {}),
    git,
  };
}
