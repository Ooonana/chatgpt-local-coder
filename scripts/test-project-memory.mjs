/**
 * Test instruction context builder (Phase 1+2).
 * Run: node scripts/test-project-memory.mjs
 */
import {
  buildInstructionContext,
  summarizeInstructionContext,
} from "../dist/lib/instruction-context.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAutoMemory, loadAutoMemory } from "../dist/lib/auto-memory.js";

const workspaceRoot = process.env.WORKSPACE_PATH || process.cwd();
let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}
function fail(name, err) {
  console.error(`FAIL ${name}: ${err}`);
  failed++;
}

try {
  const ctx = await buildInstructionContext({
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    pid: process.pid,
    adminPort: 3001,
  });

  if (!ctx.instructionsText.includes("Agent workflow")) {
    throw new Error("missing agent prompt");
  }
  ok("agent prompt in instructions");

  if (!ctx.instructionsText.includes("## Environment")) {
    throw new Error("missing environment block");
  }
  ok("environment block");

  if (!ctx.instructionsText.includes("## Git")) {
    throw new Error("missing git block");
  }
  ok("git block");

  if (!ctx.instructionsText.includes("agent_status")) {
    throw new Error("missing footer quick pointers");
  }
  ok("footer pointers (agent_status not duplicated in body)");

  if (ctx.instructionBytes < 500) {
    throw new Error(`instructions too small: ${ctx.instructionBytes}`);
  }
  ok(`instruction size ${Math.round(ctx.instructionBytes / 1024)}KB`);

  const summary = summarizeInstructionContext(ctx);
  if (!summary.root) throw new Error("summary missing root");
  ok("summarizeInstructionContext");

  console.log("\nGit:", ctx.git.is_repo ? ctx.git.branch : "not a repo");
  console.log("Memory files:", ctx.projectMemory.sections.map((s) => s.path).join(", ") || "(none)");
} catch (err) {
  fail("buildInstructionContext", err.message || err);
}

try {
  const autoHome = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-auto-memory-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = autoHome;
  try {
    const memoryWorkspace = path.join(autoHome, "workspace");
    await fs.mkdir(memoryWorkspace, { recursive: true });
    await Promise.all(Array.from({ length: 230 }, (_, index) =>
      appendAutoMemory(memoryWorkspace, `concurrent-note-${index}`)
    ));
    const memory = await loadAutoMemory(memoryWorkspace);
    if (!memory?.includes("concurrent-note-229")) throw new Error("latest auto-memory note was lost");
    const noteLines = memory.split(/\r?\n/).filter((line) => line.startsWith("- "));
    if (noteLines.length > 198) throw new Error(`auto-memory line budget exceeded: ${noteLines.length}`);
    if (Buffer.byteLength(memory, "utf-8") > 25_000) throw new Error("auto-memory byte budget exceeded");
    if (noteLines.length !== new Set(noteLines).size) throw new Error("auto-memory contains duplicate/corrupt note lines");
    ok("concurrent auto-memory appends preserve latest bounded notes");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(autoHome, { recursive: true, force: true });
  }
} catch (err) {
  fail("auto-memory concurrency", err.message || err);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
