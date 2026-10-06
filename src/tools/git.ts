import { spawn } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { assertCurrentSessionMutationPath, getCurrentSessionState } from "../lib/session-context.js";
import { terminateChildProcessTree } from "../lib/process-tree.js";

interface GitRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

const MAX_GIT_OUTPUT_CHARS = 500_000;
const GIT_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.GIT_TIMEOUT_MS || 300_000);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300_000;
  return Math.min(Math.max(Math.trunc(parsed), 5_000), 10 * 60 * 1000);
})();

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length > MAX_GIT_OUTPUT_CHARS ? next.slice(-MAX_GIT_OUTPUT_CHARS) : next;
}

async function killGitTree(child: ReturnType<typeof spawn>): Promise<void> {
  await terminateChildProcessTree(child, true).catch(() => {
    try { child.kill("SIGKILL"); } catch {}
  });
}

function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (d: Buffer) => (stdout = appendBounded(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = appendBounded(stderr, d)));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void killGitTree(child).finally(() => reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`)));
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code ?? 1 });
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("git not found. Install Git for Windows."));
    });
  });
}

async function gitOrThrow(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await runGit(args, cwd);
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited with code ${result.exit_code}`);
  }
  return result;
}

function assertSafeGitPositional(value: string | undefined, label: string): void {
  if (value === undefined) return;
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with '-' because Git could interpret it as an option`);
  }
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} contains an invalid control character`);
}

