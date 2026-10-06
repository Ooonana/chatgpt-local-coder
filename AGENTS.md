# ChatGPT Local Coder — Agent Onboarding

Local MCP server for coding-agent workflows in the regular ChatGPT app: read and edit files, run commands, manage Git, inspect project context, keep task state, and proxy upstream MCP servers. It is designed for ChatGPT Developer Mode/chat connectors, not Codex or ChatGPT Work.

## First connection

The default project's memory and Git state are already injected into MCP instructions. Call these only when useful:

1. **`agent_status`** — inspect permissions, machine roots, current tool profile, rewind configuration, and upstream MCP status.
2. **`project_context(path)`** — load `AGENTS.md`, `CLAUDE.md`, README, and related project context when working in a project other than the configured `WORKSPACE_PATH`.

## Access model

- The default `open` permission profile allows full local paths, commands, and configured runtimes (subject to OS ACLs). `workspace`, `read_only`, and `custom` profiles can restrict this.
- Absolute paths are supported, for example `C:\`, `D:\Projects\...`, `/Users/you/projects/...`, and `/home/you/...`.
- `WORKSPACE_PATH` sets the default cwd for relative paths, shell commands, and Git. By itself it is not a sandbox boundary; restrictive Local Coder permission profiles can enforce configured roots at the application layer.
- ChatGPT may create a fresh MCP transport for each tool call. Treat transport/session IDs as diagnostics, not chat/work ownership. Use explicit `path`, `workspace`, and especially `working_directory` for project work; Local Coder derives mutation scope per call.
- Read-only upstream MCP tools can remain available under restrictive profiles; mutating or annotation-unknown upstream calls are treated as unsafe runtimes and require explicit permission.
- `CHATGPT_AUTO_APPROVE=true` marks routine local operations to reduce unnecessary confirmation prompts.

## ChatGPT connector behavior

Before starting work after a server update or restart:

1. Open **Settings → Apps / Connectors** and select the Local Coder connector.
2. Choose the connector permission level you want.
3. Refresh the connector after server/tool-schema changes.
4. Start a new chat and enable/tag the connector before sending the task.

Avoid relying on the popup **Always allow** action if it causes the MCP session to reset. If the tunnel reports `stream canceled by remote`, keep the server and tunnel running, refresh the connector, and start a new MCP chat.

For a stable public endpoint on Windows, use `openai-tunnel.ps1 -Init` once to configure credentials, then use `start.ps1`; Local Coder supervises `tunnel-client` in the same runtime so a second tunnel window is not needed. macOS/Linux users should run a compatible tunnel client directly or use another supported tunnel.

## Tool profiles

`CHATGPT_TOOL_PROFILE` controls which native tools are advertised to the client:

| Profile | Purpose |
|---|---|
| `slim` *(default)* | Core coding tools for the ChatGPT app with a smaller `tools/list` payload. |
| `full` | Every native Local Coder tool. Useful for other MCP clients or less common operations. |

The complete native catalog is maintained in `src/lib/tool-profile.ts` and is checked against literal `server.registerTool()` declarations by `scripts/test-tool-profile.mjs`. Do not maintain separate hard-coded tool counts in documentation.

The Admin UI can force-enable a native tool outside `slim` or disable any native tool through `profiles/tool-overrides.json`. Unknown/stale override names are filtered automatically.

The default `slim` profile includes the high-value read/edit/search tools, bounded and parallel shell execution, background-process lifecycle tools, PTY/image inspection, Git status/diff/worktree/commit, project/task/transaction/coding-loop/context-capsule tools, rewind, skills/rules, subagent execution, and `mcp_servers`. Overlapping or lower-level helpers such as `multi_edit`, raw `lsp`, `delegate_status`, `git_add`, `git_restore`, destructive/remote Git helpers, raw binary writes, shell reset/clear-process helpers, `node_repl`, `ponytail_turn`, and low-level `mcp_tools` / `mcp_call` remain opt-in/full-profile unless explicitly overridden. Treat `src/lib/tool-profile.ts` as authoritative.

## Claude Code ↔ Local Coder mapping

| Claude Code concept | Local Coder | Notes |
|---|---|---|
| `Read` | `read_text_file` | Supports `offset` + `limit` with line numbers. |
| `Write` | `write_file` | Creates or overwrites text files. |
| `Edit` | `edit_file` | Exact text replacement with optional `replace_all`. |
| `MultiEdit` | `multi_edit` | Atomic multiple replacements in one file. |
| `Glob` | `glob` | File-name discovery. |
| `Grep` | `grep` | `content`, `files_with_matches`, and `count` modes. |
| `LS` | `list_directory` | Optional ignore globs. |
| `Bash` | `run_command` | Short/finite commands; pass `working_directory`. Cwd is transport-local and is not persisted for ChatGPT by default. |
| Parallel shell | `run_commands_parallel` | Independent commands run concurrently in isolated processes. Batch state is durable so retry/recovery should rerun only failed or incomplete members. |
| Background shell | `start_process` + process tools | Use `process_status`, `process_output`, `process_input`, and `stop_process`. Prefer event/wait conditions for exit/text instead of repeated `Start-Sleep` polling. `process_input` is piped stdin, not a full PTY. |
| Interactive terminal | `pty` | Real PTY/ConPTY for TUIs, debuggers, installers, and terminal-native CLIs. |
| LSP | `lsp` | Hover, definitions, references, symbols, and diagnostics. TypeScript/JS and Python are bundled. |
| Local image inspection | `view_image` | Returns a local image path as MCP image content so the host can inspect it visually. |
| Rewind | `rewind` | `list` → `preview` → `restore` for automatic file-edit checkpoints. |
| Project rules | `project_context`, `load_path_rules` | Loads project and path-scoped instructions. |
| Skills | `list_skills`, `load_skill` | Load matching project/plugin skills before use. |
| Persistent task state | `agent_task` | Stores objective, plan, notes, workspace, and status across MCP sessions. It is **not** a subagent. |
| Resumable chat working state | `context_capsule` | Stores a bounded semantic handoff plus live task/loop/transaction/Git state when ChatGPT conversation context may be lost. |
| External subagent | `subagent` | Runs a separately configured model-capable process, optionally in an isolated Git worktree. It cannot reuse the parent ChatGPT subscription. |
| Delegate discovery | `delegate_status` | Detects supported Claude/Codex/Grok/OpenCode CLIs without launching them. |
| Isolated Git work | `git_worktree` | Useful for parallel or experimental branches without switching the main checkout. |
| Upstream MCP | `<server>__<tool>` | Enabled upstream tools are exposed directly when possible. |
| Upstream diagnostics | `mcp_servers`, `mcp_tools`, `mcp_call` | Low-level bridge/fallback; some are full-profile only. |

Real delegated subagents are available through the external-runner `subagent` tool when explicitly configured. Web browsing, general uploaded-file understanding, data analysis, and browser/site tooling can still be supplied by the ChatGPT host instead of being duplicated in Local Coder.

## Recommended coding workflow

| Task | Preferred tool |
|---|---|
| Find files | `glob` |
| Search source | `grep` |
| Read a file | `read_text_file` |
| List a directory | `list_directory` |
| Patch code | `apply_patch` *(preferred)* |
| Apply several exact edits | `multi_edit` |
| Create a text file | `write_file` |
| Short command/build/test | `run_command` |
| Independent commands in parallel | `run_commands_parallel`; recover/retry only failed or incomplete members when a batch id is returned |
| Long-running build/server | `start_process` → `process_status` / `process_output` with wait condition → optional `process_input` → `stop_process` |
| Interactive terminal/TUI/debugger | `pty` |
| Definition/reference/diagnostics | `repo_intel` in slim; raw `lsp` in full/override profile |
| Inspect a local screenshot/image | `view_image` |
| Inspect Git | `git_status`, `git_diff` |
| Isolated branch work | `git_worktree` |
| Commit | `git_commit` (stages all changes by default; use `stage_all=false` for already-staged changes) |
| Lower-level stage/restore | `git_add`, `git_restore` in full/override profile |
| Persist a long task | `agent_task` |
| Preserve/resume long-chat working context | `context_capsule` |
| Delegate to configured external model runner | `subagent` |
| Detect compatible local agent CLIs | `delegate_status` |
| Undo Local Coder file edits | `rewind` |

For non-trivial changes: explore first, read every file you will edit, apply the smallest practical patch, then run relevant build/tests. Preserve unrelated user changes in a dirty working tree.

When a shell command may edit files, prefer its mutation/idempotency/transaction options instead of wrapping the mutation in an opaque command and assuming `rewind` saw it. Shell mutation evidence fingerprints dirty/untracked contents so an already-dirty file changing again is still detected. Do not reuse a successful verification result across a changed worktree; `verify_project` caching is opt-in and intentionally conservative.

For runtime/schema problems, use `agent_status(mode="doctor")`. Runtime identity is written only by a real server bootstrap; tests/imports must not overwrite it. Doctor can flag stale durable tasks/loops/transactions, schema-refresh recommendations, state read failures, and heap/cache pressure, but it must not silently delete resumable state. Keep long-run memory bounded: text caching is byte-budgeted, old MCP sessions are capped/evicted while stale IDs remain recoverable, and completed process/PTY/subagent plus LSP registries have finite retention.

Do not assume the ChatGPT host will auto-compact a long coding conversation. After important decisions or a returned `context_checkpoint_hint`, checkpoint a compact semantic summary/decisions/findings/blockers/next steps with `context_capsule`. If the hint sets `rollover_recommended=true`, finish the current safe boundary and continue in a fresh chat, then resume the capsule there. On a new/corrupted chat or when the user says continue and prior reasoning is missing, resume the capsule before rediscovering the repository. Local Coder can automatically snapshot machine state, but it cannot read hidden ChatGPT history, erase old host messages, or reconstruct unrecorded reasoning.

## `apply_patch` format

Single-file Codex-style hunk:

```text
@@
-old line
+new line
 context line
