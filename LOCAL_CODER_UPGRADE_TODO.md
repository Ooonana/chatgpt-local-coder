# Local Coder upgrade — implementation checklist

Workspace: `C:\Users\7ryan\chatgpt-local-coder`
Persistent task: `8cb9b6c9-c71e-4938-9ee7-4267fed4cec7`
Last verified: 2026-11-09 (mid-check after commit f189eea).
QuackStudio and all other repositories excluded.

`[x]` means verified complete. An unchecked item is explicitly tagged
**PARTIAL** or **PENDING**; a passing test does not close broader work.
The 23 top-level items here differ from the persistent task's 33 finer-grained
plan steps.

## Mid-check snapshot and priorities (2026-11-09)

- **Persistent task**: 21/33 complete (64%), with 12 steps in progress or
  pending. This saved plan does not execute autonomously.
- **High-level checklist**: 12/23 complete, 10 partial, 1 pending.
- **Mid-audit remediation**: 12/14 complete; historical reconciliation and
  live restart/connector stress are still open.
- **Repository**: f189eea on main, four commits ahead of fork/main at review;
  the machine-specific `profiles/mcp-upstream.json` is uncommitted and must
  be preserved.
- **Running MCP**: healthy, b025431 (schema 10), while the latest committed
  source declares schema 11. A connector refresh alone does not load new code.
- **Tests at this mid-check**: TypeScript build, Admin UI 7/7, recovery API
  including 12 concurrent project-isolated requests, npm production audit
  (0 advisories), and pnpm audit (0 advisories). Full `npm test` and
  `npm run test:integration` passed in the previous implementation turn,
  but were not repeated in this mid-check.

### Prioritized next tasks

1. **Safe with other projects active (P2.4/P2.5):** benchmark result bytes
   and latency; make measured reductions. Refine Admin UI/TUI recovery and
   operator-approval status using isolated test fixtures.
2. **Read-only only (P0.4/P2.2):** review Local Coder's own old plans and
   linked loops. Propose manual reconciliation; never finish, abandon,
   archive, rollback, delete, or update old records automatically.
   Other projects' state remains out of scope.
3. **Pending investigation (P2):** measure unnecessary retries, identify
   verifiably idempotent steps, and add failure-injection regressions.
4. **Defer to a maintenance window (P2.6/P3.2/P3.4):** live human Windows
   approval-dialog test, schema-11 service activation, connector refresh
   and sustained restart/reconnect stress. Do not interrupt active work.

Do not restart the server, push GitHub commits, touch other repositories,
alter the user's custom app picture, or modify machine-specific profiles
during this checklist-only review.

### P2.4 incremental efficiency result (2026-11-10)

- `project_context` now uses bounded file-handle prefix reads instead of
  whole-file reads; unchanged file metadata still permits repeat cache hits.
- Isolated 32 MiB fixture with a 1 KiB prefix: measured **1,024 bytes read**
  versus the previous full-file read of **33,554,432 bytes** (32,768× less
  cold-read I/O). This is not a latency or token-reduction estimate.
- `scripts/test-context-prefix.mjs` verifies the read budget, warm cache,
  same-sized file rewrites, empty files, and invalid limits. Integrated into
  the regular `npm test` path.
- Remaining: representative end-to-end tool-result bytes, context/token
  overhead and wall-clock latency baselines and optimizations. Keep the
  high-level performance item partial until those are measured.

## P0 — Baseline and reliability
- [x] Review current code, Git history, and previous unfinished work.
- [x] Run existing tests and identify regressions.
- [ ] **PARTIAL** Fix stale task/loop status and recovery inconsistencies.
  - Done: distinguish saved plans, workers, and manually managed completed coding loops.
  - Done: read-only project-specific review, reopened-step timestamp repair,
    cross-project mutation guards and Phase 6 regression coverage.
  - Remaining: manual reconciliation of historical state and live restart /
    interruption stress. Existing records intentionally remain untouched.

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
- [ ] **PARTIAL** Improve task recovery after disconnections.
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
- [ ] **PARTIAL** Improve concurrent tasks and worktree isolation.
  - Done: a confirmed cross-project task mutation gap was closed:
    project-bound sessions and explicit workspace selectors must match the
    task's stored project before modifying its state (Phase 6 regression).
  - Remaining: sustained concurrency and worktree-collision testing with
    disposable fixtures rather than live user projects.
- [ ] **PENDING** Reduce failed-step retries and redundant operations.
  - Next: quantify redundant attempts and add safe-retry tests. Never replay
    uncertain side effects without clear idempotency evidence.

## P2 — Performance and interface
- [ ] **PARTIAL** Reduce tool response size and context usage.
  - Done: MCP tools/list pagination correctly discovers 156 agent-browser tools
    without exposing them to ChatGPT; bounded, deduplicated, cached discovery.
    Measured 157 ms cold / approximately 0 ms warm cache lookup on Windows;
    default ChatGPT profile still advertises only 42 native tools.
  - Remaining: measure representative response sizes and latency, establish
    a baseline, then verify improvements against that baseline.
- [ ] **PARTIAL** Improve Admin UI and terminal dashboard.
  - Done: Admin UI computer-use preset and Skills management panels.
  - Done: Project-scoped, read-only recovery review panel and Admin API;
    it requires explicit workspace selection and never auto-scans other
    projects. Includes separate stale tasks, loops, transaction counts,
    suggested manual actions and incomplete-scan warnings.
  - Remaining: fuller TUI parity, approval policy/status and clearer saved
    plan versus running worker labeling.
- [ ] **PARTIAL** Add clearer diagnostics, task progress, and logs.
  - Done: task versus worker execution-status diagnostics.
  - Done: Admin recovery report displays status/links without exposing
    captured file paths or offering destructive lifecycle controls.
  - Remaining: review operator-facing logs and error recovery guidance after
    reconnects and failed tool calls.

## P2 — Security
- [ ] **PARTIAL** Add per-tool permissions and sensitive-action confirmation.
  - Done: unsafe-runtime gating, explicit input opt-in, restricted command allowlist.
  - Done: conservative write/unsafe-runtime restriction on direct MCP proxies,
    overriding untrusted upstream readOnlyHint annotations; default Windows
    operator approval for sensitive computer-use actions with scoped 90s leases.
  - Remaining: live human UI approval verification and confirmation policy UX;
    unrestricted shell access is outside the security boundary.
- [ ] **PARTIAL** Improve logging, secrets protection, and computer-use safeguards.
  - Done: audit entries, browser protocol restrictions, snapshot verification.
  - Remaining: more failure-oriented redaction testing and a live human test
    of the Windows approval prompt at an agreed maintenance window.

## P3 — Final verification
- [ ] **PARTIAL** Run full regression and reconnect stress tests.
  - Done: updated full npm test (exit 0; Phase 6 28/28), MCP integration
    (exit 0), isolated live desktop, Chrome and Electron reconnect checks.
  - Remaining: end-to-end service restart and sustained connector stress.
- [x] Review changes, update documentation, and create local commits.
  - Source edits, README/AGENTS, tests and checklist committed locally (no push).
- [ ] **PARTIAL** Verify repository and runtime status before handoff.
  - Running MCP service uses b025431 / schema 10; latest committed source
    f189eea declares schema 11. Controlled restart and connector refresh
    are required before the new Admin recovery panel is actually deployed.

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