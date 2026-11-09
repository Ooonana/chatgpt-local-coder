import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readContextFileCached } from "../dist/tools/context.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-context-prefix-"));
const big = path.join(dir, "large-context.md");
const small = path.join(dir, "small-context.md");
const largeBytes = 32 * 1024 * 1024;
const maxBytes = 1024;
const originalOpen = fs.open;
const originalReadFile = fs.readFile;
let openCount = 0;
let bytesRead = 0;
let wholeFileAttempts = 0;

try {
  await fs.writeFile(big, Buffer.alloc(largeBytes, 65));
  await fs.writeFile(small, "AAAA");

  // Measure the actual bytes requested through the handle, not merely the
  // returned text length. A regression to fs.readFile(big) fails this test.
  fs.readFile = async (...args) => {
    if (path.resolve(String(args[0])) === big) {
      wholeFileAttempts++;
      throw new Error("Whole-file read attempted for a bounded context prefix");
    }
    return originalReadFile(...args);
  };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== big) return handle;
    openCount++;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  };

  const cold = await readContextFileCached(big, maxBytes);
  assert.equal(cold.content, "A".repeat(maxBytes));
  assert.equal(cold.truncated, true);
  assert.equal(bytesRead, maxBytes, "Cold read exceeded its byte budget");
  assert.equal(openCount, 1);
  assert.equal(wholeFileAttempts, 0);

  const warm = await readContextFileCached(big, maxBytes);
  assert.deepEqual(warm, cold);
  assert.equal(openCount, 1, "Cache hit opened the file again");
  assert.equal(bytesRead, maxBytes, "Cache hit read more bytes");

  const first = await readContextFileCached(small, 4);
  assert.equal(first.content, "AAAA");
  assert.equal(first.truncated, false);
  await fs.writeFile(small, "BBBB");
  const later = new Date(Date.now() + 5000);
  await fs.utimes(small, later, later);
  const updated = await readContextFileCached(small, 4);
  assert.equal(updated.content, "BBBB", "Cached content was stale after a same-size rewrite");

  const empty = path.join(dir, "empty.md");
  await fs.writeFile(empty, "");
  const emptyRead = await readContextFileCached(empty, maxBytes);
  assert.equal(emptyRead.content, "");
  assert.equal(emptyRead.truncated, false);
  for (const limit of [0, -1, 200_001, 1.5, Number.NaN]) {
    await assert.rejects(readContextFileCached(big, limit), /prefix limit/);
  }

  console.log("OK bounded context reads, cache hits, same-size invalidation and empty files");
  console.log(JSON.stringify({
    fixture_bytes: largeBytes,
    prefix_bytes: maxBytes,
    actual_cold_read_bytes: bytesRead,
    previous_whole_file_read_bytes: largeBytes,
    cold_io_reduction_factor: largeBytes / bytesRead,
    whole_file_attempts: wholeFileAttempts,
  }));
} finally {
  fs.open = originalOpen;
  fs.readFile = originalReadFile;
  await fs.rm(dir, { recursive: true, force: true });
}