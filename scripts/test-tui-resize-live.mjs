import assert from "node:assert/strict";
import {
  measureTerminalCells,
  startTerminalDashboard,
} from "../dist/lib/terminal-dashboard.js";

// Exercise the actual TUI event listener and stdout output path. The test
// emulates a TTY in an isolated Node process; it never resizes the user's
// console or launches the production server.
const stdout = process.stdout;
const originalWrite = stdout.write;
const descriptors = new Map(["isTTY", "columns", "rows"].map((key) => [
  key,
  Object.getOwnPropertyDescriptor(stdout, key),
]));
const priorPreference = process.env.LOCAL_CODER_TUI;
const priorHeight = process.env.LOCAL_CODER_TUI_HEIGHT;
const writes = [];
let dashboard;

function dimensions(columns, rows) {
  Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
}

function restore(key) {
  const descriptor = descriptors.get(key);
  if (descriptor) Object.defineProperty(stdout, key, descriptor);
  else delete stdout[key];
}

function inspectFrame(chunks, width, height) {
  const output = chunks.filter((value) => value.includes("Local Coder")).at(-1);
  assert.ok(output, `missing TUI redraw at ${width}x${height}`);
  assert.ok(chunks.some((value) => value.startsWith("\x1b[2J\x1b[H")), "viewport change must clear stale cells");
  const frame = output.replace(/^(?:\x1b\[2J)?\x1b\[H/, "");
  const rows = frame.split("\r\n");
  assert.ok(rows.length <= height, `frame ${rows.length} rows exceeds ${height}`);
  if (height >= 20 && width >= 64) {
    assert.equal(rows.length, height, "desktop view must use all available rows");
    assert.match(rows.at(-3) || "", /Health/, "health footer missing after resize");
  }
  assert.ok(rows.every((row) => measureTerminalCells(row) <= width), "frame exceeds terminal width");
}

try {
  process.env.LOCAL_CODER_TUI = "on";
  process.env.LOCAL_CODER_TUI_HEIGHT = "auto";
  Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
  dimensions(120, 30);
  stdout.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };

  dashboard = startTerminalDashboard({
    mcpPort: 3000, adminPort: 3001,
    workspace: process.cwd(), toolProfile: "slim",
    authEnabled: true, permission: "open: full machine access",
    transportMode: "sse", keepAliveMs: 10_000,
    sessionCount: () => 0,
  });
  assert.equal(dashboard.active, true);
  assert.equal(writes.some((item) => item.includes("\x1b[8;")), false, "auto mode must not request OS window resize");
  for (const [width, height] of [[210, 68], [74, 21], [29, 8], [260, 51]]) {
    const before = writes.length;
    dimensions(width, height);
    stdout.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 90));
    inspectFrame(writes.slice(before), width, height);
  }
} finally {
  dashboard?.stop();
  stdout.write = originalWrite;
  for (const key of descriptors.keys()) restore(key);
  if (priorPreference === undefined) delete process.env.LOCAL_CODER_TUI;
  else process.env.LOCAL_CODER_TUI = priorPreference;
  if (priorHeight === undefined) delete process.env.LOCAL_CODER_TUI_HEIGHT;
  else process.env.LOCAL_CODER_TUI_HEIGHT = priorHeight;
}
console.log("OK  live TUI resize events redraw to viewport without stale rows");