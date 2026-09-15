import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.env.GOAL_SCRATCH || path.join(os.tmpdir(), "chatgpt-local-coder-verification");

const child = spawn(process.execPath, [path.join(root, "scripts/capture-verification-evidence.mjs")], {
  cwd: root,
  env: { ...process.env, GOAL_SCRATCH: scratch },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
