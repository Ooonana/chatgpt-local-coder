import { describePermissionProfile } from "./permissions.js";

export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
2. Call project_context(path) only for a different repo than WORKSPACE_PATH.
3. Explore with glob (file names) and grep (content), then read_text_file.
4. Edit with apply_patch (preferred), multi_edit, or write_file for new files.
5. Run builds/tests with run_command (short), run_commands_parallel (independent commands), or start_process + process_status/process_output (long). Batch independent operations to reduce ChatGPT/MCP round trips. Use pty for truly interactive terminal programs.
6. For resumable multi-step work, persist objective/plan/findings with agent_task. For isolated Git experiments, use git_worktree.
7. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- glob / grep / read_text_file: explore (offset+limit for partial reads; keep large results chunked)
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- run_command: persistent shell (cd persists); shell_status / shell_reset
- run_commands_parallel: run independent commands concurrently without mutating persistent cwd
- start_process / process_status / process_output / process_input / stop_process: background process lifecycle
- pty: real PTY/ConPTY for TUIs, debuggers, interactive installers, and terminal-native CLIs
- lsp: semantic hover/definition/references/symbols/diagnostics; TypeScript/JS + Python bundled
- view_image: return an arbitrary local image path as MCP image content for host visual analysis
- agent_task: persist/resume a multi-step coding objective, plan, notes, and status
- subagent: manage a separately configured model-capable runner; it does not reuse the parent ChatGPT subscription
- delegate_status: detect supported Claude/Codex/Grok/OpenCode CLIs without starting them
- git_status / git_diff / git_worktree / git_add / git_commit / git_restore
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- enabled upstream MCP tools are exposed directly as <server>__<tool> (for example chrome-devtools__list_pages, linear__get_user); prefer direct tools
- mcp_servers: upstream status. mcp_tools / mcp_call are low-level full-profile diagnostics/fallbacks
- Full/optional-profile helpers not normally advertised in slim include raw binary I/O, search_files/list_allowed_directories, delete_directory, git_checkout/git_push/git_pull/git_reset, and mcp_tools/mcp_call
- If a helper is hidden by the active profile, use an appropriate run_command equivalent or enable it in Admin UI, then open a new MCP chat

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Relative paths resolve from the default cwd. Absolute-path access depends on the active permission profile; call agent_status for the effective policy and roots.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  _fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# ChatGPT Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    `Permission policy: ${describePermissionProfile()}`,
    "Tag this connector in ChatGPT before every task.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load CLAUDE.md from another repo",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}