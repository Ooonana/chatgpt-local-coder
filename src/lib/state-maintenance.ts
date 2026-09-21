import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export interface StateMaintenanceReport {
  removed_files: number;
  removed_bytes: number;
  scanned_files: number;
  errors: string[];
  retention_days: number;
}

const DEFAULT_RETENTION_DAYS = 30;

function retentionDays(): number {
  const parsed = Number(process.env.MCP_EPHEMERAL_STATE_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(Math.max(Math.trunc(parsed), 1), 365);
}

function managedDirs(): Array<{ name: string; dir: string }> {
  const stateRoot = path.resolve(process.cwd(), ".mcp-state");
  return [
    { name: "results", dir: path.resolve(process.env.MCP_RESULT_STATE_DIR?.trim() || path.join(stateRoot, "results")) },
    { name: "parallel-batches", dir: path.resolve(process.env.MCP_PARALLEL_BATCH_STATE_DIR?.trim() || path.join(stateRoot, "parallel-batches")) },
    { name: "idempotency", dir: path.resolve(process.env.MCP_IDEMPOTENCY_STATE_DIR?.trim() || path.join(stateRoot, "idempotency")) },
    { name: "verification-cache", dir: path.resolve(process.env.MCP_VERIFICATION_CACHE_STATE_DIR?.trim() || path.join(stateRoot, "verification-cache")) },
  ];
}

export async function pruneEphemeralState(nowMs = Date.now()): Promise<StateMaintenanceReport> {
  const days = retentionDays();
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const report: StateMaintenanceReport = { removed_files: 0, removed_bytes: 0, scanned_files: 0, errors: [], retention_days: days };
  for (const { name, dir } of managedDirs()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      report.scanned_files++;
      const file = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= cutoff) continue;
        await fs.rm(file, { force: true });
        report.removed_files++;
        report.removed_bytes += stat.size;
      } catch (error) {
        report.errors.push(`${name}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return report;
}
