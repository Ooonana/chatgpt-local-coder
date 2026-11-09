# Local Coder upgrade — implementation checklist

Workspace: `C:\Users\7ryan\chatgpt-local-coder`
Persistent task: `8cb9b6c9-c71e-4938-9ee7-4267fed4cec7`
Last verified: 2026-11-09. QuackStudio and all other repositories excluded.

`[x]` means verified complete; `[ ]` means pending or partially implemented.
Use the persistent task's 33 finer-grained plan steps for detailed progress.

## P0 — Baseline and reliability
- [x] Review current code, Git history, and previous unfinished work.
- [x] Run existing tests and identify regressions.
- [ ] Fix stale task/loop status and recovery inconsistencies.
  - Done: distinguish saved plans, workers, and manually managed completed coding loops.
  - Remaining: broader recovery and interruption stress tests.

## P1 — Computer Use 2.0
- [x] Evaluate and integrate Vercel agent-desktop through native Windows MCP.
  - Installed 1.2.0; native launcher; live MCP handshake; app enumeration.
- [x] Add structured Windows UI inspection and actions.
  - Guarded `computer_observe` and `computer_act` passed real isolated WinForms
    accessibility, semantic click and same-window state verification.
- [x] Implement action verification, retries, and screenshot fallback.
  - Window-scoped expected text, real screenshot fallback, no uncertain replay.
  - One retry only when the upstream confirms not-delivered and retry=safe.

## P1 — Browser automation
- [x] Integrate agent-browser and Chrome CDP (version 0.41.2).
- [x] Add browser snapshots, navigation, and element interaction.
  - Verified on isolated localhost page with real Chrome and MCP.
- [x] Support persistent sessions and Electron apps.
  - Isolated Chrome profile and live VS Code Electron CDP targeting verified.
  - Electron accessibility snapshot and MCP reconnect passed with temporary
    VS Code profile; no modifications to the user's existing editor session.

## P1 — Agent Skills
- [x] Support standard SKILL.md and .agents/skills directories.
- [x] Implement skill discovery, loading, and on-demand reference files.
- [x] Add per-project and global skill controls.
  - Admin UI, versioned scope controls, restricted-path protection, regression tests.

## P2 — Agent orchestration
- [ ] Improve task recovery after disconnections.
  - Done: Phase 6 reconnection, process isolation, transaction rollback,
    stale-loop and parallel-batch recovery scenarios pass in the full suite.
  - Remaining: implement and validate further recovery fixes where evidenced.
- [ ] Improve concurrent tasks and worktree isolation.
- [ ] Reduce failed-step retries and redundant operations.

## P2 — Performance and interface
- [ ] Reduce tool response size and context usage.
  - Done: MCP tools/list pagination correctly discovers 156 agent-browser tools
    without exposing them to ChatGPT; bounded, deduplicated, cached discovery.
    Measured 157 ms cold / approximately 0 ms warm cache lookup on Windows;
    default ChatGPT profile still advertises only 42 native tools.
- [ ] Improve Admin UI and terminal dashboard.
  - Done: Admin UI computer-use preset and Skills management panels.
- [ ] Add clearer diagnostics, task progress, and logs.
  - Done: task versus worker execution-status diagnostics.

## P2 — Security
- [ ] Add per-tool permissions and sensitive-action confirmation.
  - Done: unsafe-runtime gating, explicit input opt-in, restricted command allowlist.
  - Remaining: actual host confirmation and provider-side permission verification.
- [ ] Improve logging, secrets protection, and computer-use safeguards.
  - Done: audit entries, browser protocol restrictions, snapshot verification.

## P3 — Final verification
- [ ] Run full regression and reconnect stress tests.
  - Done: updated full npm test (exit 0; Phase 6 27/27), MCP integration
    (exit 0), isolated live desktop, Chrome and Electron reconnect checks.
  - Remaining: end-to-end service restart and sustained connector stress.
  - Remaining: end-to-end service restart and extended stress scenarios.
- [x] Review changes, update documentation, and create local commits.
  - Source edits, README/AGENTS, tests and checklist committed locally (no push).
- [ ] Verify repository and runtime status before handoff.
  - Running MCP service still uses the previous build; restart and connector refresh required.

### Operation notes

Computer-use providers were installed globally and configured `enabled=true`
with `expose=meta_only` in the machine-specific
`profiles/mcp-upstream.json`. This file is intentionally separate from the source
commit. The browser uses `--tools all` internally to allow Electron CDP but
only the guarded two native computer-use tools are exposed by default.
The other seven existing provider entries were preserved.
Never mistake `agent_task.status=active` for autonomous execution.
Do not restart the running MCP service during a live ChatGPT connector session.
Do not push without explicit request.