```

Multi-file format:

```text
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch
```

Use `dry_run: true` to preview a patch before writing when appropriate.

## Rewind/checkpoints

Local Coder captures checkpoints before file-editing MCP tools. Typical workflow:

1. `rewind(action="list")`
2. `rewind(action="preview", checkpoint_id="...")`
3. `rewind(action="restore", checkpoint_id="...")`

Shell commands that directly modify files are not captured by rewind.

## Paths

- Prefer absolute paths when the target is unambiguous.
- Relative paths resolve from the configured default cwd.
- For another repository, call `project_context(path)` to load its instructions, but still pass explicit paths/workspaces/working directories on later calls because ChatGPT may use a new MCP transport.

## Starting the server

**Windows**

```powershell
.\start.ps1                 # build only if changed + restart MCP + live TUI + Admin UI + supervised tunnel
```

`-Force` remains accepted for compatibility. `-Rebuild` forces compilation; `-NoBuild` reuses an existing `dist`. Use `-NoTunnel` only when you explicitly want the local MCP server without managing the OpenAI tunnel.

First tunnel setup:

```powershell
.\openai-tunnel.ps1 -Init
```

**macOS / Linux**

```bash
npm start                    # build + MCP server + live TUI + Admin UI
npm run tunnel
# or another HTTPS tunnel, for example:
ssh -p 443 -R0:localhost:3000 a.pinggy.io
```

When `MCP_TOKEN` is configured, the connector endpoint must include it: `https://<tunnel>/mcp/<MCP_TOKEN>`. Treat that URL as a credential.

