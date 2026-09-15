import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-subagent-"));
const configPath = path.join(root, "subagents.json");
const permissionsPath = path.join(root, "permissions.json");
const hooksPath = path.join(root, "hooks.json");
process.env.SUBAGENT_CONFIG = configPath;
process.env.PERMISSIONS_CONFIG = permissionsPath;
process.env.LOCAL_HOOKS_CONFIG = hooksPath;

const permissions = await import("../dist/lib/permissions.js");
const subagents = await import("../dist/lib/subagent-manager.js");
const hooks = await import("../dist/lib/local-hooks.js");
permissions.setPermissionWorkspaceRoots([root]);
permissions.savePermissionConfig({ profile: "open" });
await hooks.saveLocalHooksConfig({ enabled: false, hooks: [] });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`OK  ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
}

await test("disabled subagent runner explains ChatGPT subscription boundary", async () => {
  await subagents.saveSubagentConfig({ enabled: false, executable: "", args: [] });
  await assert.rejects(
    () => subagents.spawnSubagent({ objective: "test", workspace: root }),
    /ChatGPT app subscription is not exposed/
  );
});

await test("malformed subagent configuration fails visibly", async () => {
  await fs.writeFile(configPath, "{not-json\n", "utf-8");
  await assert.rejects(() => subagents.getSubagentConfig(), /Failed to load subagent config/);
  await assert.rejects(
    () => subagents.saveSubagentConfig({
      enabled: true,
      executable: process.execPath,
      args: [],
      isolation: "typo-isolation",
    }),
    /isolation must be 'none' or 'worktree'/
  );
  await subagents.saveSubagentConfig({ enabled: false, executable: "", args: [] });
});

await test("configured model runner spawns, captures output, waits and clears", async () => {
  const runner = path.join(root, "fake-agent.mjs");
  await fs.writeFile(runner, `
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
console.log("AGENT:" + input.trim());
`);
  await subagents.saveSubagentConfig({
    enabled: true,
    executable: process.execPath,
    args: [runner],
    prompt_via_stdin: true,
    timeout_ms: 10000,
    isolation: "none",
  });
  const started = await subagents.spawnSubagent({ objective: "inspect this", workspace: root, label: "fake" });
  assert.equal(started.running, true);
  const done = await subagents.waitForSubagent(started.id, 10000);
  assert.equal(done.running, false);
  assert.equal(done.exit_code, 0);
  assert.match(done.stdout, /AGENT:inspect this/);
  assert.equal(subagents.getSubagent(started.id)?.id, started.id);
  assert.ok(subagents.listSubagents().some((item) => item.id === started.id));
  const cleared = await subagents.clearSubagents(false);
  assert.equal(cleared.cleared, 1);
});

await test("subagent config rejects missing prompt transport", async () => {
  await subagents.saveSubagentConfig({
    enabled: true,
    executable: process.execPath,
    args: ["-e", "console.log('unused')"],
    prompt_via_stdin: false,
    max_concurrency: 1,
  });
  await assert.rejects(
    () => subagents.spawnSubagent({ objective: "cannot be delivered", workspace: root }),
    /requires at least one args entry containing \{prompt\}/
  );
});

await test("subagent concurrency limit prevents unbounded runners", async () => {
  const runner = path.join(root, "slow-agent.mjs");
  await fs.writeFile(runner, `setTimeout(() => console.log("done"), 5000);\n`);
  await subagents.saveSubagentConfig({
    enabled: true,
    executable: process.execPath,
    args: [runner],
    prompt_via_stdin: true,
    timeout_ms: 10000,
    max_concurrency: 1,
    isolation: "none",
  });
  const first = await subagents.spawnSubagent({ objective: "first", workspace: root });
  await assert.rejects(
    () => subagents.spawnSubagent({ objective: "second", workspace: root }),
    /concurrency limit reached/
  );
  const stopped = await subagents.stopSubagent(first.id);
  assert.equal(stopped.running, false);
  await subagents.clearSubagents(false);
});

if (process.platform === "win32") {
  await test("Windows npm cmd shim launches without shell-interpreting prompt text", async () => {
    const runner = path.join(root, "shim-agent.mjs");
    const shim = path.join(root, "shim-agent.cmd");
    await fs.writeFile(runner, 'console.log(JSON.stringify(process.argv.slice(2)));\n', "utf-8");
    await fs.writeFile(
      shim,
      [
        "@ECHO off",
        'SET "_prog=node"',
        '"%_prog%" "%dp0%\\shim-agent.mjs" %*',
        "",
      ].join("\r\n"),
      "utf-8"
    );
    const objective = 'literal & echo INJECTED | more > file < input %PATH% ^ caret ! bang " quote';
    await subagents.saveSubagentConfig({
      enabled: true,
      executable: shim,
      args: ["{prompt}"],
      prompt_via_stdin: false,
      timeout_ms: 10000,
      isolation: "none",
    });
    const started = await subagents.spawnSubagent({ objective, workspace: root, label: "shim-safe" });
    const done = await subagents.waitForSubagent(started.id, 10000);
    assert.equal(done.exit_code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout.trim()), [objective]);
    assert.doesNotMatch(done.stdout, /\bINJECTED\b.*\bINJECTED\b/);
    await subagents.clearSubagents(false);
  });

  await test("unknown Windows batch runner fails closed instead of using a shell", async () => {
    const shim = path.join(root, "unknown-runner.cmd");
    await fs.writeFile(shim, "@echo off\r\necho unsafe %*\r\n", "utf-8");
    await subagents.saveSubagentConfig({
      enabled: true,
      executable: shim,
      args: ["{prompt}"],
      prompt_via_stdin: false,
      isolation: "none",
    });
    await assert.rejects(
      () => subagents.spawnSubagent({ objective: "a&b", workspace: root }),
      /Refusing to execute Windows batch shim/
    );
  });
}

await test("command policy is enforced before worktree setup", async () => {
  permissions.savePermissionConfig({
    profile: "custom",
    path_roots: [root],
    allow_write: true,
    allow_commands: false,
    allow_unsafe_runtimes: true,
  });
  await subagents.saveSubagentConfig({
    enabled: true,
    executable: process.execPath,
    args: ["-e", "console.log('should-not-run')"],
    prompt_via_stdin: true,
    isolation: "worktree",
  });
  await assert.rejects(
    () => subagents.spawnSubagent({ objective: "blocked", workspace: root }),
    /command is not allowed/
  );
  permissions.savePermissionConfig({ profile: "open" });
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
