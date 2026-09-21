import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-phase5-"));
process.env.MCP_RESULT_STATE_DIR = path.join(temp, "results");
process.env.MCP_PARALLEL_BATCH_STATE_DIR = path.join(temp, "parallel");
process.env.MCP_IDEMPOTENCY_STATE_DIR = path.join(temp, "idempotency");
process.env.MCP_PROJECT_REGISTRY_PATH = path.join(temp, "projects.json");
process.env.MCP_VERIFICATION_CACHE_STATE_DIR = path.join(temp, "verify-cache");
process.env.MCP_VERIFICATION_CACHE_TTL_SECONDS = "300";
process.env.MCP_TEXT_CACHE_MAX_BYTES = "1048576";
process.env.MCP_TEXT_CACHE_MAX_ENTRY_BYTES = "524288";
process.env.MCP_TEXT_CACHE_MAX_ENTRIES = "8";

const { classifyToolFailure } = await import("../dist/lib/error-model.js");
const { compactOrStoreText, readTextResult } = await import("../dist/lib/result-store.js");
const { captureWorkingTree, compareWorkingTrees } = await import("../dist/lib/shell-mutation.js");
const { loadIdempotent, requestFingerprint, saveIdempotent, withIdempotencyKeyLock } = await import("../dist/lib/idempotency-store.js");
const { loadParallelBatch, newParallelBatchId, saveParallelBatch } = await import("../dist/lib/parallel-batch-store.js");
const { recordProjectAffinity, resolveProjectReference } = await import("../dist/lib/project-affinity.js");
const { hasVerificationCache, saveVerificationCache, selectIncrementalVerification, verificationFingerprint } = await import("../dist/lib/verification-cache.js");
const { readTextCached, invalidateTextReadCache, getTextReadCacheStats } = await import("../dist/lib/text-read-cache.js");
const { pruneEphemeralState } = await import("../dist/lib/state-maintenance.js");
const { beginToolCall, finishToolCall, getRuntimeSnapshot, resetRuntimeStateForTests } = await import("../dist/lib/runtime-state.js");

await test("structured no-match errors are non-failures", async () => {
  for (const command of ["rg needle .", "grep needle file", "git grep needle", "Select-String needle file"]) {
    const failure = classifyToolFailure({ command, exitCode: 1, message: "" });
    assert.equal(failure.category, "expected_no_match");
    assert.equal(failure.retryable, false);
  }
});

await test("large output spills to a durable result handle", async () => {
  const text = "x".repeat(50_000);
  const compact = await compactOrStoreText(text, { inline_chars: 2_000, prefix: "phase5" });
  assert.equal(compact.truncated, true);
  assert.ok(compact.output_handle);
  assert.equal(compact.text.length, 2_000);
  const first = await readTextResult(compact.output_handle, 0, 1_234);
  assert.equal(first.text.length, 1_234);
  assert.equal(first.original_chars, text.length);
  assert.ok(first.next_offset);
});

await test("mutation evidence detects edits to an already-dirty file", async () => {
  const repo = path.join(temp, "mutation-repo");
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "phase5@example.invalid");
  git(repo, "config", "user.name", "Phase5 Test");
  const file = path.join(repo, "a.txt");
  await fs.writeFile(file, "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  await fs.writeFile(file, "dirty-one\n");
  const before = await captureWorkingTree(repo);
  await fs.writeFile(file, "dirty-two\n");
  const after = await captureWorkingTree(repo);
  assert.deepEqual(compareWorkingTrees(before, after).changed_paths, ["a.txt"]);
});

await test("same idempotency key executes concurrent work once", async () => {
  const key = "phase5_same_key";
  const fingerprint = requestFingerprint({ operation: "once" });
  let executions = 0;
  const run = () => withIdempotencyKeyLock(key, async () => {
    const cached = await loadIdempotent(key, fingerprint);
    if (cached) return cached;
    executions++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const value = { executions };
    await saveIdempotent(key, fingerprint, value);
    return value;
  });
  const values = await Promise.all(Array.from({ length: 12 }, run));
  assert.equal(executions, 1);
  assert.ok(values.every((item) => item.executions === 1));
});

await test("parallel batch preserves incomplete members for retry", async () => {
  const now = new Date().toISOString();
  const record = {
    version: 1,
    id: newParallelBatchId(),
    created_at: now,
    updated_at: now,
    concurrency: 2,
    commands: [{ command: "one" }, { command: "two" }],
    results: [{ index: 0, command: "one", cwd: temp, stdout: "ok", stderr: "", exit_code: 0, signal: null, timed_out: false, duration_ms: 1 }, null],
    attempts: 1,
  };
  await saveParallelBatch(record);
  const loaded = await loadParallelBatch(record.id);
  assert.equal(loaded.results.length, 2);
  assert.equal(loaded.results[0].exit_code, 0);
  assert.equal(loaded.results[1], null);
});

await test("duplicate project aliases are rejected instead of guessed", async () => {
  const rootA = path.join(temp, "projects-a", "same");
  const rootB = path.join(temp, "projects-b", "same");
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  await fs.writeFile(path.join(rootA, "package.json"), "{}");
  await fs.writeFile(path.join(rootB, "package.json"), "{}");
  await recordProjectAffinity(rootA);
  await recordProjectAffinity(rootB);
  await assert.rejects(() => resolveProjectReference("same", temp), /ambiguous/i);
});

