import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-perms-"));
const inside = path.join(root, "workspace");
const outside = path.join(root, "outside");
await fs.mkdir(inside, { recursive: true });
await fs.mkdir(outside, { recursive: true });
const permissionsFile = path.join(root, "permissions.json");
const hooksFile = path.join(root, "hooks.json");
process.env.PERMISSIONS_CONFIG = permissionsFile;
process.env.LOCAL_HOOKS_CONFIG = hooksFile;

const permissions = await import("../dist/lib/permissions.js");
const hooks = await import("../dist/lib/local-hooks.js");
const pathSecurity = await import("../dist/lib/path-security.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`OK  ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
}

function nodeScriptCommand(script) {
  const exe = JSON.stringify(process.execPath);
  const file = JSON.stringify(script);
  return process.platform === "win32" ? `& ${exe} ${file}` : `${exe} ${file}`;
}

permissions.setPermissionWorkspaceRoots([inside]);
pathSecurity.setDefaultCwd(inside);

await test("open profile allows arbitrary local paths and commands", async () => {
  permissions.savePermissionConfig({ profile: "open" });
  permissions.assertPathAllowed(outside);
  permissions.requireCommandAllowed("node --version", outside);
  permissions.requireUnsafeRuntimeAllowed("test runtime");
});

await test("invalid permission configuration never falls back to open", async () => {
  assert.throws(
    () => permissions.savePermissionConfig({ profile: "typo-profile" }),
    /Invalid permission profile/
  );
  assert.throws(
    () => permissions.savePermissionConfig({ profile: "custom", command_deny_patterns: "not-an-array" }),
    /command_deny_patterns must be an array of strings/
  );
  assert.throws(
    () => permissions.savePermissionConfig({ profile: "custom", command_deny_patterns: ["["] }),
    /invalid regex/i
  );
  await fs.writeFile(permissionsFile, "{not-json\n", "utf-8");
  assert.throws(() => permissions.getPermissionConfig(), /Failed to load permission config/);
  permissions.savePermissionConfig({ profile: "open" });
});

await test("workspace profile restricts Local Coder path arguments", async () => {
  permissions.savePermissionConfig({ profile: "workspace" });
  permissions.assertPathAllowed(path.join(inside, "a.txt"));
  assert.throws(() => permissions.assertPathAllowed(path.join(outside, "a.txt")), /outside configured roots/);
  permissions.requireCommandAllowed("node --version", inside);
  assert.throws(() => permissions.requireUnsafeRuntimeAllowed("node_repl"), /unrestricted runtime/);
});

await test("workspace profile blocks symlink or junction escapes", async () => {
  permissions.savePermissionConfig({ profile: "workspace" });
  const link = path.join(inside, "escape-link");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    console.log("SKIP symlink/junction creation not permitted on this host");
    return;
  }
  await assert.rejects(
    () => pathSecurity.validatePath(path.join(link, "escaped.txt")),
    /symlink|junction|escapes configured roots/i
  );
});

await test("read_only blocks mutations and commands", async () => {
  permissions.savePermissionConfig({ profile: "read_only" });
  assert.equal(permissions.canWriteFiles(), false);
  assert.equal(permissions.canRunCommands(), false);
  assert.throws(() => permissions.requireWriteAllowed(), /file mutations are disabled/);
  assert.throws(() => permissions.requireCommandAllowed("node --version", inside), /command is not allowed/);
});

await test("custom profile applies command allow/deny policy", async () => {
  permissions.savePermissionConfig({
    profile: "custom",
    path_roots: [inside],
    allow_write: true,
    allow_commands: true,
    allow_unsafe_runtimes: true,
    command_allow_patterns: ["^node\\b"],
    command_deny_patterns: ["danger"],
  });
  permissions.requireCommandAllowed("node --version", inside);
  assert.throws(() => permissions.requireCommandAllowed("python --version", inside), /not allowed/);
  assert.throws(() => permissions.requireCommandAllowed("node danger.js", inside), /not allowed/);
  permissions.requireUnsafeRuntimeAllowed("test runtime");
});

await test("native hook returns additional context", async () => {
  permissions.savePermissionConfig({ profile: "open" });
  const script = path.join(root, "context-hook.mjs");
  await fs.writeFile(script, 'console.log(JSON.stringify({allow:true,additional_context:"hook-context"}));\n');
  await hooks.saveLocalHooksConfig({
    enabled: true,
    hooks: [{ id: "ctx", event: "session_start", command: nodeScriptCommand(script), blocking: true }],
  });
  const result = await hooks.runLocalHooks("session_start", { workspace: inside });
  assert.equal(result.allow, true);
  assert.match(result.additional_context, /hook-context/);
});

await test("malformed hook configuration fails visibly", async () => {
  await fs.writeFile(hooksFile, "{not-json\n", "utf-8");
  await assert.rejects(() => hooks.getLocalHooksConfig(), /Failed to load local hooks config/);
  await assert.rejects(
    () => hooks.saveLocalHooksConfig({
      enabled: true,
      hooks: [{ id: "bad", event: "unknown-event", command: "echo nope" }],
    }),
    /Invalid local hook entry/
  );
  await assert.rejects(
    () => hooks.saveLocalHooksConfig({
      enabled: true,
      hooks: [{ id: "bad-blocking", event: "pre_tool_use", command: "echo nope", blocking: "true" }],
    }),
    /blocking must be a boolean/
  );
  await assert.rejects(
    () => hooks.saveLocalHooksConfig({
      enabled: true,
      hooks: [{ id: "bad-tool-filter", event: "pre_tool_use", command: "echo nope", tool: "write_file" }],
    }),
    /tool must be an array of strings/
  );
  await hooks.saveLocalHooksConfig({ enabled: false, hooks: [] });
});

await test("blocking pre_tool_use hook can deny matching tool", async () => {
  const script = path.join(root, "deny-hook.mjs");
  await fs.writeFile(script, 'console.log(JSON.stringify({allow:false,reason:"denied-by-test"}));\n');
  await hooks.saveLocalHooksConfig({
    enabled: true,
    hooks: [{ id: "deny", event: "pre_tool_use", command: nodeScriptCommand(script), blocking: true, tool: ["write_file"] }],
  });
  const denied = await hooks.runLocalHooks("pre_tool_use", { tool: "write_file", path: path.join(inside, "x.txt"), workspace: inside });
  assert.equal(denied.allow, false);
  assert.match(denied.reason || "", /denied-by-test/);
  const skipped = await hooks.runLocalHooks("pre_tool_use", { tool: "read_text_file", path: path.join(inside, "x.txt"), workspace: inside });
  assert.equal(skipped.allow, true);
  assert.equal(skipped.results.length, 0);
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