export function registerGitTools(server: McpServer, defaultCwd: string): void {
  const repo = async (p?: string) => {
    const session = getCurrentSessionState();
    return p
      ? validatePath(p)
      : session?.workspace_kind === "project" && session.project_root
        ? session.project_root
        : defaultCwd;
  };
  const mutableRepo = async (p: string | undefined, operation: string) => {
    const cwd = await repo(p);
    await assertCurrentSessionMutationPath(cwd, operation);
    return cwd;
  };

  server.registerTool("git_status", {
    title: "Git Status", description: "Show git working tree status.",
    inputSchema: { path: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath }) => {
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["status", "--short", "--branch"], cwd);
    await audit({ tool: "git_status", action: "git", target: cwd, status: "ok" });
    return toolResult("git_status", { path: cwd, output: r.stdout || "Clean working tree" });
  });

  server.registerTool("git_diff", {
    title: "Git Diff", description: "Show unstaged or staged changes.",
    inputSchema: { path: z.string().optional(), staged: z.boolean().optional().default(false), file: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, staged, file }) => {
    const cwd = await repo(repoPath);
    const args = ["diff"];
    if (staged) args.push("--staged");
    if (file) args.push("--", file);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_diff", { path: cwd, staged, file, output: r.stdout || "No changes" });
  });

  server.registerTool("git_log", {
    title: "Git Log", description: "Show recent commit history.",
    inputSchema: { path: z.string().optional(), count: z.number().int().positive().max(200).optional().default(10) },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, count }) => {
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["log", "--oneline", "-n", String(count)], cwd);
    return toolResult("git_log", { path: cwd, count, commits: r.stdout.split("\n").filter(Boolean) });
  });

  server.registerTool("git_worktree", {
    title: "Git Worktree",
    description:
      "List or manage isolated Git worktrees for parallel coding tasks. add/remove/prune modify local repository worktree state; no remote operations are performed.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "add", "remove", "prune"]).optional().default("list"),
      worktree_path: z.string().optional(),
      branch: z.string().optional(),
      new_branch: z.string().optional(),
      start_point: z.string().optional(),
      force: z.boolean().optional().default(false),
    },
    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, worktree_path, branch, new_branch, start_point, force }) => {
    const cwd = action === "list" ? await repo(repoPath) : await mutableRepo(repoPath, "git_worktree");
    if (action === "list") {
      const r = await gitOrThrow(["worktree", "list", "--porcelain"], cwd);
      return toolResult("git_worktree", { path: cwd, action, output: r.stdout });
    }

    requireWriteAllowed();
    if (action === "prune") {
      const args = ["worktree", "prune"];
      if (force) args.push("--expire", "now");
      const r = await gitOrThrow(args, cwd);
      await audit({ tool: "git_worktree", action: "prune", target: cwd, status: "ok" });
      return toolResult("git_worktree", { path: cwd, action, output: r.stdout || r.stderr || "Pruned" });
    }

    if (!worktree_path) throw new Error(`worktree_path is required for ${action}`);
    const target = await validatePath(worktree_path);

    if (action === "remove") {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(target);
      const r = await gitOrThrow(args, cwd);
      await audit({ tool: "git_worktree", action: "remove", target, status: "ok", details: { force } });
      return toolResult("git_worktree", { path: cwd, action, worktree_path: target, output: r.stdout || r.stderr || "Removed" });
    }

    if (branch && new_branch) throw new Error("Use branch or new_branch, not both");
    assertSafeGitPositional(branch, "branch");
    assertSafeGitPositional(new_branch, "new_branch");
    assertSafeGitPositional(start_point, "start_point");
    const args = ["worktree", "add"];
    if (force) args.push("--force");
    if (new_branch) args.push("-b", new_branch);
    args.push(target);
    if (new_branch) args.push(start_point || "HEAD");
    else if (branch) args.push(branch);
    else if (start_point) args.push(start_point);
    const r = await gitOrThrow(args, cwd);
    await audit({
      tool: "git_worktree",
      action: "add",
      target,
      status: "ok",
      details: { branch, new_branch, start_point, force },
    });
    return toolResult("git_worktree", {
      path: cwd,
      action,
      worktree_path: target,
      branch,
      new_branch,
      start_point,
      output: r.stdout || r.stderr || "Added",
    });
  });

  server.registerTool("git_add", {
    title: "Git Add", description: "Stage files for commit.",
    inputSchema: { path: z.string().optional(), files: z.array(z.string()).optional(), all: z.boolean().optional().default(true) },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, all }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_add");
    const args = ["add"];
    if (all && (!files || files.length === 0)) args.push("-A");
    else if (files?.length) args.push("--", ...files);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_add", { path: cwd, files: files || ["-A"], output: r.stdout });
  });

  server.registerTool("git_commit", {
    title: "Git Commit", description: "Create a commit; stages all changes first by default. Set stage_all=false to commit only already-staged changes.",
    inputSchema: {
      message: z.string().max(100_000),
      path: z.string().optional(),
      stage_all: z.boolean().optional().default(true),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ message, path: repoPath, stage_all }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_commit");
    if (stage_all) await gitOrThrow(["add", "-A"], cwd);
    const r = await gitOrThrow(["commit", "-m", message], cwd);
    await audit({ tool: "git_commit", action: "git", target: cwd, status: "ok", details: { message } });
    return toolResult("git_commit", { path: cwd, message, output: r.stdout });
  });

  server.registerTool("git_branch", {
    title: "Git Branch", description: "List/create/switch branches.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "create", "switch", "create-and-switch"]).optional().default("list"),
      name: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, name }) => {
    const cwd = action === "list" ? await repo(repoPath) : await mutableRepo(repoPath, "git_branch");
    let args: string[];
    if (action === "list") args = ["branch", "--all"];
    else {
      requireWriteAllowed();
      if (!name) throw new Error("name is required");
      assertSafeGitPositional(name, "branch name");
      args = action === "create" ? ["branch", name] : action === "switch" ? ["switch", name] : ["switch", "-c", name];
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_branch", { path: cwd, action, name, output: r.stdout });
  });

  server.registerTool("git_checkout", {
    title: "Switch Git Branch",
    description:
      "Switch the current local repository to an existing branch. Local workspace only — does not modify remotes.",
    inputSchema: {
      path: z.string().optional(),
      branch: z.string().describe("Existing branch name to switch to"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, branch }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_checkout");
    assertSafeGitPositional(branch, "branch");
    const r = await gitOrThrow(["switch", branch], cwd);
    return toolResult("git_checkout", {
      path: cwd,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: `git switch ${branch}`,
    });
  });

  server.registerTool("git_restore", {
    title: "Restore Tracked Files",
    description:
      "Restore tracked file(s) in the current repo to the last committed version. Local workspace only.",
    inputSchema: {
      path: z.string().optional(),
      files: z.array(z.string()).min(1).max(2_000).describe("Repo-relative file paths to restore"),
      source: z
        .string()
        .optional()
        .default("HEAD")
        .describe("Revision to restore from (default HEAD)"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, source }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_restore");
    assertSafeGitPositional(source, "source");
    let r: GitRunResult;
    const restore = await runGit(["restore", "--source", source, "--", ...files], cwd);
    if (restore.exit_code === 0) {
      r = restore;
    } else {
      r = await gitOrThrow(["checkout", source, "--", ...files], cwd);
    }
    return toolResult("git_restore", {
      path: cwd,
      files,
      source,
      output: r.stdout || r.stderr || "Restored",
      run_command_fallback: `git restore --source ${source} -- ${files.join(" ")}`,
    });
  });

  server.registerTool("git_push", {
    title: "Sync Commits to Remote",
    description:
      "Upload local commits to the repository's configured remote (default origin). Uses the repo's existing remote URL.",
    inputSchema: {
      path: z.string().optional(),
      remote: z.string().optional().default("origin"),
      branch: z.string().optional(),
      set_upstream: z.boolean().optional().default(false),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, remote, branch, set_upstream }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_push");
    assertSafeGitPositional(remote, "remote");
    assertSafeGitPositional(branch, "branch");
    const args = ["push"];
    if (set_upstream) args.push("-u");
    args.push(remote);
    if (branch) args.push(branch);
    const r = await gitOrThrow(args, cwd);
    const cmd = ["git push", set_upstream ? "-u" : "", remote, branch ?? ""]
      .filter(Boolean)
      .join(" ");
    return toolResult("git_push", {
      path: cwd,
      remote,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: cmd,
    });
  });

  server.registerTool("git_pull", {
    title: "Sync from Remote",
    description:
      "Download updates from the repository's configured remote into the local working copy.",
    inputSchema: { path: z.string().optional(), remote: z.string().optional().default("origin"), branch: z.string().optional() },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, remote, branch }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_pull");
    assertSafeGitPositional(remote, "remote");
    assertSafeGitPositional(branch, "branch");
    const args = ["pull", remote];
    if (branch) args.push(branch);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_pull", { path: cwd, remote, branch, output: r.stdout || r.stderr });
  });

  server.registerTool("git_stash", {
    title: "Git Stash", description: "Stash list/push/pop/apply.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "push", "pop", "apply"]).optional().default("list"),
      message: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, message }) => {
    const cwd = action === "list" ? await repo(repoPath) : await mutableRepo(repoPath, "git_stash");
    const args = ["stash"];
    if (action === "list") args.push("list");
    else {
      requireWriteAllowed();
      if (action === "push") {
        args.push("push");
        if (message) args.push("-m", message);
      } else args.push(action);
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_stash", { path: cwd, action, output: r.stdout || r.stderr });
  });

  server.registerTool("git_reset", {
    title: "Git Reset",
    description:
      "Move HEAD to a ref in the local repo. mixed=unstage commits, soft=keep staged, hard=discard working changes.",
    inputSchema: {
      path: z.string().optional(),
      mode: z.enum(["soft", "mixed", "hard"]).optional().default("mixed"),
      ref: z.string().optional().default("HEAD"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, mode, ref }) => {
    requireWriteAllowed();
    const cwd = await mutableRepo(repoPath, "git_reset");
    assertSafeGitPositional(ref, "ref");
    const r = await gitOrThrow(["reset", `--${mode}`, ref], cwd);
    return toolResult("git_reset", { path: cwd, mode, ref, output: r.stdout || r.stderr });
  });
}