Health check: `http://127.0.0.1:3000/health`

Admin UI: `http://127.0.0.1:<ADMIN_PORT>/ui` (default port: `3001`)

The terminal dashboard is enabled automatically in an interactive terminal and shows current time, uptime, MCP transports, live/active tool calls, call kind (`READ` / `EDIT` / `EXEC` / `MCP`), running background processes/PTYs/subagents with liveness, recent completions, durations, per-tool usage, CPU, RSS, and heap. Set `LOCAL_CODER_TUI=off` for traditional scrolling logs.

## Troubleshooting

| Problem | Action |
|---|---|
| Access denied | Verify the active Local Coder permission profile, configured roots, and OS permissions. Even the default `open` profile does not bypass OS ACLs. |
| Patch context not found | Re-read the file and add enough unchanged context around the hunk. |
| ChatGPT asks on every call | Review connector permissions and `CHATGPT_AUTO_APPROVE`. |
| Connection failed | Ensure both server and tunnel are running, and use the correct HTTPS connector URL. |
| Tool not found | Check the active profile/overrides with `agent_status` or the Admin UI. |
| Connector hangs after a schema update | Run `npm run build`, restart the server, refresh the connector, and start a new chat. |
| `stream canceled` | The MCP stream was closed/reset; keep services stable, refresh, and reconnect. |

Some wrapper tools may be rejected by the host client's safety layer even when the same local operation is valid. Where appropriate, use an equivalent `run_command` fallback and verify the result.