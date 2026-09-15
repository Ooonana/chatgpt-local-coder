import fs from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { buildSimpleDiff } from "./patch.js";

export type EditTransactionStatus = "active" | "accepted" | "rolled_back";

export interface EditTransactionSnapshot {
  path: string;
  existed: boolean;
  size: number;
  mode?: number;
  baseline_sha256?: string;
  snapshot_file?: string;
  last_known_exists?: boolean;
  last_known_sha256?: string;
  last_known_size?: number;
}

export interface EditTransactionRecord {
  version: 1;
  id: string;
  label?: string;
  workspace: string;
  status: EditTransactionStatus;
  created_at: string;
  updated_at: string;
  accepted_at?: string;
  rolled_back_at?: string;
  snapshots: EditTransactionSnapshot[];
  edits: Array<{
    at: string;
    tool: string;
    paths: string[];
    checkpoint_id?: string | null;
  }>;
  verification?: {
    at: string;
    preset: string;
    passed: number;
    failed: number;
    duration_ms: number;
    results: Array<{
      label: string;
      command: string;
      exit_code: number;
      timed_out: boolean;
      excerpt: string;
    }>;
  };
}

const MAX_TRANSACTION_FILES = 128;
const MAX_TRANSACTION_EDITS = 200;
const MAX_TRANSACTION_RECORDS = 500;
const MAX_PREVIEW_DIFF_CHARS = 80_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const transactionLocks = new Map<string, Promise<void>>();

export async function withEditTransactionLock<T>(
  id: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (!id) return work();

  const previous = transactionLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  transactionLocks.set(id, current);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (transactionLocks.get(id) === current) transactionLocks.delete(id);
  }
}

function positiveIntFromEnv(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), max);
}

