const ENV_KEYS = [
  "WORKSPACE_PATH",
  "EXTRA_WORKSPACE_PATHS",
  "PORT",
  "ADMIN_PORT",
  "CHATGPT_AUTO_APPROVE",
  "CHATGPT_TOOL_PROFILE",
  "SHELL_TIMEOUT",
  "MCP_AGENT_TASK_STATE_DIR",
  "MCP_OPERATION_STATE_DIR",
  "MCP_EDIT_TRANSACTION_STATE_DIR",
  "MCP_CODING_LOOP_STATE_DIR",
  "MCP_CODING_LOOP_WORKTREE_ROOT",
  "MCP_SESSION_RECOVERY",
  "MCP_SESSION_DELETE_GRACE_MS",
  "MCP_JSON_RESPONSE",
  "MCP_SSE_KEEPALIVE_MS",
  "CHECKPOINT_ENABLED",
  "MCP_UPSTREAM_CONFIG",
  "POST_EDIT_HOOKS_CONFIG",
];

const TITLES = {
  dashboard: "Overview",
  servers: "MCP Servers",
  import: "Import",
  activity: "Activity",
  project: "Project context",
  settings: "Settings",
  logs: "Raw status",
};

const SOURCE_LABELS = {
  cursor: "Cursor",
  claude: "Claude Code",
  opencode: "OpenCode",
};

