import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

interface IdempotencyRecord<T> {
  version: 1;
  key: string;
  fingerprint: string;
  created_at: string;
  value: T;
}

const keyLocks = new Map<string, Promise<void>>();

export async function withIdempotencyKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  keyLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (keyLocks.get(key) === current) keyLocks.delete(key);
  }
}

function root(): string {
  return path.resolve(process.env.MCP_IDEMPOTENCY_STATE_DIR?.trim() || path.join(process.cwd(), ".mcp-state", "idempotency"));
}

function fileFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(root(), `${hash}.json`);
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function loadIdempotent<T>(key: string, fingerprint: string): Promise<T | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileFor(key), "utf-8")) as IdempotencyRecord<T>;
    if (parsed.fingerprint !== fingerprint) throw new Error(`Idempotency key ${key} was already used for a different request`);
    return parsed.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveIdempotent<T>(key: string, fingerprint: string, value: T): Promise<void> {
  await fs.mkdir(root(), { recursive: true });
  const record: IdempotencyRecord<T> = { version: 1, key, fingerprint, created_at: new Date().toISOString(), value };
  const target = fileFor(key);
  const temp = `${target}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(record), "utf-8");
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}
