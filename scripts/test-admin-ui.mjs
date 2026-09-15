import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public/ui/index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public/ui/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/ui/styles.css"), "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

function declaredUiIds() {
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const match of js.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

test("Admin UI JavaScript parses", () => {
  // Parsing only: the browser globals are intentionally not executed in Node.
  new Function(js);
});

test("literal getElementById references exist in HTML", () => {
  const ids = declaredUiIds();
  const referenced = [...js.matchAll(/document\.getElementById\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]);
  const missing = [...new Set(referenced.filter((id) => !ids.has(id)))];
  if (missing.length) throw new Error(`missing id(s): ${missing.join(", ")}`);
});

test("navigation targets existing views", () => {
  const ids = declaredUiIds();
  const targets = [...html.matchAll(/\bdata-tab=["']([^"']+)["']/g)].map((match) => match[1]);
  const missing = targets.filter((target) => !ids.has(target));
  if (missing.length) throw new Error(`missing view(s): ${missing.join(", ")}`);
});

test("runtime overview surfaces are present", () => {
  for (const id of [
    "overview-dot",
    "overview-state",
    "overview-last-tool",
    "overview-transport",
    "overview-updated",
    "dash-active-count",
    "dash-active",
    "dash-recent",
    "dash-task-count",
    "dash-agent-task",
    "dash-operation-count",
    "dash-operations",
    "dash-loop-count",
    "dash-loops",
    "dash-transaction-count",
    "dash-transactions",
    "dash-capsule-count",
    "dash-capsules",
    "dash-state-errors",
  ]) {
    if (!html.includes(`id="${id}"`)) throw new Error(`missing ${id}`);
  }
  for (const className of [".overview-hero", ".overview-split", ".runtime-row", ".status-dot.busy"]) {
    if (!css.includes(className)) throw new Error(`missing CSS ${className}`);
  }
  if (!js.includes("coding_loops")) throw new Error("runtime overview does not render coding loops");
  if (!js.includes("context_capsules")) throw new Error("runtime overview does not render context capsules");
  if (!js.includes("state_errors")) throw new Error("runtime overview does not render persistent state warnings");
  if (!js.includes("recent.slice(0, 20)")) throw new Error("runtime overview does not retain the 20 latest completed calls");
  if (css.includes("radial-gradient(circle at top left")) throw new Error("overview hero still uses the colorful status wash");
});

test("responsive UI keeps dedicated mobile layouts", () => {
  if (!css.includes("@media (max-width: 768px)")) throw new Error("missing tablet/mobile breakpoint");
  if (!css.includes("@media (max-width: 460px)")) throw new Error("missing compact mobile breakpoint");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