let upstreamConfig = { servers: [] };
let editingServerId = null;
let activityPollTimer = null;
let activityEventSource = null;
let activitySeenIds = new Set();
let activityPaused = false;
let dashboardRuntimeTimer = null;
let dashboardHealthCache = null;

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function badge(health) {
  if (health === "connected") return '<span class="badge ok">connected</span>';
  if (health === "disabled") return '<span class="badge off">disabled</span>';
  return `<span class="badge bad">${health || "unknown"}</span>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function lastRuntimeActivityMs(runtime) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const item of runtime?.active || []) latest = Math.max(latest, Number(item.started_ms) || 0);
  const recent = runtime?.recent?.[0]?.finished_at ? Date.parse(runtime.recent[0].finished_at) : Number.NaN;
  if (Number.isFinite(recent)) latest = Math.max(latest, recent);
  return Number.isFinite(latest) && latest > 0 ? latest : null;
}

function runtimeKind(kind) {
  const value = String(kind || "MCP").toLowerCase();
  return `<span class="runtime-kind ${esc(value)}">${esc(String(kind || "MCP"))}</span>`;
}

function renderRuntimeOverview(runtimeInfo) {
  const runtime = runtimeInfo.runtime || {};
  const now = Date.now();
  const active = Array.isArray(runtime.active) ? runtime.active : [];
  const recent = Array.isArray(runtime.recent) ? runtime.recent : [];
  const workers = [runtimeInfo.processes, runtimeInfo.ptys, runtimeInfo.subagents]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => item.running).length;
  const latest = lastRuntimeActivityMs(runtime);

  const lastTool = latest == null ? "Last tool —" : `Last tool ${formatElapsed(now - latest)} ago`;
  document.getElementById("overview-last-tool").textContent = lastTool;
  document.getElementById("overview-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
  document.getElementById("dash-active-count").textContent = String(active.length);
  const dot = document.getElementById("overview-dot");
  dot.className = `status-dot ${active.length ? "busy" : "online"}`;
  document.getElementById("overview-state").textContent = active.length ? "Working" : "Online";

  const activeStat = document.getElementById("stat-active-tools");
  const workerStat = document.getElementById("stat-workers");
  const callsStat = document.getElementById("stat-calls");
  const errorsStat = document.getElementById("stat-errors");
  if (activeStat) activeStat.textContent = String(active.length);
  if (workerStat) workerStat.textContent = String(workers);
  if (callsStat) callsStat.textContent = String(runtime.total_calls ?? 0);
  if (errorsStat) errorsStat.textContent = String(runtime.total_errors ?? 0);

  const activeEl = document.getElementById("dash-active");
  activeEl.innerHTML = active.length
    ? active.slice(0, 8).map((item) => `<div class="runtime-row">
        ${runtimeKind(item.kind)}
        <span class="runtime-tool" title="${esc(item.tool)}">${esc(item.tool)}</span>
        <span class="runtime-summary" title="${esc(item.summary)}">${esc(item.summary || "processing")}</span>
        <span class="runtime-time">${formatElapsed(now - item.started_ms)}</span>
      </div>`).join("")
    : '<div class="runtime-empty">Idle — waiting for ChatGPT tool calls.</div>';

  const recentEl = document.getElementById("dash-recent");
  recentEl.innerHTML = recent.length
    ? recent.slice(0, 8).map((item) => {
        const stateClass = item.status === "ok" ? "runtime-state-ok" : "runtime-state-error";
        const summary = item.status === "error" ? (item.error || item.summary) : item.summary;
        return `<div class="runtime-row">
          ${runtimeKind(item.kind)}
          <span class="runtime-tool ${stateClass}" title="${esc(item.tool)}">${esc(item.tool)}</span>
          <span class="runtime-summary" title="${esc(summary)}">${esc(summary || item.status)}</span>
          <span class="runtime-time">${formatElapsed(item.duration_ms)}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No completed tool calls in this server process yet.</div>';

  const tasks = Array.isArray(runtimeInfo.agent_tasks) ? runtimeInfo.agent_tasks : [];
  const resumable = tasks.filter((task) => task.status === "active" || task.status === "blocked");
  document.getElementById("dash-task-count").textContent = String(resumable.length);
  const taskEl = document.getElementById("dash-agent-task");
  taskEl.innerHTML = resumable.length
    ? resumable.slice(0, 4).map((task) => {
        const progress = task.progress || {};
        const step = progress.current_step || progress.next_step;
        const stateClass = task.status === "blocked" ? "runtime-state-error" : "runtime-state-ok";
        return `<div class="runtime-row agent-task-row">
          <span class="runtime-kind task">TASK</span>
          <span class="runtime-tool ${stateClass}" title="${esc(task.title)}">${esc(task.title)}</span>
          <span class="runtime-summary" title="${esc(step?.title || task.objective)}">${esc(step?.title || task.objective)}</span>
          <span class="runtime-time">${progress.percent ?? 0}%</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No active persistent agent task.</div>';

  const operations = Array.isArray(runtimeInfo.operations) ? runtimeInfo.operations : [];
  document.getElementById("dash-operation-count").textContent = String(operations.length);
  const operationsEl = document.getElementById("dash-operations");
  operationsEl.innerHTML = operations.length
    ? operations.slice(0, 8).map((operation) => {
        const status = operation.effective_status || operation.status || "unknown";
        const stateClass = ["completed", "running"].includes(status) ? "runtime-state-ok" : "runtime-state-error";
        const finished = operation.finished_at ? Date.parse(operation.finished_at) : Number.NaN;
        const started = Date.parse(operation.started_at || "");
        const duration = Number.isFinite(finished) && Number.isFinite(started)
          ? formatElapsed(finished - started)
          : Number.isFinite(started) ? formatElapsed(now - started) : "—";
        return `<div class="runtime-row operation-row">
          <span class="runtime-kind operation">${esc(status.toUpperCase().slice(0, 5))}</span>
          <span class="runtime-tool ${stateClass}" title="${esc(operation.command)}">${esc(operation.label || operation.id)}</span>
          <span class="runtime-summary" title="${esc(operation.command)}">${esc(operation.command)}</span>
          <span class="runtime-time">${duration}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No persistent background operations yet.</div>';

  const loops = Array.isArray(runtimeInfo.coding_loops) ? runtimeInfo.coding_loops : [];
  const activeLoops = loops.filter((loop) => loop.status === "active");
  document.getElementById("dash-loop-count").textContent = String(activeLoops.length);
  const loopsEl = document.getElementById("dash-loops");
  loopsEl.innerHTML = loops.length
    ? loops.slice(0, 8).map((loop) => {
        const status = loop.status || "unknown";
        const phase = loop.phase || status;
        const stateClass = ["active", "completed"].includes(status) ? "runtime-state-ok" : "runtime-state-error";
        const attempt = `${loop.attempts ?? 0}/${loop.max_attempts ?? 0}`;
        const mode = loop.isolation?.mode === "worktree" ? "worktree" : "main";
        const updated = Date.parse(loop.updated_at || "");
        const age = Number.isFinite(updated) ? `${formatElapsed(now - updated)} ago` : "—";
        const summary = `${phase} · attempt ${attempt} · ${mode}`;
        return `<div class="runtime-row loop-row">
          <span class="runtime-kind loop">LOOP</span>
          <span class="runtime-tool ${stateClass}" title="${esc(loop.id)}">${esc(loop.goal || loop.id)}</span>
          <span class="runtime-summary" title="${esc(summary)}">${esc(summary)}</span>
          <span class="runtime-time">${age}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No coding loops yet.</div>';

  const transactions = Array.isArray(runtimeInfo.edit_transactions) ? runtimeInfo.edit_transactions : [];
  const activeTransactions = transactions.filter((transaction) => transaction.status === "active");
  document.getElementById("dash-transaction-count").textContent = String(activeTransactions.length);
  const transactionsEl = document.getElementById("dash-transactions");
  transactionsEl.innerHTML = transactions.length
    ? transactions.slice(0, 8).map((transaction) => {
        const status = transaction.status || "unknown";
        const stateClass = status === "active" || status === "accepted" ? "runtime-state-ok" : "runtime-state-error";
        const verification = transaction.verification
          ? `verify ${transaction.verification.passed}/${transaction.verification.passed + transaction.verification.failed}`
          : "not verified";
        const updated = Date.parse(transaction.updated_at || "");
        const age = Number.isFinite(updated) ? `${formatElapsed(now - updated)} ago` : "—";
        const summary = `${transaction.files || 0} file(s), ${transaction.edits || 0} edit(s), ${verification}`;
        return `<div class="runtime-row transaction-row">
          <span class="runtime-kind transaction">${esc(status.toUpperCase().slice(0, 5))}</span>
          <span class="runtime-tool ${stateClass}" title="${esc(transaction.id)}">${esc(transaction.label || transaction.id)}</span>
          <span class="runtime-summary" title="${esc(summary)}">${esc(summary)}</span>
          <span class="runtime-time">${age}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No edit transactions yet.</div>';
}

function serversTable(rows, { actions = true } = {}) {
  const controls = actions ? '<div class="btn-group" style="margin-bottom:12px"><button class="btn ghost" data-action="computer-use">Computer Use</button><button class="btn ghost" data-action="permissions">Permissions</button><button class="btn ghost" data-action="local-hooks">Local hooks</button><button class="btn ghost" data-action="subagents">Subagents</button><button class="btn ghost" data-action="codex-hooks">Codex hooks</button><button class="btn ghost" data-action="local-tools">Local tools</button></div>' : '';
  if (!rows.length) return controls + '<div class="empty">No upstream servers configured. Add one or import a configuration.</div>';
  const head = `<table><thead><tr>
    <th>Server</th><th>Transport</th><th>Status</th><th>Expose</th><th>Tools</th>
    ${actions ? "<th></th>" : ""}
  </tr></thead><tbody>`;
  const body = rows
    .map((s) => {
      const actionsCell = actions
        ? `<td><div class="btn-group">
            <button class="btn sm ghost" data-action="test" data-id="${esc(s.id)}">Test</button>
            <button class="btn sm ghost" data-action="tools" data-id="${esc(s.id)}">Tools</button>
            ${s.transport === "http" && s.auth === "oauth" ? `<button class="btn sm ghost" data-action="oauth" data-id="${esc(s.id)}">OAuth</button>` : ""}
            <button class="btn sm ghost" data-action="edit" data-id="${esc(s.id)}">Edit</button>
            <button class="btn sm ghost" data-action="delete" data-id="${esc(s.id)}">Delete</button>
          </div></td>`
        : "";
      return `<tr>
        <td><strong>${esc(s.name)}</strong><div class="muted" style="font-size:0.72rem;font-family:var(--mono)">${esc(s.id)}</div></td>
        <td>${esc(s.transport)}</td>
        <td>${badge(s.health)}</td>
        <td>${esc(s.expose)}</td>
        <td>${s.tool_count ?? 0} <span class="muted">/ ${s.proxied_tools?.length ?? 0} proxy</span></td>
        ${actionsCell}
      </tr>`;
    })
    .join("");
  return controls + head + body + "</tbody></table>";
}

async function loadDashboard() {
  const [health, runtimeInfo] = await Promise.all([api("/health"), api("/api/runtime")]);
  dashboardHealthCache = health;
  const transport = health.transport_mode === "sse"
    ? `SSE · ${Math.round((health.sse_keepalive_ms || 0) / 1000)}s`
    : "JSON";
  const activeTools = runtimeInfo.runtime?.active?.length ?? 0;
  const workers = [runtimeInfo.processes, runtimeInfo.ptys, runtimeInfo.subagents]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => item.running).length;
  const policy = String(health.permission || "open").split(":", 1)[0];
  document.getElementById("conn-status").textContent = `MCP :${health.mcp_port} · ${transport} · ${health.active_sessions} sessions`;
  const instr = health.instructions || {};
  const memCount = instr.memory_files?.length ?? 0;
  const gitBranch = instr.git?.branch || (instr.git?.is_repo === false ? "—" : "?");
  document.getElementById("overview-transport").textContent = `${transport} · :${health.mcp_port}`;
  document.getElementById("stat-grid").innerHTML = `
    <div class="stat"><div class="stat-label">MCP Port</div><div class="stat-value">${health.mcp_port}</div></div>
    <div class="stat"><div class="stat-label">Transport</div><div class="stat-value">${esc(transport)}</div></div>
    <div class="stat"><div class="stat-label">Sessions</div><div class="stat-value">${health.active_sessions}</div></div>
    <div class="stat"><div class="stat-label">Active tools</div><div class="stat-value" id="stat-active-tools">${activeTools}</div></div>
    <div class="stat"><div class="stat-label">Workers</div><div class="stat-value" id="stat-workers">${workers}</div></div>
    <div class="stat"><div class="stat-label">Tool calls</div><div class="stat-value" id="stat-calls">${runtimeInfo.runtime?.total_calls ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Errors</div><div class="stat-value" id="stat-errors">${runtimeInfo.runtime?.total_errors ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Policy</div><div class="stat-value">${esc(policy)}</div></div>
    <div class="stat"><div class="stat-label">Project memory</div><div class="stat-value">${memCount} file(s)</div>
      <div class="stat-sub">${instr.instruction_bytes ? Math.round(instr.instruction_bytes / 1024) + " KB instructions" : ""}</div></div>
    <div class="stat"><div class="stat-label">Git branch</div><div class="stat-value" style="font-size:0.85rem">${esc(gitBranch)}</div></div>
    <div class="stat"><div class="stat-label">Workspace</div><div class="stat-value" style="font-size:0.85rem">${esc(health.default_cwd?.split(/[/\\]/).pop())}</div>
      <div class="stat-sub">${esc(health.default_cwd)}</div></div>`;
  document.getElementById("dash-servers").innerHTML = serversTable(health.upstream || [], { actions: false });
  document.getElementById("status-json").textContent = JSON.stringify(health, null, 2);
  renderRuntimeOverview(runtimeInfo);
}

async function refreshDashboardRuntime() {
  if (document.hidden || !document.getElementById("dashboard").classList.contains("active")) return;
  try {
    const runtimeInfo = await api("/api/runtime");
    renderRuntimeOverview(runtimeInfo);
    if (dashboardHealthCache) {
      document.getElementById("conn-status").textContent =
        `MCP :${dashboardHealthCache.mcp_port} · ${dashboardHealthCache.transport_mode?.toUpperCase()} · ${dashboardHealthCache.active_sessions} sessions`;
    }
  } catch {
    const dot = document.getElementById("overview-dot");
    dot.className = "status-dot error";
    document.getElementById("overview-state").textContent = "Disconnected";
  }
}

function startDashboardRuntimeLoop() {
  if (dashboardRuntimeTimer) return;
  dashboardRuntimeTimer = setInterval(() => refreshDashboardRuntime(), 1000);
}

function stopDashboardRuntimeLoop() {
  if (!dashboardRuntimeTimer) return;
  clearInterval(dashboardRuntimeTimer);
  dashboardRuntimeTimer = null;
}

async function loadProject() {
  const preview = await api("/api/instructions/preview");
  const s = preview.summary || {};
  document.getElementById("project-meta").innerHTML = `
    <div class="stat"><div class="stat-label">Root</div><div class="stat-value" style="font-size:0.8rem">${esc(s.root || "—")}</div></div>
    <div class="stat"><div class="stat-label">Memory files</div><div class="stat-value">${s.memory_files?.length ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Instructions</div><div class="stat-value">${preview.total_chars ? Math.round(preview.total_chars / 1024) + " KB" : "—"}</div></div>
    <div class="stat"><div class="stat-label">Tool profile</div><div class="stat-value">${esc(s.tool_profile || "slim")}</div></div>
    <div class="stat"><div class="stat-label">Git</div><div class="stat-value">${esc(s.git?.branch || "—")}</div></div>`;
  document.getElementById("project-preview").textContent =
    preview.preview + (preview.truncated ? "\n\n… (truncated)" : "");
}

async function loadServers() {
  const health = await api("/health");
  const cfg = await api("/api/upstream");
  upstreamConfig = cfg.config;
  const el = document.getElementById("servers-table");
  el.innerHTML = serversTable(health.upstream || []);
  bindServerActions(el, cfg.config);
}

function bindServerActions(container, config) {
  container.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        if (action === "test") {
          const r = await api(`/api/upstream/${id}/test`, { method: "POST" });
          toast(r.ok ? `OK — ${r.status.tool_count} tools` : r.status.last_error || "Failed", !r.ok);
          await loadServers();
        } else if (action === "computer-use") {
          await openComputerUseDialog();
        } else if (action === "permissions") {
          await openConfigEditor("permissions");
        } else if (action === "local-hooks") {
          await openConfigEditor("local-hooks");
        } else if (action === "subagents") {
          await openConfigEditor("subagents");
        } else if (action === "codex-hooks") {
          const r = await api("/api/codex-hooks");
          document.getElementById("codex-hooks-list").innerHTML = r.hooks.length
            ? r.hooks.map((hook) => `<label class="field checkbox"><input type="checkbox" data-codex-hook="${esc(hook.id)}" ${hook.enabled ? "checked" : ""} ${hook.supported ? "" : "disabled"} /><span><strong>${esc(hook.plugin)}</strong> · ${esc(hook.event)}${hook.supported ? "" : " <small class=\"muted\">This event is not available through MCP</small>"}<br /><small class="muted">${esc(hook.command)}</small></span></label>`).join("")
            : '<div class="muted">No enabled Codex hooks were found.</div>';
          document.getElementById("codex-hooks-dialog").showModal();
        } else if (action === "oauth") {
          const r = await api(`/api/upstream/${id}/oauth/start`, { method: "POST", body: JSON.stringify({ reset: true }) });
          if (!r.status?.authorization_url) throw new Error("OAuth server did not return an authorization URL");
          window.open(r.status.authorization_url, "_blank", "noopener");
          toast(`OAuth started for ${id}`);
        } else if (action === "tools") {
          const r = await api(`/api/upstream/${id}/tools`);
          const list = document.getElementById("tools-list");
          list.innerHTML = r.tools.length
            ? r.tools.map((t) => `<div class="tool-row"><div class="name">${esc(t.name)}</div><div class="desc">${esc(t.description || "")}</div></div>`).join("")
            : '<div class="muted">No tools available</div>';
          document.getElementById("tools-dialog").showModal();
        } else if (action === "edit") {
          openServerDialog(config.servers.find((x) => x.id === id));
        } else if (action === "delete") {
          if (!confirm(`Delete server "${id}"?`)) return;
          await api(`/api/upstream/${id}`, { method: "DELETE" });
          toast("Deleted");
          await loadServers();
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

async function loadImport() {
  const { sources } = await api("/api/import/sources");
  const grid = document.getElementById("import-grid");
  if (!sources.length) {
    grid.innerHTML = '<div class="empty">No MCP configuration files were found on this machine.</div>';
    return;
  }
  grid.innerHTML = sources
    .map(
      (s) => `<div class="import-card">
        <h3>${esc(SOURCE_LABELS[s.source] || s.source)}</h3>
        <div class="path">${esc(s.path)}</div>
        <div class="meta">${s.server_count} server(s)</div>
        <button class="btn primary sm" data-import="${esc(s.source)}" data-path="${esc(s.path)}">Import</button>
      </div>`
    )
    .join("");
  grid.querySelectorAll("[data-import]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const r = await api(`/api/import/${btn.dataset.import}`, {
          method: "POST",
          body: JSON.stringify({ path: btn.dataset.path, merge: true }),
        });
        toast(`Import OK: ${r.imported.join(", ") || "(no new servers)"}`);
        await refreshAll();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function activityKindBadge(kind) {
  const labels = { mcp: "MCP", tool: "TOOL", session: "SESSION", system: "SYS" };
  return `<span class="badge kind-${kind}">${labels[kind] || kind}</span>`;
}

function activityStatusBadge(status) {
  if (!status) return "";
  if (status === "ok") return '<span class="badge ok">ok</span>';
  if (status === "error" || status === "blocked") return `<span class="badge bad">${esc(status)}</span>`;
  return `<span class="badge">${esc(status)}</span>`;
}

function renderActivityRow(entry) {
  const tool = entry.tool || entry.action || "—";
  const summary = entry.summary || entry.target || "";
  const dur = entry.duration_ms != null ? `${entry.duration_ms}ms` : "";
  const sid = entry.session_id ? entry.session_id.slice(0, 8) : "";
  const details = entry.details ? JSON.stringify(entry.details, null, 2) : "";
  return `<div class="activity-row" data-id="${esc(entry.id)}">
    <div class="activity-main">
      <span class="activity-time">${formatTime(entry.time)}</span>
      ${activityKindBadge(entry.kind)}
      <span class="activity-tool">${esc(tool)}</span>
      ${activityStatusBadge(entry.status)}
      ${dur ? `<span class="activity-dur">${dur}</span>` : ""}
      ${sid ? `<span class="activity-sid" title="${esc(entry.session_id)}">${esc(sid)}</span>` : ""}
    </div>
    ${summary ? `<div class="activity-summary">${esc(summary)}</div>` : ""}
    ${details ? `<pre class="activity-details hidden">${esc(details)}</pre>` : ""}
  </div>`;
}

function bindActivityRows(container) {
  container.querySelectorAll(".activity-row").forEach((row) => {
    const details = row.querySelector(".activity-details");
    if (!details) return;
    row.addEventListener("click", () => details.classList.toggle("hidden"));
  });
}

function mergeActivityEntries(entries, { prepend = false } = {}) {
  const feed = document.getElementById("activity-feed");
  const empty = feed.querySelector(".empty");
  if (empty) empty.remove();

  const fresh = entries.filter((e) => !activitySeenIds.has(e.id));
  if (!fresh.length) return;

  for (const e of fresh) activitySeenIds.add(e.id);
  const html = fresh.map(renderActivityRow).join("");

  if (prepend) {
    feed.insertAdjacentHTML("afterbegin", html);
    bindActivityRows(feed);
    while (feed.children.length > 300) feed.lastElementChild?.remove();
    return;
  }

  feed.innerHTML = html + feed.innerHTML;
  bindActivityRows(feed);
  while (feed.children.length > 300) feed.lastElementChild?.remove();
}

async function loadActivity({ reset = false } = {}) {
  if (activityPaused && !reset) return;
  const kind = document.getElementById("activity-kind").value;
  const status = document.getElementById("activity-status").value;
  const q = document.getElementById("activity-search").value.trim();
  const params = new URLSearchParams({ limit: "120" });
  if (kind !== "all") params.set("kind", kind);
  if (status === "error") params.set("status", "error");
  if (q) params.set("q", q);

  const { entries } = await api(`/api/activity?${params}`);
  if (reset) {
    activitySeenIds.clear();
    const feed = document.getElementById("activity-feed");
    feed.innerHTML = entries.length
      ? entries.map(renderActivityRow).join("")
      : '<div class="empty">No activity matches the current filters.</div>';
    activitySeenIds = new Set(entries.map((e) => e.id));
    bindActivityRows(feed);
    return;
  }
  mergeActivityEntries(entries, { prepend: true });
}

function stopActivityStream() {
  if (activityPollTimer) {
    clearInterval(activityPollTimer);
    activityPollTimer = null;
  }
  if (activityEventSource) {
    activityEventSource.close();
    activityEventSource = null;
  }
}

function startActivityStream() {
  stopActivityStream();
  const live = document.getElementById("activity-live").checked;
  if (!live || activityPaused) return;

  activityEventSource = new EventSource("/api/activity/stream");
  activityEventSource.onmessage = (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      const kind = document.getElementById("activity-kind").value;
      const status = document.getElementById("activity-status").value;
      const q = document.getElementById("activity-search").value.trim().toLowerCase();
      if (kind !== "all" && entry.kind !== kind) return;
      if (status === "error" && entry.status !== "error" && entry.status !== "blocked") return;
      if (q) {
        const hay = [entry.tool, entry.action, entry.target, entry.summary].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return;
      }
      mergeActivityEntries([entry], { prepend: true });
    } catch {}
  };
  activityEventSource.onerror = () => {
    activityEventSource?.close();
    activityEventSource = null;
    if (!activityPollTimer) {
      activityPollTimer = setInterval(() => loadActivity().catch(() => {}), 2000);
    }
  };
}

function onActivityTabActive() {
  loadActivity({ reset: true }).catch((e) => toast(e.message, true));
  startActivityStream();
}

async function loadEnvForm() {
  const data = await api("/api/config/env");
  const form = document.getElementById("env-form");
  form.innerHTML = "";
  const values = data.values || {};
  for (const key of ENV_KEYS) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${key}</span>`;
    const input = document.createElement("input");
    input.name = key;
    input.value = values[key] ?? "";
    label.appendChild(input);
    form.appendChild(label);
  }
}

const dialog = document.getElementById("server-dialog");
const serverForm = document.getElementById("server-form");

function transportFields(form) {
  const t = form.transport.value;
  form.querySelectorAll(".stdio-field").forEach((el) => el.classList.toggle("hidden", t !== "stdio"));
  form.querySelectorAll(".http-field").forEach((el) => el.classList.toggle("hidden", t !== "http"));
}

serverForm.transport.addEventListener("change", () => transportFields(serverForm));

function openServerDialog(server) {
  editingServerId = server?.id ?? null;
  serverForm.reset();
  document.getElementById("dialog-title").textContent = server ? "Edit MCP Server" : "Add MCP Server";
  if (server) {
    serverForm.id.value = server.id;
    serverForm.id.readOnly = true;
    serverForm.name.value = server.name || "";
    serverForm.enabled.checked = server.enabled !== false;
    serverForm.transport.value = server.transport;
    serverForm.command.value = server.command || "";
    serverForm.args.value = JSON.stringify(server.args || []);
    serverForm.cwd.value = server.cwd || "";
    serverForm.url.value = server.url || "";
    serverForm.auth_type.value = server.auth?.type || (server.transport === "http" ? "auto" : "none");
    serverForm.oauth_scope.value = server.auth?.scope || "";
    serverForm.bearer_token_env_var.value = server.bearer_token_env_var || "";
    serverForm.headers.value = JSON.stringify(server.headers || {});
    serverForm.tool_prefix.value = server.tool_prefix || server.id;
    serverForm.expose.value = server.expose || "all";
    serverForm.tools.value = (server.tools || []).join(", ");
    serverForm.idle_timeout_sec.value = server.idle_timeout_sec ?? 600;
  } else {
    serverForm.id.readOnly = false;
  }
  transportFields(serverForm);
  dialog.showModal();
}

document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
document.getElementById("close-tools").addEventListener("click", () => document.getElementById("tools-dialog").close());

serverForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  let args = [];
  let headers = {};
  try {
    args = serverForm.args.value.trim() ? JSON.parse(serverForm.args.value) : [];
  } catch {
    return toast("Args must be a valid JSON array", true);
  }
  try {
    headers = serverForm.headers.value.trim() ? JSON.parse(serverForm.headers.value) : {};
    if (!headers || Array.isArray(headers)) throw new Error();
  } catch {
    return toast("Headers must be a valid JSON object", true);
  }
  const server = {
    id: serverForm.id.value.trim(),
    name: serverForm.name.value.trim() || serverForm.id.value.trim(),
    enabled: serverForm.enabled.checked,
    transport: serverForm.transport.value,
    command: serverForm.command.value.trim() || undefined,
    args,
    cwd: serverForm.cwd.value.trim() || undefined,
    url: serverForm.url.value.trim() || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    bearer_token_env_var: serverForm.bearer_token_env_var.value.trim() || undefined,
    auth: serverForm.transport.value === "http" ? {
      type: serverForm.auth_type.value || "auto",
      ...(serverForm.oauth_scope.value.trim() ? { scope: serverForm.oauth_scope.value.trim() } : {}),
    } : { type: "none" },
    tool_prefix: serverForm.tool_prefix.value.trim() || undefined,
    expose: serverForm.expose.value,
    tools: serverForm.tools.value.split(",").map((name) => name.trim()).filter(Boolean),
    idle_timeout_sec: Number(serverForm.idle_timeout_sec.value) || 600,
  };
  try {
    await api("/api/upstream", { method: "POST", body: JSON.stringify({ server }) });
    dialog.close();
    toast("Saved");
    await loadServers();
  } catch (err) {
    toast(err.message, true);
  }
});

async function openComputerUseDialog() {
  const r = await api("/api/plugins");
  document.getElementById("computer-use-enabled").checked = r.config.computer_use?.enabled === true;
  document.getElementById("computer-use-dialog").showModal();
}

document.getElementById("close-computer-use").addEventListener("click", () => {
  document.getElementById("computer-use-dialog").close();
});
document.getElementById("save-computer-use").addEventListener("click", async () => {
  const enabled = document.getElementById("computer-use-enabled").checked;
  await api("/api/plugins", { method: "PUT", body: JSON.stringify({ config: { computer_use: { enabled } } }) });
  document.getElementById("computer-use-dialog").close();
  toast(enabled ? "Computer Use enabled. Open a new MCP chat for the skill to appear." : "Computer Use disabled.");
});

const CONFIG_EDITORS = {
  permissions: { endpoint: "/api/permissions", dialog: "permissions-dialog", editor: "permissions-json" },
  "local-hooks": { endpoint: "/api/hooks", dialog: "local-hooks-dialog", editor: "local-hooks-json" },
  subagents: { endpoint: "/api/subagents", dialog: "subagents-dialog", editor: "subagents-json" },
};

async function openConfigEditor(kind) {
  const meta = CONFIG_EDITORS[kind];
  const data = await api(meta.endpoint);
  document.getElementById(meta.editor).value = JSON.stringify(data.config || {}, null, 2);
  if (kind === "subagents") {
    const keys = data.env_keys || [];
    document.getElementById("subagents-env-keys").textContent = keys.length
      ? `Configured environment keys (values hidden): ${keys.join(", ")}`
      : "No subagent environment keys are configured.";
  }
  document.getElementById(meta.dialog).showModal();
}

async function saveConfigEditor(kind) {
  const meta = CONFIG_EDITORS[kind];
  let config;
  try {
    config = JSON.parse(document.getElementById(meta.editor).value || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  const result = await api(meta.endpoint, { method: "PUT", body: JSON.stringify({ config }) });
  document.getElementById(meta.dialog).close();
  toast(`Saved ${kind}.`);
  return result;
}

for (const [kind, meta] of Object.entries(CONFIG_EDITORS)) {
  const closeId = `close-${kind}`;
  const saveId = `save-${kind}`;
  document.getElementById(closeId).addEventListener("click", () => document.getElementById(meta.dialog).close());
  document.getElementById(saveId).addEventListener("click", () => {
    saveConfigEditor(kind).catch((error) => toast(error.message, true));
  });
}

document.getElementById("close-codex-hooks").addEventListener("click", () => document.getElementById("codex-hooks-dialog").close());
document.getElementById("save-codex-hooks").addEventListener("click", async () => {
  const enabled = [...document.querySelectorAll("[data-codex-hook]:checked")].map((input) => input.dataset.codexHook);
  await api("/api/codex-hooks", { method: "PUT", body: JSON.stringify({ enabled }) });
  document.getElementById("codex-hooks-dialog").close();
  toast("Saved. SessionStart hook changes apply to new MCP chats.");
});

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    document.getElementById("page-title").textContent = TITLES[btn.dataset.tab] || btn.dataset.tab;
    stopActivityStream();
    stopDashboardRuntimeLoop();
    if (btn.dataset.tab === "dashboard") {
      refreshDashboardRuntime();
      startDashboardRuntimeLoop();
    }
    if (btn.dataset.tab === "activity") onActivityTabActive();
    if (btn.dataset.tab === "project") loadProject().catch((e) => toast(e.message, true));
  });
});

document.getElementById("activity-kind").addEventListener("change", () => loadActivity({ reset: true }).catch((e) => toast(e.message, true)));
document.getElementById("activity-status").addEventListener("change", () => loadActivity({ reset: true }).catch((e) => toast(e.message, true)));
document.getElementById("activity-search").addEventListener("input", () => {
  clearTimeout(activitySearchDebounce);
  activitySearchDebounce = setTimeout(() => loadActivity({ reset: true }).catch(() => {}), 350);
});
let activitySearchDebounce;
document.getElementById("activity-live").addEventListener("change", () => {
  activityPaused = false;
  if (document.getElementById("activity-live").checked) startActivityStream();
  else stopActivityStream();
});
document.getElementById("activity-clear").addEventListener("click", () => {
  activitySeenIds.clear();
  document.getElementById("activity-feed").innerHTML =
    '<div class="empty">View cleared. New activity will still appear while Live is enabled.</div>';
});

document.getElementById("add-server").addEventListener("click", () => openServerDialog(null));
document.getElementById("save-env").addEventListener("click", async () => {
  const values = {};
  document.querySelectorAll("#env-form input").forEach((el) => (values[el.name] = el.value));
  try {
    await api("/api/config/env", { method: "PUT", body: JSON.stringify({ values }) });
    toast("Saved .env");
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById("import-file-btn").addEventListener("click", async () => {
  const filePath = document.getElementById("import-file-path").value.trim();
  const source = document.getElementById("import-file-source").value;
  if (!filePath) return toast("Enter a file path", true);
  try {
    const r = await api("/api/import/file", {
      method: "POST",
      body: JSON.stringify({ path: filePath, detect_as: source, merge: true }),
    });
    toast(`Import OK: ${r.imported.join(", ") || "(no new servers)"}`);
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
});

async function refreshAll() {
  await Promise.all([loadDashboard(), loadServers(), loadImport(), loadEnvForm(), loadProject().catch(() => {})]);
}

document.getElementById("refresh-all").addEventListener("click", () => refreshAll().catch((e) => toast(e.message, true)));

refreshAll()
  .then(() => startDashboardRuntimeLoop())
  .catch((err) => toast(err.message, true));

async function openLocalTools() {
  const data = await api("/api/local-tools");
  const enabled = new Set(data.overrides?.enabled || []);
  const disabled = new Set(data.overrides?.disabled || []);
  document.getElementById("local-tools-list").innerHTML = data.tools.map((name) => `<label class="field checkbox"><input type="checkbox" data-tool-enable="${esc(name)}" ${enabled.has(name) ? "checked" : ""} /><span>${esc(name)} <small class="muted">force enable</small></span><input type="checkbox" data-tool-disable="${esc(name)}" ${disabled.has(name) ? "checked" : ""} /><span>disable</span></label>`).join("");
  document.getElementById("local-tools-dialog").showModal();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest('button[data-action="local-tools"]');
  if (button) openLocalTools().catch((err) => toast(err.message, true));
});

document.getElementById("close-local-tools").addEventListener("click", () => document.getElementById("local-tools-dialog").close());
document.getElementById("save-local-tools").addEventListener("click", async () => {
  const enabled = [...document.querySelectorAll("[data-tool-enable]:checked")].map((input) => input.dataset.toolEnable);
  const disabled = [...document.querySelectorAll("[data-tool-disable]:checked")].map((input) => input.dataset.toolDisable);
  await api("/api/local-tools", { method: "PUT", body: JSON.stringify({ overrides: { enabled, disabled } }) });
  document.getElementById("local-tools-dialog").close();
  toast("Saved. Open a new MCP chat to apply the changes.");
});
