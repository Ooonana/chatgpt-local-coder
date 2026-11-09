import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

// Isolated temp fixture; does not access or modify live task/loop stores.
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-admin-recovery-"));
const taskDir = path.join(fixtureRoot, "tasks");
const loopDir = path.join(fixtureRoot, "loops");
const transactionDir = path.join(fixtureRoot, "transactions");
const projectA = path.join(fixtureRoot, "project-a");
const projectB = path.join(fixtureRoot, "project-b");
for (const dir of [taskDir, loopDir, transactionDir, projectA, projectB]) {
  await fs.mkdir(dir, { recursive: true });
}
process.env.MCP_AGENT_TASK_STATE_DIR = taskDir;
process.env.MCP_CODING_LOOP_STATE_DIR = loopDir;
process.env.MCP_EDIT_TRANSACTION_STATE_DIR = transactionDir;
process.env.PERMISSIONS_CONFIG = path.join(fixtureRoot, "permissions.json");
const old = new Date(Date.now() - 49 * 3_600_000).toISOString();
const idA = "task-a";
const idB = "task-b";
const txA = "tx_aaaaaaaaaaaaaa";
const txB = "tx_bbbbbbbbbbbbbb";
const loopA = "loop_aaaaaaaaaaaaaa";
const loopB = "loop_bbbbbbbbbbbbbb";
const makeTask = (id, workspace, title) => ({
  id, title, workspace, objective: "Review only",
  status: "active", plan: ["inspect"],
  steps: [{ id: id + ":step", title: "inspect", status: "pending", updated_at: old }],
  notes: [], created_at: old, updated_at: old,
});
await fs.writeFile(path.join(taskDir, "index.json"), JSON.stringify({
  version: 2,
  tasks: [makeTask(idA, projectA, "<img src=x onerror=alert(1)>"),
    makeTask(idB, projectB, "PRIVATE_FOREIGN_TASK")],
}));
const makeLoop = (id, taskId, workspace, txId) => ({
  version: 1, id, task_id: taskId, managed_task: true,
  goal: "Review only", status: "active", phase: "editing",
  workspace, source_workspace: workspace,
  transaction_id: txId, notes: [], attempts: [],
  created_at: old, updated_at: old,
});
await fs.writeFile(path.join(loopDir, loopA + ".json"),
  JSON.stringify(makeLoop(loopA, idA, projectA, txA)));
await fs.writeFile(path.join(loopDir, loopB + ".json"),
  JSON.stringify(makeLoop(loopB, idB, projectB, txB)));
const makeTx = (id, workspace, secret) => ({
  version: 1, id, workspace, status: "active", created_at: old, updated_at: old,
  snapshots: [{ path: path.join(workspace, secret) }], edits: [],
});
await fs.writeFile(path.join(transactionDir, txA + ".json"),
  JSON.stringify(makeTx(txA, projectA, "SECRET_SNAPSHOT_PATH")));
await fs.writeFile(path.join(transactionDir, txB + ".json"),
  JSON.stringify(makeTx(txB, projectB, "FOREIGN_SNAPSHOT_PATH")));

const { createAdminRouter } = await import("../dist/admin/routes.js");
const { savePermissionConfig } = await import("../dist/lib/permissions.js");
savePermissionConfig({ profile: "open" });
const app = express();
app.use(createAdminRouter({}, {
  mcpPort: 0, pid: process.pid, transportMode: "json", keepAliveMs: 10_000,
  sessionCount: () => 0,
}));
const server = app.listen(0, "127.0.0.1");
try {
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = async (params) => {
    const url = base + "/api/recovery/review" + (params ? "?" + new URLSearchParams(params) : "");
    const response = await fetch(url);
    return { status: response.status, cache: response.headers.get("cache-control"),
      body: await response.json() };
  };
  const invalid = await request();
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /explicit workspace/i);
  const invalidHours = await request({ workspace: projectA, stale_hours: "-5" });
  assert.equal(invalidHours.status, 400);
  assert.match(invalidHours.body.error, /stale_hours/i);
  const invalidTextHours = await request({ workspace: projectA, stale_hours: "not-a-number" });
  assert.equal(invalidTextHours.status, 400);

  const savedFiles = [
    path.join(taskDir, "index.json"),
    path.join(loopDir, loopA + ".json"), path.join(loopDir, loopB + ".json"),
    path.join(transactionDir, txA + ".json"), path.join(transactionDir, txB + ".json"),
  ];
  const baseline = await Promise.all(savedFiles.map((file) => fs.readFile(file, "utf8")));
  const result = await request({ workspace: projectA, stale_hours: "24" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.cache, "no-store");
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.counts, { tasks: 1, coding_loops: 1, edit_transactions: 1 });
  assert.equal(result.body.findings[0].id, idA);
  assert.equal(result.body.stale_loops[0].id, loopA);
  assert.equal(result.body.stale_transactions[0].id, txA);
  assert.equal(result.body.stale_transactions[0].files, 1);
  const text = JSON.stringify(result.body);
  assert.ok(!text.includes("PRIVATE_FOREIGN_TASK"), "Foreign task leaked");
  assert.ok(!text.includes(txB), "Foreign transaction leaked");
  assert.ok(!text.includes("SECRET_SNAPSHOT_PATH"), "Snapshot contents leaked");
  assert.ok(!text.includes("FOREIGN_SNAPSHOT_PATH"), "Foreign snapshot leaked");
  const after = await Promise.all(savedFiles.map((file) => fs.readFile(file, "utf8")));
  assert.deepEqual(after, baseline, "Read-only review changed durable records");
  const foreign = await request({ workspace: projectB, stale_hours: "24" });
  assert.deepEqual(foreign.body.counts, { tasks: 1, coding_loops: 1, edit_transactions: 1 });
  assert.equal(foreign.body.findings[0].id, idB);
  const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    request({ workspace: index % 2 ? projectB : projectA, stale_hours: "24" })
  ));
  for (let index = 0; index < concurrent.length; index++) {
    const response = concurrent[index];
    assert.equal(response.status, 200);
    const expectedId = index % 2 ? idB : idA;
    assert.equal(response.body.findings[0].id, expectedId, "Concurrent workspace reports got mixed");
    assert.ok(!JSON.stringify(response.body).includes(index % 2 ? idA : idB));
  }
  console.log("OK Admin recovery endpoint requires explicit workspace and validates stale age");
  console.log("OK recovery counts are scoped; no foreign records or snapshot paths disclosed");
  console.log("OK 12 concurrent project-specific reviews remained isolated");
  console.log("OK review leaves task, loop, and transaction records unchanged");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}