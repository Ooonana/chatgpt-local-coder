import fs from "node:fs/promises";
import { getAuditPath } from "./audit.js";
import { SLIM_CHATGPT_TOOLS } from "./tool-profile.js";

export interface PersistentAuditToolStat {
  tool: string;
  calls: number;
  runtime_errors: number;
  domain_failures: number;
  timeouts: number;
  total_result_bytes: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
}

export interface PersistentAuditWindow {
  days: number;
  calls: number;
  runtime_errors: number;
  domain_failures: number;
  timeouts: number;
  total_result_bytes: number;
  tools: PersistentAuditToolStat[];
  rare_slim_tools: string[];
}

export interface PersistentAuditMetrics {
  generated_at: string;
  source_files: number;
  malformed_lines: number;
  canonical_runtime_records: number;
  windows: {
    days_7: PersistentAuditWindow;
    days_30: PersistentAuditWindow;
  };
}

interface RuntimeRecord {
  time: number;
  tool: string;
  toolOk: boolean;
  domainOk: boolean | null;
  durationMs: number;
  resultBytes: number;
  timedOut: boolean;
}

const CACHE_TTL_MS = 60_000;
let cache: { key: string; at: number; value: PersistentAuditMetrics } | null = null;

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function existingAuditFiles(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const base = getAuditPath();
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const candidate of [base + ".1", base]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) out.push({ path: candidate, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return out;
}

function aggregate(records: RuntimeRecord[], days: number, nowMs: number): PersistentAuditWindow {
  const cutoff = nowMs - days * 86_400_000;
  const selected = records.filter((record) => record.time >= cutoff);
  const byTool = new Map<string, {
    calls: number;
    runtimeErrors: number;
    domainFailures: number;
    timeouts: number;
    totalResultBytes: number;
    durations: number[];
  }>();
  for (const record of selected) {
    const stat = byTool.get(record.tool) || {
      calls: 0,
      runtimeErrors: 0,
      domainFailures: 0,
      timeouts: 0,
      totalResultBytes: 0,
      durations: [],
    };
    stat.calls++;
    if (!record.toolOk) stat.runtimeErrors++;
    if (record.toolOk && record.domainOk === false) stat.domainFailures++;
    if (record.timedOut) stat.timeouts++;
    stat.totalResultBytes += record.resultBytes;
    stat.durations.push(record.durationMs);
    byTool.set(record.tool, stat);
  }
  const tools = [...byTool.entries()]
    .map(([tool, stat]) => ({
      tool,
      calls: stat.calls,
      runtime_errors: stat.runtimeErrors,
      domain_failures: stat.domainFailures,
      timeouts: stat.timeouts,
      total_result_bytes: stat.totalResultBytes,
      p50_duration_ms: percentile(stat.durations, 0.5),
      p95_duration_ms: percentile(stat.durations, 0.95),
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const rareSlimTools = [...SLIM_CHATGPT_TOOLS]
    .filter((tool) => (byTool.get(tool)?.calls || 0) <= 1)
    .sort();
  return {
    days,
    calls: selected.length,
    runtime_errors: selected.filter((record) => !record.toolOk).length,
    domain_failures: selected.filter((record) => record.toolOk && record.domainOk === false).length,
    timeouts: selected.filter((record) => record.timedOut).length,
    total_result_bytes: selected.reduce((sum, record) => sum + record.resultBytes, 0),
    tools,
    rare_slim_tools: rareSlimTools,
  };
}

export async function getPersistentAuditMetrics(): Promise<PersistentAuditMetrics> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const files = await existingAuditFiles();
  const key = files.map((file) => file.path + ":" + file.size + ":" + file.mtimeMs).join("|");
  if (cache && cache.key === key) {
    cache.at = Date.now();
    return cache.value;
  }

  const records: RuntimeRecord[] = [];
  let malformedLines = 0;
  for (const file of files) {
    const text = await fs.readFile(file.path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        malformedLines++;
        continue;
      }
      if (parsed.action !== "__runtime" || typeof parsed.tool !== "string") continue;
      const time = typeof parsed.time === "string" ? Date.parse(parsed.time) : Number.NaN;
      if (!Number.isFinite(time)) continue;
      const details = parsed.details && typeof parsed.details === "object"
        ? parsed.details as Record<string, unknown>
        : {};
      records.push({
        time,
        tool: parsed.tool,
        toolOk: details.tool_ok === true,
        domainOk: typeof details.domain_ok === "boolean" ? details.domain_ok : null,
        durationMs: typeof details.duration_ms === "number" ? Math.max(0, details.duration_ms) : 0,
        resultBytes: typeof details.result_bytes === "number" ? Math.max(0, details.result_bytes) : 0,
        timedOut: details.timed_out === true,
      });
    }
  }
  const nowMs = Date.now();
  const value: PersistentAuditMetrics = {
    generated_at: new Date(nowMs).toISOString(),
    source_files: files.length,
    malformed_lines: malformedLines,
    canonical_runtime_records: records.length,
    windows: {
      days_7: aggregate(records, 7, nowMs),
      days_30: aggregate(records, 30, nowMs),
    },
  };
  cache = { key, at: nowMs, value };
  return value;
}

export function resetPersistentAuditMetricsCacheForTests(): void {
  cache = null;
}