function maxFileBytes(): number {
  return positiveIntFromEnv("MCP_EDIT_TRANSACTION_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES, 128 * 1024 * 1024);
}

function maxTotalBytes(): number {
  return positiveIntFromEnv("MCP_EDIT_TRANSACTION_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES, 512 * 1024 * 1024);
}

function storeRoot(): string {
  const configured = process.env.MCP_EDIT_TRANSACTION_STATE_DIR;
  return path.resolve(configured || path.join(process.cwd(), ".mcp-state", "edit-transactions"));
}

function assertTransactionId(id: string): void {
  if (!/^tx_[0-9a-f]{14}$/i.test(id)) throw new Error(`Invalid edit transaction id: ${id}`);
}

function recordPath(id: string): string {
  assertTransactionId(id);
  return path.join(storeRoot(), `${id}.json`);
}

function payloadDir(id: string): string {
  assertTransactionId(id);
  return path.join(storeRoot(), id);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function canonicalizePotentialPath(inputPath: string): Promise<string> {
  let cursor = path.resolve(inputPath);
  const missing: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(inputPath);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertTransactionPathInsideWorkspace(workspace: string, filePath: string): Promise<void> {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedFile = path.resolve(filePath);
  if (!isInside(resolvedWorkspace, resolvedFile)) {
    throw new Error(`Transaction path is outside workspace: ${resolvedFile}`);
  }
  const [canonicalWorkspace, canonicalFile] = await Promise.all([
    canonicalizePotentialPath(resolvedWorkspace),
    canonicalizePotentialPath(resolvedFile),
  ]);
  if (!isInside(canonicalWorkspace, canonicalFile)) {
    throw new Error(`Transaction path escapes workspace through a symlink/junction: ${resolvedFile} -> ${canonicalFile}`);
  }
}

async function ensureStore(): Promise<void> {
  await fs.mkdir(storeRoot(), { recursive: true });
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

async function sha256File(filePath: string): Promise<{ exists: boolean; sha256?: string; size: number; mode?: number }> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Transaction path is not a regular file: ${filePath}`);
    const buffer = await fs.readFile(filePath);
    return {
      exists: true,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.length,
      mode: stat.mode,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, size: 0 };
    throw error;
  }
}

async function readRecord(id: string): Promise<EditTransactionRecord> {
  assertTransactionId(id);
  try {
    const parsed = JSON.parse(await fs.readFile(recordPath(id), "utf-8")) as EditTransactionRecord;
    if (parsed?.version !== 1 || parsed.id !== id) throw new Error("invalid transaction record");
    if (!Array.isArray(parsed.snapshots) || !Array.isArray(parsed.edits) || typeof parsed.workspace !== "string") {
      throw new Error("invalid transaction record structure");
    }
    const workspace = path.resolve(parsed.workspace);
    for (const snapshot of parsed.snapshots) {
      if (!snapshot || typeof snapshot.path !== "string" || !isInside(workspace, path.resolve(snapshot.path))) {
        throw new Error(`invalid transaction snapshot path: ${String(snapshot?.path)}`);
      }
      if (snapshot.snapshot_file) {
        const payloadRoot = path.resolve(payloadDir(id));
        const snapshotFile = path.resolve(snapshot.snapshot_file);
        if (!isInside(payloadRoot, snapshotFile)) {
          throw new Error(`invalid transaction snapshot payload path: ${snapshot.snapshot_file}`);
        }
        const [canonicalPayloadRoot, canonicalSnapshotFile] = await Promise.all([
          canonicalizePotentialPath(payloadRoot),
          canonicalizePotentialPath(snapshotFile),
        ]);
        if (!isInside(canonicalPayloadRoot, canonicalSnapshotFile)) {
          throw new Error(`transaction snapshot payload escapes payload directory through a symlink/junction: ${snapshot.snapshot_file}`);
        }
      }
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown edit transaction: ${id}`);
    throw error;
  }
}

async function saveRecord(record: EditTransactionRecord): Promise<void> {
  record.updated_at = nowIso();
  await atomicWriteJson(recordPath(record.id), record);
}

function assertActive(record: EditTransactionRecord): void {
  if (record.status !== "active") throw new Error(`Edit transaction ${record.id} is ${record.status}, not active`);
}

function snapshotIndex(record: EditTransactionRecord, filePath: string): number {
  const key = pathKey(filePath);
  return record.snapshots.findIndex((snapshot) => pathKey(snapshot.path) === key);
}

async function cleanupPayload(record: EditTransactionRecord): Promise<void> {
  await fs.rm(payloadDir(record.id), { recursive: true, force: true });
  for (const snapshot of record.snapshots) delete snapshot.snapshot_file;
}

export function getEditTransactionConfig(): Record<string, unknown> {
  return {
    state_dir: storeRoot(),
    max_files: MAX_TRANSACTION_FILES,
    max_file_bytes: maxFileBytes(),
    max_total_bytes: maxTotalBytes(),
    rollback_conflict_detection: true,
  };
}

export async function beginEditTransaction(workspace: string, label?: string): Promise<EditTransactionRecord> {
  await ensureStore();
  const id = `tx_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const created = nowIso();
  const record: EditTransactionRecord = {
    version: 1,
    id,
    label: label?.trim() || undefined,
    workspace: path.resolve(workspace),
    status: "active",
    created_at: created,
    updated_at: created,
    snapshots: [],
    edits: [],
  };
  await saveRecord(record);
  await pruneEditTransactions();
  return record;
}

export async function getEditTransaction(id: string): Promise<EditTransactionRecord> {
  return readRecord(id);
}

export async function listEditTransactions(limit = 20): Promise<EditTransactionRecord[]> {
  await ensureStore();
  const entries = await fs.readdir(storeRoot(), { withFileTypes: true });
  const records: EditTransactionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(storeRoot(), entry.name), "utf-8")) as EditTransactionRecord;
      if (record?.version === 1 && record.id) records.push(record);
    } catch {}
  }
  return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.max(1, limit));
}

async function pruneEditTransactions(): Promise<void> {
  await ensureStore();
  const entries = await fs.readdir(storeRoot(), { withFileTypes: true });
  const records: EditTransactionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const id = entry.name.slice(0, -5);
      if (!/^tx_[0-9a-f]{14}$/i.test(id)) continue;
      records.push(await readRecord(id));
    } catch {}
  }
  if (records.length <= MAX_TRANSACTION_RECORDS) return;
  const terminal = records
    .filter((record) => record.status !== "active")
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  let removeCount = records.length - MAX_TRANSACTION_RECORDS;
  for (const record of terminal) {
    if (removeCount <= 0) break;
    await fs.rm(recordPath(record.id), { force: true });
    await fs.rm(payloadDir(record.id), { recursive: true, force: true });
    removeCount--;
  }
}

export async function captureTransactionPaths(id: string, paths: string[]): Promise<EditTransactionRecord> {
  const record = await readRecord(id);
  assertActive(record);
  const unique = [...new Map(paths.map((item) => {
    const resolved = path.resolve(item);
    return [pathKey(resolved), resolved] as const;
  })).values()];
  for (const filePath of unique) {
    await assertTransactionPathInsideWorkspace(record.workspace, filePath);
  }

  let totalBytes = record.snapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);
  for (const filePath of unique) {
    if (snapshotIndex(record, filePath) >= 0) continue;
    if (record.snapshots.length >= MAX_TRANSACTION_FILES) {
      throw new Error(`Transaction file limit exceeded (${MAX_TRANSACTION_FILES})`);
    }
    const fingerprint = await sha256File(filePath);
    if (fingerprint.size > maxFileBytes()) {
      throw new Error(`File exceeds transaction snapshot limit: ${filePath} (${fingerprint.size} bytes)`);
    }
    if (totalBytes + fingerprint.size > maxTotalBytes()) {
      throw new Error(`Transaction snapshot total-byte limit exceeded (${maxTotalBytes()} bytes)`);
    }

    const snapshot: EditTransactionSnapshot = {
      path: filePath,
      existed: fingerprint.exists,
      size: fingerprint.size,
      mode: fingerprint.mode,
      baseline_sha256: fingerprint.sha256,
      last_known_exists: fingerprint.exists,
      last_known_sha256: fingerprint.sha256,
      last_known_size: fingerprint.size,
    };
    if (fingerprint.exists) {
      const index = record.snapshots.length;
      const snapshotFile = path.join(payloadDir(record.id), `${String(index).padStart(4, "0")}.bin`);
      await fs.mkdir(path.dirname(snapshotFile), { recursive: true });
      await fs.copyFile(filePath, snapshotFile);
      snapshot.snapshot_file = snapshotFile;
    }
    record.snapshots.push(snapshot);
    totalBytes += fingerprint.size;
  }
  await saveRecord(record);
  return record;
}

export async function recordTransactionEdit(
  id: string,
  tool: string,
  paths: string[],
  checkpointId?: string | null
): Promise<EditTransactionRecord> {
  const record = await readRecord(id);
  assertActive(record);
  const unique = [...new Map(paths.map((item) => {
    const resolved = path.resolve(item);
    return [pathKey(resolved), resolved] as const;
  })).values()];
  for (const filePath of unique) {
    await assertTransactionPathInsideWorkspace(record.workspace, filePath);
    const index = snapshotIndex(record, filePath);
    if (index < 0) throw new Error(`Transaction path was not captured before edit: ${filePath}`);
    const current = await sha256File(filePath);
    record.snapshots[index].last_known_exists = current.exists;
    record.snapshots[index].last_known_sha256 = current.sha256;
    record.snapshots[index].last_known_size = current.size;
  }
  record.edits.push({ at: nowIso(), tool, paths: unique, checkpoint_id: checkpointId });
  if (record.edits.length > MAX_TRANSACTION_EDITS) record.edits.splice(0, record.edits.length - MAX_TRANSACTION_EDITS);
  await saveRecord(record);
  return record;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

export async function previewEditTransaction(id: string): Promise<{
  transaction: EditTransactionRecord;
  files: Array<{
    path: string;
    status: "unchanged" | "modified" | "created" | "deleted";
    baseline_bytes: number;
    current_bytes: number;
    diff?: string;
    diff_truncated?: boolean;
  }>;
  changed_files: number;
  diff_chars: number;
  truncated: boolean;
}> {
  const record = await readRecord(id);
  const files: Array<{
    path: string;
    status: "unchanged" | "modified" | "created" | "deleted";
    baseline_bytes: number;
    current_bytes: number;
    diff?: string;
    diff_truncated?: boolean;
  }> = [];
  let diffBudget = MAX_PREVIEW_DIFF_CHARS;
  let totalDiffChars = 0;
  let truncated = false;

  for (const snapshot of record.snapshots) {
    await assertTransactionPathInsideWorkspace(record.workspace, snapshot.path);
    const current = await sha256File(snapshot.path);
    const unchanged = snapshot.existed === current.exists && snapshot.baseline_sha256 === current.sha256;
    let status: "unchanged" | "modified" | "created" | "deleted" = "unchanged";
    if (!unchanged) {
      if (!snapshot.existed && current.exists) status = "created";
      else if (snapshot.existed && !current.exists) status = "deleted";
      else status = "modified";
    }

    const row: {
      path: string;
      status: "unchanged" | "modified" | "created" | "deleted";
      baseline_bytes: number;
      current_bytes: number;
      diff?: string;
      diff_truncated?: boolean;
    } = { path: snapshot.path, status, baseline_bytes: snapshot.size, current_bytes: current.size };

    if (status !== "unchanged" && diffBudget > 0) {
      try {
        const baseline = snapshot.existed && snapshot.snapshot_file ? await fs.readFile(snapshot.snapshot_file) : Buffer.alloc(0);
        const present = current.exists ? await fs.readFile(snapshot.path) : Buffer.alloc(0);
        if (!looksBinary(baseline) && !looksBinary(present)) {
          const fullDiff = buildSimpleDiff(baseline.toString("utf-8"), present.toString("utf-8"));
          const clipped = fullDiff.slice(0, diffBudget);
          row.diff = clipped;
          row.diff_truncated = clipped.length < fullDiff.length;
          totalDiffChars += clipped.length;
          diffBudget -= clipped.length;
          if (row.diff_truncated) truncated = true;
        }
      } catch {}
    } else if (status !== "unchanged") {
      truncated = true;
    }
    files.push(row);
  }

  return {
    transaction: record,
    files,
    changed_files: files.filter((row) => row.status !== "unchanged").length,
    diff_chars: totalDiffChars,
    truncated,
  };
}

export async function recordTransactionVerification(
  id: string,
  verification: NonNullable<EditTransactionRecord["verification"]>
): Promise<EditTransactionRecord> {
  const record = await readRecord(id);
  assertActive(record);
  record.verification = verification;
  await saveRecord(record);
  return record;
}

export async function acceptEditTransaction(id: string): Promise<EditTransactionRecord> {
  const record = await readRecord(id);
  if (record.status === "rolled_back") throw new Error(`Edit transaction ${id} is rolled_back, not active`);
  if (record.status === "accepted") {
    await cleanupPayload(record);
    await saveRecord(record);
    await pruneEditTransactions();
    return record;
  }
  assertActive(record);
  record.status = "accepted";
  record.accepted_at = nowIso();
  // Persist the terminal state before deleting baseline payloads. If cleanup
  // is interrupted, an accepted transaction may retain harmless snapshots;
  // the inverse ordering could leave an active transaction with no rollback
  // payload at all.
  await saveRecord(record);
  await cleanupPayload(record);
  await saveRecord(record);
  await pruneEditTransactions();
  return record;
}

export async function rollbackEditTransaction(
  id: string,
  force = false
): Promise<{
  transaction: EditTransactionRecord;
  rolled_back: boolean;
  restored: string[];
  deleted: string[];
  conflicts: Array<{ path: string; expected_sha256?: string; current_sha256?: string; expected_exists: boolean; current_exists: boolean }>;
}> {
  const record = await readRecord(id);
  if (record.status === "accepted") throw new Error(`Edit transaction ${id} is accepted and cannot be rolled back`);
  if (record.status === "rolled_back") {
    await cleanupPayload(record);
    await saveRecord(record);
    await pruneEditTransactions();
    return { transaction: record, rolled_back: true, restored: [], deleted: [], conflicts: [] };
  }
  assertActive(record);
  const conflicts: Array<{ path: string; expected_sha256?: string; current_sha256?: string; expected_exists: boolean; current_exists: boolean }> = [];

  for (const snapshot of record.snapshots) {
    await assertTransactionPathInsideWorkspace(record.workspace, snapshot.path);
    const current = await sha256File(snapshot.path);
    const expectedExists = snapshot.last_known_exists ?? snapshot.existed;
    const expectedHash = snapshot.last_known_sha256;
    const matchesExpected = current.exists === expectedExists && (!current.exists || current.sha256 === expectedHash);
    const matchesBaseline = current.exists === snapshot.existed && (!current.exists || current.sha256 === snapshot.baseline_sha256);
    if (!matchesExpected && !matchesBaseline) {
      conflicts.push({
        path: snapshot.path,
        expected_sha256: expectedHash,
        current_sha256: current.sha256,
        expected_exists: expectedExists,
        current_exists: current.exists,
      });
    }
  }

  if (conflicts.length && !force) {
    return { transaction: record, rolled_back: false, restored: [], deleted: [], conflicts };
  }

  const restored: string[] = [];
  const deleted: string[] = [];
  for (const snapshot of [...record.snapshots].reverse()) {
    if (snapshot.existed) {
      if (!snapshot.snapshot_file) throw new Error(`Missing transaction snapshot payload for ${snapshot.path}`);
      await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
      await fs.copyFile(snapshot.snapshot_file, snapshot.path);
      if (snapshot.mode !== undefined) await fs.chmod(snapshot.path, snapshot.mode).catch(() => undefined);
      restored.push(snapshot.path);
    } else {
      await fs.rm(snapshot.path, { force: true });
      deleted.push(snapshot.path);
    }
  }

  record.status = "rolled_back";
  record.rolled_back_at = nowIso();
  // The filesystem is already restored at this point. Persist that terminal
  // state before removing payloads so a cleanup/save interruption cannot make
  // the transaction look active while its baselines are gone.
  await saveRecord(record);
  await cleanupPayload(record);
  await saveRecord(record);
  await pruneEditTransactions();
  return { transaction: record, rolled_back: true, restored, deleted, conflicts };
}
