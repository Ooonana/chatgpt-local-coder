<div align="center">

<img src="public/ui/assets/local-coder-icon.png" alt="Local Coder icon" width="96" height="96" />

# ChatGPT Local Coder

**Turn the ChatGPT app into a local coding agent — files, shell, git, patches, and extensible MCP tools.**

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Developer%20Mode-10a37f?style=flat-square)](https://platform.openai.com/docs/guides/developer-mode)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4?style=flat-square)](https://nodejs.org)

[Quick Start](#-quick-start) · [Connect ChatGPT](#-connect-chatgpt) · [Tools](#-tools) · [Tunnel](#-tunnel-options) · [Troubleshooting](#-troubleshooting)

</div>

---

ChatGPT Local Coder is a **self-hosted MCP server** that gives ChatGPT (and any MCP client) local coding tools for files, shell commands, Git, patches, and project exploration. The default `open` permission profile allows full local access; restrictive profiles are available when you want Local Coder itself to limit paths or actions.

No separate coding client. No vendor lock-in. Run one Node process on your PC, expose it through a tunnel, and code from a regular ChatGPT chat with the connector enabled.

```
┌─────────────────┐     HTTPS      ┌──────────────────┐     localhost     ┌─────────────────────┐
│   ChatGPT App   │ ─────────────► │  Tunnel (opt.)   │ ────────────────► │  chatgpt-local-coder │
│ Developer Mode  │                │ OpenAI / CF      │      :3000/mcp    │  Native MCP tools    │
└─────────────────┘                └──────────────────┘                   └──────────┬──────────┘
                                                                                    │
                                         ┌──────────────────────────────────────────┼──────────┐
                                         ▼                    ▼                    ▼          ▼
                                   Filesystem              Shell + Git         Background    Project
                                   read/write/patch        status/diff/commit   processes     context
```

## ✨ Why this project

| | ChatGPT alone | **+ ChatGPT Local Coder** |
|---|---|---|
| Edit your repo | ❌ | ✅ `apply_patch`, `edit_file`, `multi_edit` |
| Run tests / builds | ❌ | ✅ `run_command`, `start_process` |
| Git workflow | ❌ | ✅ `git_status`, `git_commit`, `git_push`, … |
| Explore codebase | Limited | ✅ `inspect_project`, `repo_intel`, `glob`, `grep`, `lsp` |
| Review/rollback a change set | ❌ | ✅ `edit_transaction` with preview, verify, accept/rollback |
| Resumable coding-agent loop | ❌ | ✅ `coding_loop` with persistent context, bounded repair attempts, transaction ownership, and optional worktree isolation |
| Survive lost/compacted chat context | ❌ | ✅ `context_capsule` persists compact reasoning handoff + live machine state across new chats/restarts |
| Full disk access | ❌ | ✅ Any path by default with the `open` profile |
| Session recovery | — | ✅ Auto-recover after server restart |

Built for **[ChatGPT Developer Mode](https://platform.openai.com/docs/guides/developer-mode)** with optimized tool annotations (fewer permission popups) and **[OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)** support (stable URL, no connector re-wiring every restart).

## 🚀 Quick Start

### Agent Skills (project and global)

Local Coder discovers skills from the current project's `.agents/skills`,
`.claude/skills`, and `.codex/skills` directories, followed by the same three
directories in the user's home folder. Additional global directories can be
supplied through `LOCAL_CODER_SKILL_DIRS` (OS path delimiter separated).
Project skills take precedence when multiple directories use the same skill name.
Restricted permission profiles hide skills outside configured filesystem roots.

Call `list_skills` to discover available skills, then `load_skill` to read one.
Both tools accept an optional `path` to explicitly choose a project root.
To read a supporting Markdown/text reference without reloading the entire skill,
pass `reference_path` to `load_skill`, for example `references/api.md`.
Reference paths are resolved inside their skill directory, and traversal or
symlink escapes are rejected. Installing a skill does not automatically enable
the programs or MCP tools that the skill describes.

The Admin UI's **MCP Servers → Agent Skills** panel can disable or re-enable
individual skills for a selected project or globally. It writes versioned
JSON controls to `<project>/.local-coder/skills.json` and
`~/.local-coder/skills.json`, respectively. A global disable always takes
precedence over the project toggle. Disabled skills are omitted from
`list_skills` and cannot be loaded by name. Invalid settings fail visibly.
The Admin UI saves individual toggles atomically, so simultaneous changes do
not overwrite unrelated skill controls. Skill name/description YAML scalars
support quoted values and folded descriptions; discovery uses bounded reads.

### Opt-in Vercel computer-use MCP providers

From the Admin UI's **MCP Servers** view, choose **+ Computer-use presets**.
This adds disabled upstream MCP entries for Vercel's `agent-desktop` (native
accessibility/UI control) and `agent-browser` (Chrome/CDP). It does not download,
start, or enable either program. Existing entries with those IDs are preserved.
To use them, install the corresponding CLI separately (for example,
`npm install -g agent-desktop` and `npm install -g agent-browser`), test its
availability, then enable the server and select the MCP tools you want to
expose. The default `meta_only` exposure deliberately advertises no direct
upstream tools. Once enabled, Local Coder offers `computer_observe` and
`computer_act` in the slim profile with an explicit allowlist, rather than
automatically advertising all upstream controls. Input requires
`allow_input=true` and an unsafe-runtime-enabled permission profile. The
`allow_input` flag is provided by the caller; it is **not** independent proof
of human approval. Host-side confirmation depends on the MCP client.
It can verify a fresh snapshot against `expected_text`; desktop input by
`ref_id` requires a recent `computer_observe` snapshot scoped to
`arguments.window_id` and a matching `verification_target.window_id`.
Refs are bound to the observed window and invalidated after input; this
prevents verifying the result in an unrelated foreground window.
Failed verification can trigger `screenshot_on_failure`, restricted to that
same window. Input is retried only if `safe_retries=1` is explicitly set and
the upstream declares `disposition.delivery=not_delivered` and
`disposition.retry=safe`; uncertain delivery is never replayed. Read-only screen
access also requires the unsafe-runtime permission. Review tool permissions
before enabling `all` upstream exposure.
After changing the exposed tools, reconnect/refresh the ChatGPT connector.

On Windows, installed npm shims resolve to native executables for MCP transport.
The browser preset prefers installed Google Chrome and stores its own persistent
profile in Local AppData (`ChatGPTLocalCoder/browser-profile`) rather than
using the user's ordinary Chrome profile. An optional end-to-end check is
`node scripts/test-vercel-mcp-live.mjs`; it uses a localhost fixture to verify
DOM interaction and MCP reconnect without modifying existing user apps.

The browser MCP process uses `--tools all` internally (not exposed directly
because `expose=meta_only`) to support `agent_browser_connect` for Electron.
The guarded `computer_act` interface allows CDP connection only to a
localhost port/endpoint and disallows session/namespace overrides.
Local Coder collects all paginated MCP tool-list pages with explicit bounds,
deduplication and a 60-second cache; the full browser provider currently
contains more than 100 tools, but only the native computer-use entrypoints
are advertised to ChatGPT.
The full-profile `mcp_call` fallback also enforces the upstream server's
`expose`/allowlist policy and local write/unsafe-runtime permission. It cannot
invoke hidden `meta_only` or disabled tools. Structured upstream failures are
reported as errors, not successful calls.

Additional optional Windows checks:
`node scripts/test-desktop-mcp-live.mjs` creates a disposable WinForms window,
verifies its control ref and a real click, then closes it.
`node scripts/test-electron-mcp-live.mjs` starts VS Code with a temporary,
separate profile and local CDP port, checks target discovery, snapshots and
reconnection, and cleans up. Both tests intentionally avoid existing user apps.

Vercel sources: [agent-desktop](https://github.com/vercel-labs/agent-desktop)
and [agent-browser](https://github.com/vercel-labs/agent-browser).

**Requirements:** [Node.js](https://nodejs.org) 22.22.2+, npm, Git (optional, for git tools/worktree isolation)

**Windows**

```powershell
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env          # edit WORKSPACE_PATH + MCP_TOKEN
npm install
.\start.ps1                  # builds only when source changed, restarts MCP + Admin UI + TUI, and supervises the OpenAI tunnel
```

**macOS / Linux**

```bash
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
cp .env.example .env
npm install

# Set your project root and an auth token
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # paste into MCP_TOKEN

npm start                    # prestart builds automatically, then starts MCP + Admin UI + TUI
```

> The `.ps1` scripts are **Windows-only**. On macOS/Linux use `npm start` and the shell tunnel commands below — everything else is cross-platform.

Server runs at `http://127.0.0.1:3000` — health check: `http://127.0.0.1:3000/health`

### Live terminal dashboard

Interactive launches use a clean alternate-screen TUI instead of scrolling request logs. **By default the TUI follows the current terminal width and height, including manual resizing**, rather than capping the dashboard at 44 rows or 160 columns. Color stays restrained to meaningful state accents. TUI v2 prioritizes **current work and project clarity**: active projects are automatically listed first, followed by connected-idle and offline projects; each row shows ChatGPT transport, active-tool, worker, and coding-loop counts. Active tools and workers include their project, worker liveness and last activity are visible, and a pinned Health footer surfaces conditions such as **CHAT TRANSPORT LOST · work continues**, stalled/silent workers, or tunnel degradation. The dashboard still keeps the latest completed tool calls plus CPU, RSS, heap, tunnel, and transport status. Narrow/tiny terminals fall back to compact resize-safe layouts; non-interactive/CI/redirected output automatically falls back to normal logs.

The desktop dashboard allocates more rows to active projects and workers when space permits, prioritizes stalled/silent jobs, and distinguishes background work from true idleness. External labels, tool output summaries, and diagnostic messages are sanitized before reaching the terminal; unchanged full-size frames are not needlessly cleared and redrawn.

The TUI is also an interactive operator console when both stdin and stdout are terminals. Press **1** for Overview, **2** for Workspaces, **3** for History, **4** for Workers, **5** for Logs, or **?** for the complete keyboard help. Use **Tab** to cycle views and arrows, J/K, Page Up/Down, or Home/End to navigate. On Workspaces, **S** switches active-first/recent/name sorting, **P** pins/unpins a saved project, and **X** unregisters an unused project after confirmation—**no files or Git worktrees are ever deleted**. History supports **E** (errors only). History and Logs support **C** to archive the current audit log and clear the visible feed after confirmation; the original log is preserved under the audit directory's \`.mcp-state/audit-archive\`. **R** refreshes the registry and saved history. Esc cancels, Q returns to Overview, and Ctrl+C retains its normal server shutdown semantics. Without an interactive stdin the TUI remains view-only; Admin UI and MCP tools remain available.

Set `LOCAL_CODER_TUI=off` to force traditional logs, or `LOCAL_CODER_TUI=on` to request the dashboard when stdout is a TTY. `LOCAL_CODER_TUI_HEIGHT=auto` (default) follows the entire terminal height. A numeric value such as `44` caps the dashboard height to 20–60 rows and attempts one initial terminal resize if the window is shorter; terminals may ignore this request. In auto mode the app does not change the window dimensions itself.

Set `WORKSPACE_PATH` to your project root (absolute path). With `MCP_TOKEN` set, the MCP endpoint becomes `/mcp/<token>` — that full path is what goes in the connector.

## 🔌 Connect ChatGPT

### 1. Enable Developer Mode

1. Open [ChatGPT](https://chatgpt.com) → **Settings** → **Apps & Connectors**
2. Under **Advanced**, enable **Developer mode**

### 2. Expose your server (pick one tunnel)

See [Tunnel options](#-tunnel-options) below. You need a **public HTTPS** URL pointing to your local server on port 3000.

### 3. Create a connector

1. **Settings** → **Connectors** → **Create**
2. Fill in:

| Field | Value |
|-------|-------|
| **Name** | `Local Coder` |
| **Description** | `Local coding-agent runtime for regular ChatGPT. Use inspect_project + agent_task for non-trivial work, apply_patch to edit, and verify_project to verify.` |
| **URL** | `https://<your-tunnel>/mcp/<MCP_TOKEN>` — see below |
| **Authentication** | None (the token is already in the URL) |

3. **Create** → verify tools appear in the list

**The URL must include your `MCP_TOKEN`.** With `MCP_TOKEN=abc123`, the connector URL is `https://<your-tunnel>/mcp/abc123`. Plain `/mcp` returns **404** by design, so a URL without the token fails. Leave `MCP_TOKEN` empty to disable auth and use plain `/mcp` — not recommended, since anyone who learns the tunnel URL gets a shell on your machine.

> Treat the connector URL like a password: it contains the token.

### 4. Use in chat — **must tag the connector**

Every message that should use local tools **must include the connector**. If you skip this, ChatGPT only uses built-in tools, may show *"Looking for available tools"*, then **"Error in message stream"** — with **no error in server logs** (the MCP server was never called).

**How to tag (pick one):**

1. **Before sending:** **New chat** → **+** (tools) → **More** → enable **Local Coder** (connector stays on for that chat).
2. **In the message:** type **`@`** and choose **Local Coder** (or your connector name) so it appears as a pill/chip above the input.

Then send your prompt. You should see tool permission prompts or MCP activity — not a dead stream with no server log.

Example prompts (after tagging):

- *"Read package.json and explain the dependencies"*
- *"Run npm test and fix any failures"*
- *"Find all TODO comments with grep and summarize"*

> **Tip:** After server updates or restarts → **Refresh** the connector and start a **new chat** (re-tag the connector).  
> **Avoid** clicking **"Always allow"** on permission popups — it can reset the MCP session. Configure permissions in **Settings → Apps** instead.

## 🌐 Tunnel options

### Option A — OpenAI Secure MCP Tunnel *(recommended)*

Stable tunnel ID — connector URL never changes.

```powershell
# First time only
.\openai-tunnel.ps1 -Init    # enter tunnel_id + Runtime API key from OpenAI Platform

# Every time after — one command
.\start.ps1                  # one visible window: Local Coder supervises tunnel-client itself
```

`-Force` is still accepted (`.\start.ps1 -Force`). `-Rebuild` forces TypeScript compilation and `-NoBuild` reuses the existing `dist` build. Use `.\start.ps1 -NoTunnel` only when you intentionally want the local server without the OpenAI tunnel.

Get credentials: [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)

In ChatGPT Connectors: **Connection type → Tunnel** → paste your `tunnel_…` ID.

> **macOS / Linux:** `openai-tunnel.ps1` is PowerShell and downloads the **Windows** build, so it does not work here. Grab the matching `tunnel-client` binary from [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases) and run it directly, or use one of the options below.

### Option B — Cloudflare Quick Tunnel

Free, but URL changes on every restart (update connector each time).

```powershell
# Windows — Terminal 1
.\start.ps1 -NoTunnel
# Terminal 2
.\tunnel.ps1    # copy https://….trycloudflare.com into connector URL
```

```bash
# macOS / Linux — Terminal 1
npm start
# Terminal 2
npm run tunnel  # cloudflared tunnel --url http://localhost:3000
```

Install cloudflared: `winget install Cloudflare.cloudflared` (Windows) · `brew install cloudflared` (macOS)

**Requires outbound port 7844** (TCP *and* UDP) to `*.argotunnel.com`. Many corporate/school/hotel networks block it, and `--protocol http2` does **not** help — it still uses 7844. Check with:

```bash
cloudflared tunnel --url http://localhost:3000 2>&1 | grep -E 'precheck|Registered'
```

If you see `TCP Connectivity … status=fail` and never `Registered tunnel connection`, the network is blocking it — use Option C.

### Option C — Pinggy *(works when Cloudflare is blocked)*

Pure SSH over port **443**, so it survives networks that block 7844. No install, no signup.

```bash
# Terminal 1
npm start

# Terminal 2
ssh -p 443 -R0:localhost:3000 a.pinggy.io
```

It prints two HTTPS URLs (`https://….free.pinggy.net` and `https://….run.pinggy-free.link`) — pick either and append `/mcp/<MCP_TOKEN>` for the connector.

Free sessions expire after **60 minutes** and the URL changes each time, so you re-paste the connector URL. A paid plan gives persistent URLs.

## 🧰 Tools

Native tools use structured JSON responses `{ ok, tool, summary, data }`. The source-of-truth catalog is `src/lib/tool-profile.ts`; `scripts/test-tool-profile.mjs` verifies it matches the native `server.registerTool()` declarations.

The default `slim` profile is intentionally optimized for regular ChatGPT: it currently exposes **40 high-value tools** while the `full` profile keeps all native tools. Redundant convenience/low-level tools hidden from `slim` remain available through `CHATGPT_TOOL_PROFILE=full`, Admin → **MCP Servers → Local tools**, or a `run_command` fallback. This keeps the default MCP discovery payload comfortably below the Phase 4 budget without removing local capability. The source-of-truth catalog is `src/lib/tool-profile.ts`.

### Agent production benchmark

Run the production benchmark/fault suite with:

```bash
npm run benchmark:agent
```

It starts isolated real MCP servers and checks the intended Codex-like workflow rather than only unit-level functions: compound repo inspection/read round trips, repository intelligence, verification-output compaction, durable `coding_loop` restart/resume, `context_capsule` recovery after a simulated lost ChatGPT/MCP session, fail → diagnose → repair → pass behavior, and malformed persistent-state resilience. Phase 4 guards the default profile at **≤50 slim tools**, **≤64 KiB `tools/list`**, **≤12,000 instruction characters**, and bounded high-level tool responses so future features cannot silently inflate ChatGPT context/transport cost.

Phase 5 adds a fault-focused efficiency suite:

```bash
npm run test:phase5
```

It covers concurrent idempotency, crash-resumable parallel batches, dirty-worktree mutation detection, ambiguous project aliases, verification-cache invalidation, cache coherency, runtime-identity side effects, ephemeral-state pruning, large-result handles, structured no-match errors, and runtime telemetry. These tests exist specifically to catch orchestration failures that can pass ordinary compile/unit checks.

Phase 6 adds reliability/isolation coverage:

```bash
npm run test:phase6
```

It verifies that fresh ChatGPT MCP transports do not inherit hidden shell cwd, explicit per-call project scope blocks accidental cross-project mutation, durable task/capsule state survives changing transport IDs, moved Git repos reconcile by remote identity, abandoned transactions preserve current files, automatic context checkpoints deduplicate unchanged state, and the integrated tunnel supervisor has safe disabled/unconfigured states.

> ChatGPT can create a **fresh MCP transport for individual tool calls**. A transport/session ID is therefore diagnostic metadata, not a durable chat/work owner. Project isolation is derived from explicit `path`, `workspace`, and `working_directory` arguments plus durable task/loop/transaction IDs.

### Onboarding *(call these first)*

| Tool | Description |
|------|-------------|
| `agent_status` | Permissions, workspace roots, runtime/schema identity, and `mode=doctor` memory/cache/recovery diagnostics |
| `project_context` | Reads AGENTS.md, README, CLAUDE.md, configs |

### Filesystem

| Tool | Description |
|------|-------------|
| `read_text_file` | Read source files (offset + limit) |
| `read_files` | Read up to 24 independent files/ranges in one bounded MCP call |
| `write_file` | Create or overwrite files |
| `edit_file` | Find-and-replace edits |
| `multi_edit` | Multiple edits in one file |
| `replace_regex` | Regex replace in file |
| `apply_patch` | Unified / Codex-style patches |
| `glob` | Find files by pattern (sorted by mtime) |
| `grep` | Search content (content / files / count modes) |
| `list_directory` | List folder contents |
| `directory_tree` | Recursive tree as JSON |
| `create_directory` | Create folders |
| `delete_file` / `delete_directory` | Remove files or dirs |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run bounded shell commands (`npm test`, builds, …). Supports optional idempotency/mutation tracking and transaction-aware shell edits |
| `run_commands_parallel` | Run independent commands concurrently in isolated shell processes; batches persist per-member completion so failed/incomplete members can be retried without rerunning successful siblings |
| `shell_status` / `shell_reset` | Transport-local shell state. ChatGPT calls do **not** share hidden cwd by default; use explicit `working_directory` |
| `start_process` | Long-running / background commands |
| `process_status` / `process_output` | Inspect live background jobs and logs; use their wait conditions instead of sleep/poll loops when waiting for exit or expected output |
| `process_history` | Persistent named operation history across MCP/server restarts; stale running jobs are reported as interrupted |
| `process_input` | Send piped stdin to prompts/REPLs (`append_newline`, optional EOF); not a full PTY |
| `stop_process` | Stop the background process tree (important for dev servers on Windows) |
| `pty` | Real PTY/ConPTY session for TUIs, debuggers, interactive installers, and terminal-native CLIs |

### Semantic + visual tools

| Tool | Description |
|------|-------------|
| `repo_intel` | High-level repository symbol search, references, and impact analysis. Uses LSP first and bounded lexical coverage/fallback |
| `lsp` | Hover, definition, references, document/workspace symbols, and diagnostics. TypeScript/JS + Python are bundled; clangd/rust-analyzer/gopls are detected when installed |
| `view_image` | Return a local PNG/JPEG/WEBP/GIF path as MCP image content for ChatGPT visual analysis |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_worktree` | List/add/remove/prune isolated local worktrees for parallel tasks |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch (local only) |
| `git_restore` | Restore tracked files to last commit |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and reset |

### Tool profiles

`CHATGPT_TOOL_PROFILE=slim` is the default for the ChatGPT app and advertises the core coding set. `CHATGPT_TOOL_PROFILE=full` advertises every native tool in the catalog. The Admin UI can force-enable or disable individual local tools without changing the base profile. Unknown/stale override names are filtered.

The default slim profile intentionally exposes high-value local development helpers while keeping more destructive/remote/redundant operations such as recursive directory deletion, Git reset/push/pull/checkout, raw binary writes, and low-level MCP calls opt-in.

### Agent task state

| Tool | Description |
|------|-------------|
| `agent_task` | Persist/resume a multi-step coding objective with structured `pending` / `in_progress` / `completed` / `blocked` / `skipped` plan steps |
| `inspect_project` | One-call repository reconnaissance: manifests, scripts, package manager, Git state, top-level layout, and language/file distribution |
| `verify_project` | Discover or run a deterministic bounded verification recipe and return compact pass/fail evidence. Successful-result caching is opt-in and keyed to Git/worktree state with a short TTL |
| `edit_transaction` | Begin a durable touched-file transaction, preview its aggregate diff, run verification, then accept or conflict-safe rollback |
| `coding_loop` | Durable Codex-like implementation loop: begin/resume/refresh/verify/finish/rollback/cleanup with bounded repair attempts and optional Git-worktree isolation |
| `coding_loop_status` | Read recent or specific persistent coding-loop state without requesting a mutating tool |

**Verified edit-loop safety:** When you begin a `coding_loop`, use its `transaction_id` for supported file edits (and provide `mutation_paths` for transaction-linked shell edits). Every such edit invalidates the prior verification. After `coding_loop(action=verify)` passes, `finish` checks fingerprints of the transaction's tracked files again; edits made afterward—including out-of-band modifications to those tracked files—require another verification, unless you explicitly opt into `allow_unverified=true`. `coding_loop_status` reports `verification_current` and any invalidation reason. Rollback also checks all baseline snapshot hashes before changing any workspace files, preventing partial restoration when a stored snapshot is missing or corrupt. **Only paths captured by the transaction are included in this protection**; unrelated edits must be reviewed separately.
| `context_capsule` | Save/resume a bounded semantic working summary plus current task/loop/transaction/Git/activity state across chat loss or reconnects |

The agent loop is deliberately split between **regular ChatGPT** and Local Coder: ChatGPT performs reasoning and decides the next action; Local Coder persists the objective/plan/progress, local operations, verification evidence, files, shell, Git, code intelligence, and a compact resumable working-context capsule. `agent_task` therefore adds durable coding-agent structure without starting another model or hidden subagent.

Large textual command/search results can be compacted into a durable result handle instead of being pushed through the MCP response in full. The returned handle can be read in bounded ranges, keeping ChatGPT context and tunnel payloads predictable. Mutating shell commands can also attach worktree-change evidence so transaction/recovery state reflects edits performed through PowerShell, Python, build scripts, or other command-line tools rather than only Local Coder's direct file-edit tools.

### ChatGPT context compaction / loss

Local Coder does **not** assume the ChatGPT host will automatically compact a long coding conversation. It also cannot inspect ChatGPT's hidden token counter or retrieve a lost private transcript. Instead, `context_capsule` uses two complementary layers:

- **automatic machine-state snapshots** at important task/loop/transaction boundaries and after a bounded tool-call/result-byte budget; these capture current Git/task/coding-loop/transaction/recent-tool state without model involvement;
- **semantic checkpoints** written by regular ChatGPT after important decisions or when Local Coder returns a `context_checkpoint_hint`; these keep the compact summary, decisions, findings, blockers, next steps, and important files that cannot be reconstructed reliably from machine state alone.

This cannot literally shrink an already-running ChatGPT conversation: MCP has no API to delete old host messages or inspect the exact hidden token budget. After several context-budget cycles (three by default), the hint sets `rollover_recommended=true`. At a safe boundary, checkpoint and continue in a fresh ChatGPT chat; the new chat resumes the capsule instead of rediscovering the project. That checkpoint-and-rollover path is Local Coder's application-level substitute for host auto-compaction.

When a chat is new, corrupted, or missing prior reasoning, ChatGPT should call `context_capsule(action="resume")` first and then reconcile the returned live state before doing more repository discovery. `remember()` remains for long-lived project facts; `context_capsule` is the short-lived resumable working handoff for the current task.

For a non-trivial task the intended flow is:

```text
inspect_project → agent_task(start/resume) → coding_loop(begin) → edit(transaction_id) → context_capsule(checkpoint) → coding_loop(verify) → repair/verify → finish or rollback
```

`coding_loop` does **not** run another AI model. Regular ChatGPT still reasons, chooses edits, and interprets failures; Local Coder supplies the durable state machine around it. Each loop owns one `edit_transaction`, records compact verification evidence, limits repair attempts, and can resume after an MCP/chat reconnect. A failed loop only receives more attempts through an explicit `resume` with an extended budget.

With `isolation=worktree`, the loop creates an isolated Git checkout, returns a branch/path handoff on completion, and never auto-merges into the source checkout. `cleanup` removes the worktree separately and leaves the branch for review. By default a dirty source checkout is rejected because uncommitted changes are not part of the new worktree.

`start_process` also accepts an optional label and `task_id`, allowing long builds/dev servers to appear as durable operations associated with the persistent task.

Projects can override the auto-discovered verification recipe with `.local-coder/verification.json`:

```json
{
  "version": 1,
  "quick": ["npm run build"],
  "full": [
    { "label": "build", "command": "npm run build", "timeout_seconds": 180 },
    { "label": "tests", "command": "npm test", "timeout_seconds": 600 }
  ]
}
```

### External delegation

| Tool | Description |
|------|-------------|
| `subagent` | Run/manage an explicitly configured external model-capable runner, with optional Git-worktree isolation. It does **not** reuse the parent ChatGPT subscription. |
| `delegate_status` | Detect supported Claude, Codex, Grok, and OpenCode CLIs without launching them. |

### Claude Code ↔ MCP mapping

| Claude Code | This server |
|-------------|-------------|
| `Read` | `read_text_file` |
| `Write` | `write_file` |
| `Edit` / `MultiEdit` | `edit_file` / `multi_edit` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `list_directory` |
| `Bash` | `run_command` |
| — | `apply_patch`, `git_*`, `project_context` |

## ⚙️ Configuration

Copy `.env.example` → `.env`:

```env
PORT=3000
HOST=127.0.0.1
MCP_TOKEN=                      # generate one — see below
WORKSPACE_PATH=C:\Users\You\projects\my-app     # macOS: /Users/you/projects/my-app
CHATGPT_AUTO_APPROVE=true
LOCAL_CODER_TUI=auto
SHELL_TIMEOUT=300
GIT_TIMEOUT_MS=300000
MCP_SESSION_RECOVERY=true
MCP_SHELL_PERSIST_CWD=0
MCP_JSON_RESPONSE=false
MCP_SSE_KEEPALIVE_MS=10000
ADMIN_PORT=3011

# OpenAI Secure Tunnel (optional)
OPENAI_TUNNEL_ID=
OPENAI_TUNNEL_API_KEY=
```

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_PATH` | `cwd` | **Your project root** (like `cd` before `claude`). Auto-loads `CLAUDE.md` / `AGENTS.md` into MCP instructions |
| `HOST` | `127.0.0.1` | Bind address. Keep as-is — `0.0.0.0` exposes the shell to your whole LAN |
| `MCP_TOKEN` | *(empty)* | Secret in the endpoint path: `/mcp/<token>`. Empty = **no auth**. Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `ADMIN_PORT` | `3001` | [Admin UI](#-admin-ui) port (localhost-only, always on). Change it if something else uses 3001 — Docker Desktop often does |
| `ADMIN_TOKEN` | *(empty)* | Bearer token for the Admin UI. Empty = loopback check only |
| `CHATGPT_AUTO_APPROVE` | `true` | Tool annotations to reduce ChatGPT popups |
| `LOCAL_CODER_TUI` | `auto` | `auto` uses the clean dashboard only in an interactive TTY; `off` keeps scrolling logs; `on` requests TUI when stdout is a TTY |
| `MCP_SESSION_RECOVERY` | `true` | Auto-recover stale sessions after restart |
| `MCP_SESSION_TTL_MS` | `7200000` | Idle live-session retention (2 hours by default). Expired session IDs can still be recovered on demand instead of being retained all day |
| `MCP_CLOSED_SESSION_TTL_MS` | `900000` | Closed-transport retention (15 minutes by default) before cleanup |
| `MCP_SESSION_MAX_RETAINED` | `32` | Hard cap on retained MCP session/server objects. Old closed/idle sessions are evicted first; stale IDs can still auto-recover on demand |
| `MCP_SHELL_PERSIST_CWD` | `false` | Persist shell cwd across transport recreation. Off by default because ChatGPT may create a fresh MCP transport per tool call; explicit `working_directory` is safer |
| `MCP_JSON_RESPONSE` | `false` | Keep `false` for SSE tool responses with heartbeat frames. Set `true` only as a compatibility fallback for clients that require one JSON response at the end |
| `MCP_SSE_KEEPALIVE_MS` | `10000` | SSE heartbeat interval for long MCP calls. The server clamps this to 1–60 seconds |
| `SHELL_TIMEOUT` | `300` | Default timeout for synchronous `run_command` / `run_commands_parallel` calls, clamped to 5–3600 seconds. Both support per-call overrides; prefer `start_process` for very long or continuous jobs |
| `GIT_TIMEOUT_MS` | `300000` | Default timeout for native Git tools, clamped to 5 seconds–10 minutes |
| `MCP_AGENT_TASK_STATE_DIR` | `.mcp-state/agent-tasks` | Durable regular-ChatGPT coding-task/plan state |
| `MCP_OPERATION_STATE_DIR` | `.mcp-state/operations` | Durable background-operation history and bounded output tails |
| `MCP_EDIT_TRANSACTION_STATE_DIR` | `.mcp-state/edit-transactions` | Durable transaction metadata and baseline snapshots for transaction-aware edits |
| `MCP_EDIT_TRANSACTION_MAX_FILE_BYTES` | `16777216` | Per-file baseline snapshot limit for edit transactions |
| `MCP_EDIT_TRANSACTION_MAX_TOTAL_BYTES` | `67108864` | Total baseline snapshot limit for one edit transaction |
| `MCP_CODING_LOOP_STATE_DIR` | `.mcp-state/coding-loops` | Durable coding-loop context, retry, phase, isolation, and verification-attempt state |
| `MCP_CONTEXT_CAPSULE_STATE_DIR` | `.mcp-state/context-capsules` | Durable bounded semantic + live machine-state handoff used when ChatGPT conversation context is lost |
| `MCP_CONTEXT_CAPSULE_TOOL_CALLS` | `12` | Tool-call budget between automatic machine-state snapshots; clamped to 4–100 |
| `MCP_CONTEXT_CAPSULE_RESULT_BYTES` | `65536` | Accumulated tool-result byte budget between automatic machine-state snapshots; clamped to 8 KiB–1 MiB |
| `MCP_CONTEXT_CAPSULE_ROLLOVER_CYCLES` | `3` | Consecutive context-budget cycles before Local Coder recommends a safe fresh-chat rollover; clamped to 2–20 |
| `MCP_CODING_LOOP_WORKTREE_ROOT` | OS temp directory | Optional root for `coding_loop isolation=worktree`; restricted profiles should choose a path inside an allowed root |
| `MCP_RESULT_STATE_DIR` | `.mcp-state/results` | Durable bounded storage for oversized textual tool output referenced by result handles |
| `MCP_PARALLEL_BATCH_STATE_DIR` | `.mcp-state/parallel-batches` | Crash-resumable per-member state for parallel command batches |
| `MCP_IDEMPOTENCY_STATE_DIR` | `.mcp-state/idempotency` | Persistence for idempotency keys used to avoid duplicate side effects on retried shell work |
| `MCP_PROJECT_REGISTRY_PATH` | `.mcp-state/projects.json` | Recent-project registry and aliases. Git remote identity reconciles moved repos; there is no process-global active project |
| `MCP_VERIFICATION_CACHE_STATE_DIR` | `.mcp-state/verification-cache` | Optional successful-verification cache storage |
| `MCP_VERIFICATION_CACHE_TTL_SECONDS` | `300` | Maximum age of a cached verification success; cache keys include Git HEAD and the dirty/untracked worktree state |
| `MCP_TEXT_CACHE_MAX_BYTES` | `33554432` | Total estimated heap budget for cached text-file contents (32 MiB); least-recently-used entries are evicted under pressure |
| `MCP_TEXT_CACHE_MAX_ENTRY_BYTES` | `2097152` | Maximum estimated heap retained by one cached text file (2 MiB); larger files are readable but are not retained |
| `MCP_TEXT_CACHE_MAX_ENTRIES` | `128` | Secondary entry-count ceiling for the in-memory text cache |
| `MCP_RUNTIME_IDENTITY_PATH` | workspace-scoped `.mcp-state/runtime-identities/<hash>.json` | Optional explicit override for the real server-run identity/schema record used to detect connector schema drift |
| `MCP_EPHEMERAL_STATE_RETENTION_DAYS` | `30` | Startup retention window for result/batch/idempotency/verification-cache records |
| `MCP_STALE_STATE_HOURS` | `24` | Age threshold used by `agent_status(mode="doctor")` when reporting stale resumable tasks/loops/transactions; Doctor never deletes them automatically |
| `PERMISSIONS_CONFIG` | `profiles/permissions.json` | Optional permission-profile file (`open`, `workspace`, `read_only`, or `custom`). Missing file defaults to `open` |

> Variables already set in your shell **win over `.env`** (`dotenv` does not override). If a change to `.env` seems ignored, check `env | grep WORKSPACE_PATH` first.

> The default `open` permission profile provides full local access (subject to OS ACLs). `WORKSPACE_PATH` sets the default cwd; restricted permission profiles can turn configured roots into an application-level boundary.

> Long tool calls use Streamable HTTP/SSE by default and emit heartbeat comment frames every 10 seconds. Long-running work should still prefer `start_process` plus `process_status(wait_for="exit")` / `process_output(wait_for=...)` instead of `Start-Sleep` polling or keeping one tool call open for minutes.

> Upstream MCP tools that explicitly advertise themselves as read-only remain usable under restrictive profiles. Mutating or annotation-unknown upstream calls are treated as **unsafe runtimes** and require `open` or an explicit `custom.allow_unsafe_runtimes=true` policy.

## 🖥️ Admin UI

A local web console ships with the server. It starts **automatically** with `npm start` (same process, separate port) — there is no separate command and no on/off switch.

```
http://127.0.0.1:3001/ui          # or your ADMIN_PORT
```

The exact URL is printed in the startup banner. Stopping the server stops the admin UI too (`Ctrl+C`, `.\stop.ps1`, or `pkill -f "dist/index.js"`).

| Tab | What it does |
|-----|--------------|
| **Overview** | Live ChatGPT tool calls plus active project/machine workspaces, persistent agent plan/progress, coding loops, context capsules, background operation history/liveness, edit transactions, tunnel health, runtime/schema identity, per-tool p50/p95/result-volume/repeat telemetry, PID/MCP transports/workers, and upstream health |
| **MCP Servers** | Enable/disable upstream MCP servers, test connections, inspect their tools |
| **Import** | Pull existing MCP config from Cursor / Claude Code / OpenCode |
| **Activity** | Live tool-call log from ChatGPT (SSE stream) |
| **Project** | Preview the exact MCP instructions injected into ChatGPT each session |
| **Settings** | Read **and write** `.env` |
| **Raw status** | Raw JSON status dump |

This is the **hub** side of the project: upstream MCP servers are proxied through this one connector, so ChatGPT reaches their tools without being wired up separately. Configure them in `MCP_UPSTREAM_CONFIG` (default `profiles/mcp-upstream.json`).

> ⚠️ **Never expose this port through a tunnel** — only tunnel port 3000. The admin API writes `.env`, so reaching it means being able to change `WORKSPACE_PATH` or switch `MCP_TOKEN` off. It is protected by a loopback-only guard plus the optional `ADMIN_TOKEN`; since it cannot be disabled, setting `ADMIN_TOKEN` is worthwhile.

## 🏗️ Architecture

```
src/
├── index.ts                 # Express + MCP session manager
├── server-factory.ts        # Tool registration
├── lib/
│   ├── mcp-session-manager.ts   # Session recovery, TTL
│   ├── agent-task-store.ts      # Persistent structured coding plan state
│   ├── operation-store.ts       # Persistent background-operation history
│   ├── edit-transaction-store.ts # Durable transaction baselines + rollback
│   ├── coding-loop-store.ts      # Persistent coding-loop phases, attempts, context + worktree handoff
│   ├── context-capsule-store.ts  # Bounded semantic + machine-state recovery snapshots
│   ├── repository-intelligence.ts # Symbol/reference/impact intelligence
│   ├── project-inspection.ts    # Compact repository reconnaissance
│   ├── verification.ts          # Verification recipes + output compaction
│   ├── patch.ts                 # apply_patch engine
│   └── persistent-shell.ts      # Stateful shell
└── tools/
    ├── filesystem.ts        # filesystem/search/edit + batch reads
    ├── shell.ts             # shell + durable background operations
    ├── git.ts               # Git + worktree tools
    ├── agent-task.ts        # persistent structured plan state
    ├── agent-runtime.ts     # inspect_project + verify_project
    ├── repository-intelligence.ts # repo_intel
    ├── edit-transaction.ts  # transactional edit lifecycle
    ├── coding-loop.ts       # resumable Codex-like execution loop around regular ChatGPT
    ├── context-capsule.ts   # compact checkpoint/resume for lost ChatGPT context
    └── context.ts           # agent_status, project_context
```

- **Transport:** MCP Streamable HTTP — `/mcp/<MCP_TOKEN>` and `/<MCP_TOKEN>` (or `/mcp` and `/` when `MCP_TOKEN` is empty)
- **Transport session:** Streamable-HTTP transport objects are bounded and recoverable when a client presents a stale transport ID. They are not treated as durable ChatGPT chat/work ownership.
- **Output:** Structured JSON from every tool

## 🧪 Development

```powershell
npm run build          # compile TypeScript
npm test               # patch + tool unit tests
npm run dev            # watch mode (tsx)
node scripts/test-mcp-session.mjs   # integration test (server must be running)
```

## 🔒 Security

The default `open` permission profile grants **full local access** through Local Coder — files, shell, Git, and configured runtimes. Only expose it through a tunnel you control. Never share your connector URL or tunnel API keys.

- Binds `127.0.0.1` only (`HOST`) — not reachable from your LAN. The tunnel connects to localhost, so it still works
- `MCP_TOKEN` guards the endpoint at `/mcp/<token>`; `/mcp` and `/` return 404. **Set it** — without it, anyone who learns your tunnel URL gets a shell
- The connector URL contains the token — treat it as a credential, and stop the tunnel when you are done
- Under the default `open` permission profile, `WORKSPACE_PATH` only sets the default cwd. Use `workspace`, `read_only`, or `custom` permission profiles when Local Coder itself should restrict paths/commands. This is application-level policy, not an OS sandbox
- The [Admin UI](#-admin-ui) is always running and can write `.env` — tunnel **only** port 3000, never `ADMIN_PORT`, and set `ADMIN_TOKEN`
- `.env` and secrets are gitignored
- Audit log: `.mcp-audit.log` (optional, configurable)
- Use on a trusted network / personal machine only

## 🩺 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Error in message stream"** right after *"Looking for tools"* — **no server log** | You did **not tag the connector**. New chat → **+** → **More** → enable connector, or type **`@Local Coder`** in the message. Then retry. |
| **Resource not found** on tool call | Refresh connector + new chat and ensure the latest build is running. Durable task/loop/capsule recovery uses explicit IDs/workspaces rather than assuming one stable MCP transport per chat. |
| **Connection failed** | Check `.\start.ps1` + tunnel are both running. URL must be HTTPS. |
| **Permission popup every call** | Settings → Apps → set connector to *Ask before important changes*. Don't use popup "Always allow". |
| **Tool blocked by OpenAI safety** | Not a server bug. Retry with `run_command` (response may include `run_command_fallback`). Affects `git_push`, `git_checkout`, `delete_directory` occasionally. |
| **`stream canceled`** in tunnel log | Server/tunnel restarted mid-session → refresh connector, new chat. |
| **Long tool-heavy turn looks frozen / tunnel log shows HTTP 413** | A tool result exceeded the secure tunnel body limit. Latest Local Coder rejects oversized results before transport; use `read_text_file` offset/limit, smaller base64 chunks, or a shallower tree/search. |
| **`JavaScript heap out of memory` after many hours/tool calls** | Run `agent_status(mode="doctor")` and inspect heap/cache pressure. Phase 5 bounds text/context caches and retained MCP/process/PTY/subagent/LSP state; on older builds restart after saving durable state, update, then re-test the long-run workload. |
| **Tunnel URL keeps changing** | Switch to OpenAI Secure Tunnel (`openai-tunnel.ps1`). |
| **Connector stuck "loading" forever when you click Create** | Make sure you are on the latest build (`npm run build`) — older builds deadlocked on the SSE stream and never answered `tools/list`. Also confirm the URL includes `/mcp/<MCP_TOKEN>`. |
| **404 on the connector URL** | You omitted the token. Use `https://<tunnel>/mcp/<MCP_TOKEN>`, not `/mcp`. |
| **cloudflared never prints "Registered tunnel connection"** | Network blocks port 7844. `--protocol http2` will not help (same port). Use Pinggy — Option C. |
| **`EADDRINUSE` on 3001 at startup** | Something else owns the admin port (often Docker Desktop). Set `ADMIN_PORT=3011`. |
| **`.env` changes seem ignored** | A shell variable of the same name overrides it. Check `env \| grep WORKSPACE_PATH`. |
| **`npm test` fails with `spawn bash ENOENT`** | Stale `.mcp-state` from a previous run. `rm -rf .mcp-state` and re-run. |
| **`.ps1` scripts do nothing on macOS** | They are Windows-only. Use `npm start` and the Option B/C shell commands. |
| **Access denied** | Wrong path or OS permissions on that file. |
| **git not found** | Install [Git](https://git-scm.com). |

See also [AGENTS.md](AGENTS.md) for agent onboarding and `apply_patch` format.

## 📚 References

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ChatGPT Apps SDK](https://developers.openai.com/apps-sdk)
- [OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)

## 📄 License

[MIT](LICENSE) — use freely, attribution appreciated.

## ⭐ Support

If this saves you time, **star the repo** — it helps others find it.