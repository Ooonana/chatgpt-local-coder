import { createHash, randomUUID } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

const MAX_BYTES = positiveInt(process.env.AUTO_MEMORY_MAX_BYTES, 25_000);
const MAX_LINES = positiveInt(process.env.AUTO_MEMORY_MAX_LINES, 200);
const MEMORY_HEADER = "# Auto memory (cross-session notes)";
const memoryLocks = new Map<string, Promise<void>>();

function projectDir(workspaceRoot: string): string {
  const slug = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", slug);
}

function memoryPath(workspaceRoot: string): string {
  return path.join(projectDir(workspaceRoot), "MEMORY.md");
}

export async function loadAutoMemory(workspaceRoot: string): Promise<string | null> {
  try {
    const text = await fs.readFile(memoryPath(workspaceRoot), "utf-8");
    return boundedMemoryText(text).trim() || null;
  } catch {
    return null;
  }
}

export async function appendAutoMemory(workspaceRoot: string, note: string): Promise<string> {
  const dir = projectDir(workspaceRoot);
  const file = memoryPath(workspaceRoot);
  const previous = memoryLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  memoryLocks.set(file, current);
  await previous.catch(() => undefined);
  try {
    await fs.mkdir(dir, { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}`;
    const next = boundedMemoryText([existing.trimEnd(), line].filter(Boolean).join("\n"));
    const temp = `${file}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
    try {
      await fs.writeFile(temp, next, "utf-8");
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    return file;
  } finally {
    release();
    if (memoryLocks.get(file) === current) memoryLocks.delete(file);
  }
}

function boundedMemoryText(text: string): string {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const body = rawLines
    .filter((line, index) => !(index === 0 && line.trim() === MEMORY_HEADER))
    .filter((line) => line.trim().length > 0);
  const maxBodyLines = Math.max(1, MAX_LINES - 2);
  const kept = body.slice(-maxBodyLines);
  const render = () => `${MEMORY_HEADER}\n\n${kept.join("\n")}${kept.length ? "\n" : ""}`;
  while (kept.length > 1 && Buffer.byteLength(render(), "utf-8") > MAX_BYTES) kept.shift();
  let result = render();
  if (Buffer.byteLength(result, "utf-8") > MAX_BYTES) {
    // A single pathological note can exceed the total budget. Keep a valid
    // UTF-8 suffix rather than slicing raw bytes through a multibyte sequence.
    const latest = kept.at(-1) || "";
    let low = 0;
    let high = latest.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = `${MEMORY_HEADER}\n\n${latest.slice(-mid)}\n`;
      if (Buffer.byteLength(candidate, "utf-8") <= MAX_BYTES) low = mid;
      else high = mid - 1;
    }
    result = `${MEMORY_HEADER}\n\n${latest.slice(-low)}\n`;
  }
  return result;
}

export function formatAutoMemoryForInstructions(content: string | null): string {
  if (!content) return "";
  return ["## Auto memory (learned across sessions)", content].join("\n");
}