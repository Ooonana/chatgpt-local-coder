/**
 * Verify tool-profile behavior and keep the Admin UI catalog synchronized with
 * the literal native server.registerTool() declarations under src/tools.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_TOOL_CATALOG, LOCAL_TOOL_COUNT, SLIM_CHATGPT_TOOLS, shouldExposeTool } from "../dist/lib/tool-profile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(here, "../src/tools");

function declaredNativeTools() {
  const found = [];
  const pattern = /\bserver\.registerTool\(\s*["']([^"']+)["']/g;
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = fs.readFileSync(path.join(toolsDir, entry.name), "utf8");
    for (const match of text.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  const declared = declaredNativeTools();
  const declaredSet = new Set(declared);
  const catalogSet = new Set(LOCAL_TOOL_CATALOG);
  if (declared.length !== declaredSet.size) throw new Error("duplicate native registerTool() name found");
  const missingFromCatalog = [...declaredSet].filter((name) => !catalogSet.has(name));
  const staleCatalogEntries = [...catalogSet].filter((name) => !declaredSet.has(name));
  if (missingFromCatalog.length || staleCatalogEntries.length) {
    throw new Error(
      `catalog drift: missing=[${missingFromCatalog.join(", ")}], stale=[${staleCatalogEntries.join(", ")}]`
    );
  }
  if (LOCAL_TOOL_COUNT !== declaredSet.size) {
    throw new Error(`LOCAL_TOOL_COUNT=${LOCAL_TOOL_COUNT}, declared=${declaredSet.size}`);
  }
  ok(`catalog matches ${LOCAL_TOOL_COUNT} native tool declarations`);

  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  for (const name of SLIM_CHATGPT_TOOLS) {
    if (!catalogSet.has(name)) throw new Error(`slim tool is not in native catalog: ${name}`);
  }
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of ["apply_patch", "glob", "remember", "load_path_rules"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  for (const t of ["start_process", "process_status", "process_history", "process_output", "process_input", "stop_process"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
    if (!LOCAL_TOOL_CATALOG.includes(t)) throw new Error(`${t} missing from local catalog`);
  }
  ok("background process lifecycle exposed in slim");

  for (const t of [
    "run_commands_parallel", "pty", "view_image", "lsp", "delete_file",
  ]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("high-value local developer tools exposed in slim");

  for (const t of [
    "git_worktree", "agent_task", "read_files", "inspect_project", "verify_project",
    "repo_intel", "edit_transaction", "coding_loop_status", "coding_loop", "subagent",
  ]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
    if (!LOCAL_TOOL_CATALOG.includes(t)) throw new Error(`${t} missing from local catalog`);
  }
  ok("agent isolation and task-state tools exposed in slim");

  for (const t of [
    "replace_regex", "directory_tree", "create_directory", "copy_file", "move_file",
    "shell_reset", "clear_processes", "git_log", "git_branch", "git_stash",
  ]) {
    if (shouldExposeTool(t, "slim")) throw new Error(`${t} should be hidden in slim; use full/overrides or run_command fallback`);
  }
  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  if (shouldExposeTool("delete_directory", "slim")) throw new Error("delete_directory hidden");
  if (shouldExposeTool("git_reset", "slim")) throw new Error("git_reset should be hidden in slim");
  if (shouldExposeTool("git_push", "slim")) throw new Error("git_push should be hidden in slim");
  if (shouldExposeTool("write_file_base64", "slim")) throw new Error("write_file_base64 should be hidden in slim");
  ok("heavy tools hidden in slim");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
