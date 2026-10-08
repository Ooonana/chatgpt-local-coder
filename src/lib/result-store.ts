import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteText } from "./atomic-file.js";

const DEFAULT_INLINE_CHARS = 24_000;
const MAX_STORED_CHARS = 2_000_000;

function storeRoot(): string {
  const raw = process.env.MCP_RESULT_STATE_DIR?.trim();
  return path.resolve(raw || path.join(process.cwd(), ".mcp-state", "results"));
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid result handle");
  return id;
}

export interface StoredTextResult {
  handle: string;
  chars: number;
  sha256: string;
  truncated_at_store: boolean;
  created_at: string;
}

export async function storeTextResult(text: string, prefix = "result"): Promise<StoredTextResult> {
  const originalChars = text.length;
  const bounded = originalChars > MAX_STORED_CHARS ? text.slice(-MAX_STORED_CHARS) : text;
  const safePrefix = /^[a-zA-Z0-9_-]{1,40}$/.test(prefix) ? prefix : "result";
  const id = `${safePrefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const payload = {
    version: 1,
    id,
    created_at: new Date().toISOString(),
    original_chars: originalChars,
    truncated_at_store: bounded.length !== originalChars,
    sha256: createHash("sha256").update(text).digest("hex"),
    text: bounded,
  };
  await atomicWriteText(path.join(storeRoot(), `${id}.json`), JSON.stringify(payload));
  return {
    handle: id,
    chars: originalChars,
    sha256: payload.sha256,
    truncated_at_store: payload.truncated_at_store,
    created_at: payload.created_at,
  };
}

export async function readTextResult(handle: string, offset = 0, limit = 40_000): Promise<{
  handle: string;
  text: string;
  offset: number;
  next_offset: number | null;
  stored_chars: number;
  original_chars: number;
  truncated_at_store: boolean;
  sha256: string;
}> {
  const id = safeId(handle);
  const parsed = JSON.parse(await fs.readFile(path.join(storeRoot(), `${id}.json`), "utf-8")) as {
    id: string;
    text: string;
    original_chars: number;
    truncated_at_store: boolean;
    sha256: string;
  };
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 200_000);
  const text = parsed.text.slice(safeOffset, safeOffset + safeLimit);
  const next = safeOffset + text.length < parsed.text.length ? safeOffset + text.length : null;
  return {
    handle: id,
    text,
    offset: safeOffset,
    next_offset: next,
    stored_chars: parsed.text.length,
    original_chars: parsed.original_chars,
    truncated_at_store: parsed.truncated_at_store,
    sha256: parsed.sha256,
  };
}

export async function compactOrStoreText(text: string, options?: { inline_chars?: number; prefix?: string }) {
  const inlineChars = Math.min(Math.max(options?.inline_chars ?? DEFAULT_INLINE_CHARS, 1_000), 100_000);
  if (text.length <= inlineChars) {
    return { text, truncated: false, output_chars: text.length, output_handle: null as string | null };
  }
  const stored = await storeTextResult(text, options?.prefix || "result");
  return {
    text: text.slice(-inlineChars),
    truncated: true,
    output_chars: text.length,
    output_handle: stored.handle,
    output_sha256: stored.sha256,
    stored_truncated: stored.truncated_at_store,
  };
}
