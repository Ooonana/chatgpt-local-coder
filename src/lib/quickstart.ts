import { describePermissionProfile } from "./permissions.js";

export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
2. Call project_context(path) to load another repo's instructions/context, but keep passing explicit path/workspace/working_directory on later calls because ChatGPT may use a fresh MCP transport.
3. Explore with inspect_project first, then repo_intel for symbol/reference/impact questions; use glob/grep/read_files/read_text_file for lower-level inspection.
4. For substantial implementation/fix/refactor work, create/resume agent_task and begin coding_loop. Use the returned transaction_id on supported edits, verify through coding_loop, repair in the same transaction, then finish or rollback. For small atomic edits, use edit_transaction directly.
5. Run builds/tests with coding_loop/verify_project when appropriate, run_command for short commands, run_commands_parallel for independent commands, or start_process + process_status/process_output for long jobs. Use pty for truly interactive terminal programs.
6. ChatGPT may not auto-compact long chats. After major decisions or a context_checkpoint_hint, save a compact context_capsule checkpoint. If the hint sets rollover_recommended=true, reach a safe boundary and continue in a fresh chat, then resume the capsule there; Local Coder cannot erase host chat history in place. After chat/context loss, resume the capsule first, then reconcile agent_task/coding_loop state instead of rediscovering work.
7. For interrupted substantial work, check coding_loop_status and resume the existing loop instead of rediscovering state. For isolated Git work, prefer coding_loop isolation=worktree; use git_worktree directly when no coding loop is needed.
8. Undo unrelated ordinary file edits with rewind (list → preview → restore). For transaction-owned edits, use edit_transaction/coding_loop rollback instead. Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- coding_loop / coding_loop_status: persistent inspect→edit→verify→repair→finish state machine around regular ChatGPT; supports bounded retries and optional worktree isolation
- agent_task: persist/resume a multi-step coding objective, structured plan, notes, and status
- context_capsule: compact semantic checkpoint + automatic machine-state snapshot for recovery when ChatGPT conversation context is lost
- inspect_project / repo_intel: repository reconnaissance plus symbol/reference/impact intelligence
- edit_transaction: durable preview/verify/accept/conflict-safe rollback boundary for atomic edits
- glob / grep / read_files / read_text_file: lower-level exploration (keep large results bounded)
- apply_patch: preferred patch editor; single-file @@ hunks OR multi-file *** Begin Patch format; pass transaction_id when a coding loop/transaction is active
- verify_project: discover/run bounded repository verification recipes
- run_command: short bounded shell command; pass working_directory for project work because ChatGPT transports do not share hidden cwd by default
- run_commands_parallel: run independent commands concurrently without mutating transport-local cwd
- start_process / process_status / process_output / process_input / stop_process: background process lifecycle
- pty: real PTY/ConPTY for TUIs, debuggers, interactive installers, and terminal-native CLIs
- view_image: return an arbitrary local image path as MCP image content for host visual analysis
- subagent: manage a separately configured model-capable runner; it does not reuse the parent ChatGPT subscription
- git_status / git_diff / git_worktree / git_commit
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- enabled upstream MCP tools are exposed directly as <server>__<tool> (for example chrome-devtools__list_pages, linear__get_user); prefer direct tools

- computer_observe / computer_act: opt-in Vercel desktop/browser MCP; inspect UI or act with explicit authorization, allowlisted commands and optional post-action text verification. A saved agent_task is never proof that a computer operation is running.
- mcp_servers: upstream status. mcp_tools / mcp_call are low-level full-profile diagnostics/fallbacks
- Full/optional-profile helpers not normally advertised in slim include raw lsp, delegate_status, multi_edit, git_add/git_restore, raw binary I/O, search_files/list_allowed_directories, delete_directory, git_checkout/git_push/git_pull/git_reset, and mcp_tools/mcp_call
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