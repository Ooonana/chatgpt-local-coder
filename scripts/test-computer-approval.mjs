import assert from "node:assert/strict";
import { approvalMode, needsComputerApproval, requireComputerApproval } from "../dist/lib/computer-approval.js";

const savedMode = process.env.MCP_COMPUTER_APPROVAL_MODE;
try {
  process.env.MCP_COMPUTER_APPROVAL_MODE = "sensitive";
  assert.equal(approvalMode(), "sensitive");
  assert.equal(needsComputerApproval("desktop_type"), true);
  assert.equal(needsComputerApproval("agent_browser_connect"), true);
  assert.equal(needsComputerApproval("agent_browser_fill"), true);
  assert.equal(needsComputerApproval("desktop_click"), false);
  assert.equal(needsComputerApproval("desktop_wait"), false);
  process.env.MCP_COMPUTER_APPROVAL_MODE = "all";
  assert.equal(needsComputerApproval("desktop_click"), true);
  assert.equal(needsComputerApproval("agent_browser_wait_ms"), false);
  process.env.MCP_COMPUTER_APPROVAL_MODE = "off";
  assert.equal(needsComputerApproval("desktop_type"), false);
  process.env.MCP_COMPUTER_APPROVAL_MODE = "invalid";
  assert.throws(() => approvalMode(), /off, sensitive, or all/);

  process.env.MCP_COMPUTER_APPROVAL_MODE = "sensitive";
  let prompts = 0;
  const permit = async () => { prompts++; return true; };
  await requireComputerApproval("desktop", "desktop_type", "fixture-window-1", permit);
  await requireComputerApproval("desktop", "desktop_set_value", "fixture-window-1", permit);
  assert.equal(prompts, 1, "Operator grant should reuse only the same short-lived scope");
  await requireComputerApproval("desktop", "desktop_type", "fixture-window-2", permit);
  assert.equal(prompts, 2, "Different windows must require fresh approval");
  await assert.rejects(
    requireComputerApproval("browser", "agent_browser_fill", "fixture-denied", async () => false),
    /denied by the local operator/
  );
  await requireComputerApproval("browser", "agent_browser_fill", "fixture-denied", permit);
  assert.equal(prompts, 3, "Denied grants must never be cached");
  await Promise.all(Array.from({ length: 4 }, () =>
    requireComputerApproval("browser", "agent_browser_connect", "fixture-concurrent", async () => {
      prompts++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return true;
    })
  ));
  assert.equal(prompts, 4, "Concurrent requests should share one prompt");
  console.log("OK independent operator confirmation gating, scope, denial, and prompt coalescing");
} finally {
  if (savedMode === undefined) delete process.env.MCP_COMPUTER_APPROVAL_MODE;
  else process.env.MCP_COMPUTER_APPROVAL_MODE = savedMode;
}