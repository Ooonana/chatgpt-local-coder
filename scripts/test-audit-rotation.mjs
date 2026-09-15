import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-audit-"));
const logPath = path.join(tmp, "audit.log");
process.env.AUDIT_LOG_PATH = logPath;
process.env.AUDIT_LOG_MAX_BYTES = String(1024 * 1024);

const { audit, getAuditLogMaxBytes } = await import("../dist/lib/audit.js");
const { setActivityConsoleEnabled } = await import("../dist/lib/activity-log.js");
setActivityConsoleEnabled(false);

try {
  assert.equal(getAuditLogMaxBytes(), 1024 * 1024);
  const payload = "x".repeat(6_000);
  for (let i = 0; i < 320; i++) {
    await audit({
      tool: "rotation-test",
      action: "write",
      target: `/tmp/${i}`,
      status: "ok",
      details: { i, payload },
    });
  }

  const current = await fs.stat(logPath);
  const rotated = await fs.stat(`${logPath}.1`);
  assert.ok(current.size > 0 && current.size <= getAuditLogMaxBytes(), `current size ${current.size}`);
  assert.ok(rotated.size > 0 && rotated.size <= getAuditLogMaxBytes(), `rotated size ${rotated.size}`);

  const tail = await fs.readFile(logPath, "utf8");
  assert.match(tail, /rotation-test/);
  assert.match(tail, /truncated/);
  console.log("audit-rotation: ok");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