await test("verification cache invalidates on any dirty project dependency", async () => {
  const repo = path.join(temp, "verification-repo");
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "phase5@example.invalid");
  git(repo, "config", "user.name", "Phase5 Test");
  const a = path.join(repo, "a.js");
  const b = path.join(repo, "b.js");
  await fs.writeFile(a, "export const a = 1;\n");
  await fs.writeFile(b, "export const b = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  await fs.writeFile(a, "export const a = 2;\n");
  const first = await verificationFingerprint(repo, "npm test", [a]);
  assert.ok(first);
  await saveVerificationCache(repo, "npm test", first);
  await fs.writeFile(b, "BROKEN\n");
  const second = await verificationFingerprint(repo, "npm test", [a]);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(await hasVerificationCache(repo, "npm test", second), false);
});

await test("incremental verification does not classify arbitrary txt source data as docs-only", async () => {
  const commands = [
    { label: "build", command: "npm run build", timeout_seconds: 180 },
    { label: "diff", command: "git diff --check", timeout_seconds: 30 },
  ];
  const readme = selectIncrementalVerification(commands, ["README.md"], "quick");
  assert.equal(readme.incremental, true);
  assert.deepEqual(readme.commands.map((item) => item.label), ["diff"]);
  const docsText = selectIncrementalVerification(commands, ["docs/notes.txt"], "quick");
  assert.equal(docsText.incremental, true);
  const sourceText = selectIncrementalVerification(commands, ["src/data.txt"], "quick");
  assert.equal(sourceText.incremental, false);
  assert.equal(sourceText.commands.length, commands.length);
});

await test("text cache revalidates same-size rewrites even with restored mtime", async () => {
  const file = path.join(temp, "cache.txt");
  await fs.writeFile(file, "AAAA");
  const stat = await fs.stat(file);
  const first = await readTextCached(file);
  assert.equal(first.cache_hit, false);
  await fs.writeFile(file, "BBBB");
  await fs.utimes(file, stat.atime, stat.mtime);
  const second = await readTextCached(file);
  assert.equal(second.text, "BBBB");
  assert.equal(second.cache_hit, false);
  invalidateTextReadCache(file);
});

await test("text cache obeys total and per-entry heap budgets", async () => {
  invalidateTextReadCache();
  const dir = path.join(temp, "text-cache-budget");
  await fs.mkdir(dir, { recursive: true });
  for (let index = 0; index < 12; index++) {
    const file = path.join(dir, `small-${index}.txt`);
    await fs.writeFile(file, String(index).repeat(200_000));
    await readTextCached(file);
  }
  const bounded = getTextReadCacheStats();
  assert.ok(bounded.retained_bytes <= bounded.max_total_bytes, JSON.stringify(bounded));
  assert.ok(bounded.entries <= bounded.max_entries, JSON.stringify(bounded));
  assert.ok(bounded.entries < 12, `expected byte-pressure eviction: ${JSON.stringify(bounded)}`);

  const beforeLarge = getTextReadCacheStats();
  const large = path.join(dir, "too-large.txt");
  await fs.writeFile(large, "L".repeat(400_000));
  await readTextCached(large);
  const afterLarge = getTextReadCacheStats();
  assert.equal(afterLarge.entries, beforeLarge.entries, JSON.stringify(afterLarge));
  assert.equal(afterLarge.retained_bytes, beforeLarge.retained_bytes, JSON.stringify(afterLarge));
  invalidateTextReadCache();
});

await test("ephemeral state pruning honors custom directories", async () => {
  process.env.MCP_EPHEMERAL_STATE_RETENTION_DAYS = "1";
  const dirs = [
    process.env.MCP_RESULT_STATE_DIR,
    process.env.MCP_PARALLEL_BATCH_STATE_DIR,
    process.env.MCP_IDEMPOTENCY_STATE_DIR,
    process.env.MCP_VERIFICATION_CACHE_STATE_DIR,
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `old-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(file, "{}");
    const old = new Date(Date.now() - 3 * 86_400_000);
    await fs.utimes(file, old, old);
  }
  const report = await pruneEphemeralState();
  assert.ok(report.removed_files >= 4);
  assert.equal(report.errors.length, 0);
});

await test("runtime identity import is side-effect free", async () => {
  const state = path.join(temp, "identity.json");
  const env = { ...process.env, MCP_RUNTIME_IDENTITY_PATH: state, CHATGPT_TOOL_PROFILE: "slim" };
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "import {getRuntimeIdentity} from './dist/lib/runtime-identity.js'; getRuntimeIdentity();"], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  await assert.rejects(fs.access(state));
  const initialized = spawnSync(process.execPath, ["--input-type=module", "-e", `import {initializeRuntimeIdentity} from './dist/lib/runtime-identity.js'; initializeRuntimeIdentity(${JSON.stringify(temp)});`], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const saved = JSON.parse(await fs.readFile(state, "utf8"));
  assert.match(saved.run_id, /^run_/);
});

await test("runtime telemetry records result bytes and repeats", async () => {
  resetRuntimeStateForTests();
  const first = beginToolCall({ tool: "phase5_test", kind: "READ", summary: "same" });
  finishToolCall(first, "ok", undefined, 100);
  const second = beginToolCall({ tool: "phase5_test", kind: "READ", summary: "same" });
  finishToolCall(second, "ok", undefined, 300);
  const stat = getRuntimeSnapshot().usage.find((item) => item.tool === "phase5_test");
  assert.equal(stat.calls, 2);
  assert.equal(stat.total_result_bytes, 400);
  assert.equal(stat.average_result_bytes, 200);
  assert.equal(stat.repeated_calls, 1);
  assert.ok(stat.p95_duration_ms >= stat.p50_duration_ms);
});

await fs.rm(temp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;