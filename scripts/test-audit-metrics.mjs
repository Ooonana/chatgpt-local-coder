import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-audit-metrics-"));
const logPath = path.join(tmp, "audit.log");
process.env.AUDIT_LOG_PATH = logPath;

const now = Date.now();
const rows = [
  {
    time: new Date(now - 60_000).toISOString(),
    tool: "run_command",
    action: "__runtime",
    status: "ok",
    details: { tool_ok: true, domain_ok: true, duration_ms: 100, result_bytes: 500 },
  },
  {
    time: new Date(now - 50_000).toISOString(),
    tool: "run_command",
    action: "__runtime",
    status: "ok",
    details: { tool_ok: true, domain_ok: false, duration_ms: 300, result_bytes: 200, timed_out: true },
  },
  {
    time: new Date(now - 40_000).toISOString(),
    tool: "grep",
    action: "__runtime",
    status: "error",
    details: { tool_ok: false, domain_ok: null, duration_ms: 50, result_bytes: 0 },
  },
  {
    time: new Date(now - 30_000).toISOString(),
    tool: "run_command",
    action: "execute",
    status: "error",
    details: { duration_ms: 9999 },
  },
];
await fs.writeFile(logPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

const { getPersistentAuditMetrics } = await import("../dist/lib/audit-metrics.js");
try {
  const metrics = await getPersistentAuditMetrics();
  assert.equal(metrics.canonical_runtime_records, 3);
  assert.equal(metrics.windows.days_7.calls, 3);
  assert.equal(metrics.windows.days_7.runtime_errors, 1);
  assert.equal(metrics.windows.days_7.domain_failures, 1);
  assert.equal(metrics.windows.days_7.timeouts, 1);
  const shell = metrics.windows.days_7.tools.find((item) => item.tool === "run_command");
  assert.ok(shell);
  assert.equal(shell.calls, 2);
  assert.equal(shell.domain_failures, 1);
  assert.equal(shell.total_result_bytes, 700);
  assert.equal(shell.p50_duration_ms, 100);
  assert.equal(shell.p95_duration_ms, 300);
  console.log("audit-metrics: ok");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}