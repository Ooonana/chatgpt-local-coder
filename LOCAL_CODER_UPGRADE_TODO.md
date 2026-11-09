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
  - Done: `agent_task(action=review, workspace=...)` safely classifies stale
    plans, linked workers/loops, and old active edit transactions without
    changing records or other projects. Reports include link/scan diagnostics,
    never transaction snapshot contents.
  - Done: reopened task steps no longer retain a stale completion timestamp;
    historical records are normalized in memory without rewriting on read.
  - Done: linked transactions in isolated worktrees are included only when
    linked to a coding loop owned by the selected source project.
    Existing task mutations reject mismatched workspace/project-bound sessions.
  - Remaining: evaluate/manual reconcile actual historic records after evidence
    review; no automatic finishing or deletion of resumable states.
- [ ] Improve concurrent tasks and worktree isolation.
  - Done: a confirmed cross-project task mutation gap was closed:
    project-bound sessions and explicit workspace selectors must match the
    task's stored project before modifying its state (Phase 6 regression).
- [ ] Reduce failed-step retries and redundant operations.

## P2 — Performance and interface
- [ ] Reduce tool response size and context usage.
  - Done: MCP tools/list pagination correctly discovers 156 agent-browser tools
    without exposing them to ChatGPT; bounded, deduplicated, cached discovery.
    Measured 157 ms cold / approximately 0 ms warm cache lookup on Windows;
    default ChatGPT profile still advertises only 42 native tools.
- [ ] Improve Admin UI and terminal dashboard.
  - Done: Admin UI computer-use preset and Skills management panels.
  - Done: Project-scoped, read-only recovery review panel and Admin API;
    it requires explicit workspace selection and never auto-scans other
    projects. Includes separate stale tasks, loops, transaction counts,
    suggested manual actions and incomplete-scan warnings.
- [ ] Add clearer diagnostics, task progress, and logs.
  - Done: task versus worker execution-status diagnostics.
  - Done: Admin recovery report displays status/links without exposing
    captured file paths or offering destructive lifecycle controls.

## P2 — Security
- [ ] Add per-tool permissions and sensitive-action confirmation.
  - Done: unsafe-runtime gating, explicit input opt-in, restricted command allowlist.
  - Done: conservative write/unsafe-runtime restriction on direct MCP proxies,
    overriding untrusted upstream readOnlyHint annotations; default Windows
    operator approval for sensitive computer-use actions with scoped 90s leases.
  - Remaining: live human UI approval verification and confirmation policy UX;
    unrestricted shell access is outside the security boundary.
- [ ] Improve logging, secrets protection, and computer-use safeguards.
  - Done: audit entries, browser protocol restrictions, snapshot verification.

## P3 — Final verification
- [ ] Run full regression and reconnect stress tests.
  - Done: updated full npm test (exit 0; Phase 6 28/28), MCP integration
    (exit 0), isolated live desktop, Chrome and Electron reconnect checks.
  - Remaining: end-to-end service restart and sustained connector stress.
- [x] Review changes, update documentation, and create local commits.
  - Source edits, README/AGENTS, tests and checklist committed locally (no push).
- [ ] Verify repository and runtime status before handoff.
  - Running MCP service still uses an earlier build; latest source schema
    contract version is 10. Controlled restart and connector refresh required.

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

## Mid-audit remediation checklist (2026-11-09)

- [x] Close the full-profile `mcp_call` bypass of disabled, `none`,
  `meta_only` and per-tool allowlist restrictions.
- [x] Report upstream `structuredContent.ok=false`, nested errors and
  JSON-text failure results as failures instead of success.
- [x] Require writes to be enabled for generic mutating `mcp_call`.
- [x] Bind desktop `ref_id` actions to a recently observed window ID,
  rejecting mismatched or stale refs before any input; clear refs after input.
- [x] Verify same-window desktop clicks and screenshot fallback using a
  disposable WinForms fixture (no existing user apps touched).
- [x] Fix quoted/folded YAML skill frontmatter and limit skill file reads.
- [x] Replace whole-file Skills UI toggles with serialized single-name updates.
- [x] Apply compatible npm security updates (7 advisories to 0) and raise the
  minimum direct Zod version.
- [x] Synchronize the alternate pnpm lockfile, constrain the vulnerable
  transitive packages and fix its additional critical proxy-addr advisory.
  Both npm and pnpm audits now report zero known vulnerabilities.
- [x] Add an independent local Windows operator prompt for sensitive desktop/
  browser actions, with denial, timeouts, 90-second scope, and opt-out mode.
  Mock approval/denial tests pass; real human GUI confirmation is still untested.
- [ ] Implement scope-safe reconciliation of old tasks/loops/transactions;
  never purge unrelated projects or intentionally resumable records.
- [x] Add read-only workspace-scoped stale task review, plus task mutation
  project ownership checks and regression coverage.
- [x] Prevent malicious upstream readOnlyHint annotations from bypassing
  write/unsafe-runtime checks for directly exposed upstream tools.
- [ ] Stress-test service-level restart and ChatGPT connector refresh.

These repairs do not automatically complete the broader P0/P2/P3 roadmap.
Always recheck Git status and the persistent 33-step task after an increment.