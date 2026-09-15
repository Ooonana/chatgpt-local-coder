import assert from "node:assert/strict";
import path from "node:path";

const registry = await import("../dist/lib/delegate-registry.js");
const known = ["claude", "codex", "grok", "opencode"];

const first = await registry.probeDelegates(true);
assert.deepEqual(first.map((item) => item.id), known);
for (const item of first) {
  assert.equal(typeof item.binary, "string");
  assert.ok(["stdin", "file", "argv"].includes(item.prompt_channel));
  assert.equal(item.available, Boolean(item.path));
  assert.ok(Array.isArray(item.noninteractive_args));
  if (process.platform === "win32" && item.path?.toLowerCase().includes(`${path.sep}npm${path.sep}`)) {
    assert.ok(path.extname(item.path), `Windows npm delegate must use an executable shim: ${item.path}`);
  }
}
console.log(`OK  delegate registry reports ${first.filter((item) => item.available).length}/${first.length} available CLI(s)`);

const cached = await registry.probeDelegates(false);
assert.deepEqual(cached, first);
console.log("OK  delegate probe cache is stable");
