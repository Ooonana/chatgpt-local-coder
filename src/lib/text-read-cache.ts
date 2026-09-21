import fs from "node:fs/promises";

interface CacheEntry {
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  retained_bytes: number;
  text: string;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

const MAX_ENTRIES = boundedInt(process.env.MCP_TEXT_CACHE_MAX_ENTRIES, 128, 8, 1024);
const MAX_TOTAL_BYTES = boundedInt(process.env.MCP_TEXT_CACHE_MAX_BYTES, 32 * 1024 * 1024, 4 * 1024 * 1024, 256 * 1024 * 1024);
const MAX_ENTRY_BYTES = Math.min(
  MAX_TOTAL_BYTES,
  boundedInt(process.env.MCP_TEXT_CACHE_MAX_ENTRY_BYTES, 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024)
);
const cache = new Map<string, CacheEntry>();
let retainedBytes = 0;

function estimatedRetainedBytes(size: number, text: string): number {
  // V8 may store strings as one-byte or two-byte sequences. Use the larger of
  // on-disk bytes and a conservative UTF-16 estimate so the cache budget is a
  // real heap guard rather than only a filesystem-size guard.
  return Math.max(size, text.length * 2);
}

function remove(key: string): void {
  const existing = cache.get(key);
  if (!existing) return;
  retainedBytes = Math.max(0, retainedBytes - existing.retained_bytes);
  cache.delete(key);
}

function touch(key: string, value: CacheEntry): void {
  remove(key);
  if (value.retained_bytes > MAX_ENTRY_BYTES || value.retained_bytes > MAX_TOTAL_BYTES) return;
  cache.set(key, value);
  retainedBytes += value.retained_bytes;
  while (cache.size > MAX_ENTRIES || retainedBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    remove(oldest);
  }
}

export async function readTextCached(file: string): Promise<{ text: string; cache_hit: boolean; size: number; mtime_ms: number; ctime_ms: number }> {
  const stat = await fs.stat(file);
  const existing = cache.get(file);
  if (existing && existing.size === stat.size && existing.mtime_ms === stat.mtimeMs && existing.ctime_ms === stat.ctimeMs) {
    touch(file, existing);
    return { text: existing.text, cache_hit: true, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs };
  }
  if (existing) remove(file);
  const text = await fs.readFile(file, "utf-8");
  const entry: CacheEntry = {
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    retained_bytes: estimatedRetainedBytes(stat.size, text),
    text,
  };
  touch(file, entry);
  return { text, cache_hit: false, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs };
}

export function getTextReadCacheStats() {
  return {
    entries: cache.size,
    retained_bytes: retainedBytes,
    max_entries: MAX_ENTRIES,
    max_total_bytes: MAX_TOTAL_BYTES,
    max_entry_bytes: MAX_ENTRY_BYTES,
  };
}

export function invalidateTextReadCache(file?: string): void {
  if (file) remove(file);
  else {
    cache.clear();
    retainedBytes = 0;
  }
}
