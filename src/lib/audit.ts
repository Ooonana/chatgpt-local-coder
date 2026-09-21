import fs from "fs/promises";
import path from "path";
import { appendActivity } from "./activity-log.js";
import { boundDiagnosticValue } from "./bounded-value.js";
import { getRuntimeIdentity } from "./runtime-identity.js";

export type AuditStatus = "ok" | "error" | "blocked" | "dry-run";

export interface AuditEvent {
  tool: string;
  action: string;
  target?: string;
  status?: AuditStatus;
  details?: Record<string, unknown>;
}

const auditPath = process.env.AUDIT_LOG_PATH || path.resolve(process.cwd(), ".mcp-audit.log");
const AUDIT_LOG_MAX_BYTES = (() => {
  const parsed = Number(process.env.AUDIT_LOG_MAX_BYTES || 10 * 1024 * 1024);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10 * 1024 * 1024;
  return Math.min(Math.max(Math.trunc(parsed), 1024 * 1024), 100 * 1024 * 1024);
})();
let auditWriteQueue = Promise.resolve();

async function appendAuditLine(line: string): Promise<void> {
  const bytes = Buffer.byteLength(line, "utf8");
  try {
    const stat = await fs.stat(auditPath);
    if (stat.size + bytes > AUDIT_LOG_MAX_BYTES) {
      const rotated = `${auditPath}.1`;
      await fs.rm(rotated, { force: true }).catch(() => undefined);
      await fs.rename(auditPath, rotated);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, line, "utf-8");
}

export async function audit(event: AuditEvent): Promise<void> {
  const record = boundDiagnosticValue({
    time: new Date().toISOString(),
    pid: process.pid,
    run_id: getRuntimeIdentity().run_id,
    ...event,
  }, {
    maxStringChars: 4_000,
    maxArrayItems: 80,
    maxObjectKeys: 120,
    maxDepth: 6,
  });

  try {
    const line = JSON.stringify(record) + "\n";
    const write = auditWriteQueue.then(() => appendAuditLine(line));
    auditWriteQueue = write.catch(() => undefined);
    await write;
  } catch {
    // Audit must never break the requested tool call.
  }

  try {
    appendActivity({
      kind: "tool",
      tool: event.tool,
      action: event.action,
      target: event.target,
      status: event.status ?? "ok",
      summary: event.target || (event.details ? JSON.stringify(event.details).slice(0, 120) : undefined),
      details: event.details,
    });
  } catch {}
}

export function getAuditPath(): string {
  return auditPath;
}

export function getAuditLogMaxBytes(): number {
  return AUDIT_LOG_MAX_BYTES;
}
