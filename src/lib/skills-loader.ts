import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveComputerUseSkillPath } from "./plugin-config.js";
import { validatePath } from "./path-security.js";
import { requireWriteAllowed } from "./permissions.js";
import { atomicWriteText } from "./atomic-file.js";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source?: "project" | "global" | "plugin";
  enabled?: boolean;
}

export type SkillControlScope = "project" | "global";
export interface SkillControls {
  version: 1;
  disabled: string[];
}

function controlsPath(workspaceRoot: string, scope: SkillControlScope): string {
  return scope === "project"
    ? path.join(workspaceRoot, ".local-coder", "skills.json")
    : path.resolve(process.env.LOCAL_CODER_GLOBAL_SKILLS_CONFIG?.trim() ||
        path.join(os.homedir(), ".local-coder", "skills.json"));
}

function normalizeSkillControls(raw: unknown): SkillControls {
  if (!raw || typeof raw !== "object" ||
    (raw as Record<string, unknown>).version !== 1 ||
    !Array.isArray((raw as Record<string, unknown>).disabled)) {
    throw new Error("Invalid skill controls: expected version=1 and a disabled array");
  }
  const names = (raw as { disabled: unknown[] }).disabled;
  if (names.length > 512 || names.some((value) =>
    typeof value !== "string" || value.length > 200 || !value.trim())) {
    throw new Error("Invalid skill controls: disabled must contain up to 512 nonempty names");
  }
  return { version: 1, disabled: [...new Set((names as string[]).map((name) => name.trim()))] };
}

export async function getSkillControls(workspaceRoot: string, scope: SkillControlScope): Promise<SkillControls> {
  try {
    return normalizeSkillControls(JSON.parse(await fs.readFile(controlsPath(workspaceRoot, scope), "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, disabled: [] };
    throw error;
  }
}

export async function saveSkillControls(
  workspaceRoot: string, scope: SkillControlScope, raw: SkillControls
): Promise<SkillControls> {
  const controls = normalizeSkillControls(raw);
  const target = await validatePath(controlsPath(workspaceRoot, scope));
  requireWriteAllowed(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteText(target, JSON.stringify(controls, null, 2) + "\n");
  return controls;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export async function loadProjectSkills(workspaceRoot: string, includeDisabled = false): Promise<SkillSummary[]> {
  const out: SkillSummary[] = [];
  const seenNames = new Set<string>();
  const [globalControls, projectControls] = await Promise.all([
    getSkillControls(workspaceRoot, "global"),
    getSkillControls(workspaceRoot, "project"),
  ]);
  const disabled = new Set([...globalControls.disabled, ...projectControls.disabled]);
  const locations: Array<{ dir: string; source: "project" | "global" }> = [
    ...[".agents", ".claude", ".codex"].map((folder) => ({ dir: path.join(workspaceRoot, folder, "skills"), source: "project" as const })),
    ...[".agents", ".claude", ".codex"].map((folder) => ({ dir: path.join(os.homedir(), folder, "skills"), source: "global" as const })),
    ...(process.env.LOCAL_CODER_SKILL_DIRS || "").split(path.delimiter).filter(Boolean)
      .map((dir) => ({ dir: path.resolve(dir), source: "global" as const })),
  ];
  const visited = new Set<string>();

  async function walk(dir: string, depth: number, source: "project" | "global"): Promise<void> {
    if (depth > 3) return;
    const canonical = await fs.realpath(dir).catch(() => undefined);
    if (!canonical || visited.has(canonical)) return;
    visited.add(canonical);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(full, "SKILL.md");
        try {
          await validatePath(skillFile);
          const content = await fs.readFile(skillFile, "utf-8");
          const fm = parseFrontmatter(content);
          const name = fm.name || entry.name;
          const description = fm.description || content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || name;
          if (!seenNames.has(name)) {
            seenNames.add(name);
            if (includeDisabled || !disabled.has(name)) {
              out.push({ name, description: description.slice(0, 200), path: skillFile, source, enabled: !disabled.has(name) });
            }
          }
        } catch {
          await walk(full, depth + 1, source);
        }
      }
    }
  }

  for (const location of locations) await walk(location.dir, 0, location.source);
  const computerUseSkill = await resolveComputerUseSkillPath();
  if (computerUseSkill) {
    try {
      await validatePath(computerUseSkill);
      const content = await fs.readFile(computerUseSkill, "utf-8");
      const frontmatter = parseFrontmatter(content);
      const name = frontmatter.name || "computer-use";
      if (!seenNames.has(name)) {
        if (includeDisabled || !disabled.has(name)) {
          out.push({
            name,
            description: (frontmatter.description || "Control Windows apps from ChatGPT").slice(0, 200),
            path: computerUseSkill,
            source: "plugin",
            enabled: !disabled.has(name),
          });
        }
      }
    } catch {
      // An unavailable or unauthorized optional plugin should not break skills.
    }
  }
  return out;
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills",
    `${skills.length} skills are available. Call list_skills, then load_skill(name) before applying a matching workflow; do not guess a skill body from its name.`,
    skills.some((skill) => skill.name === "computer-use" && skill.source === "plugin") ? "Computer Use plugin is enabled: load_skill(\"computer-use\") before any Windows UI automation." : "",
  ].join("\n");
}

function assertInsideDirectory(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Skill reference must be inside its skill directory");
  }
}

async function readSkillReference(skillFile: string, referencePath: string, maxBytes: number) {
  if (!referencePath.trim() || path.isAbsolute(referencePath) || referencePath.includes("\0")) {
    throw new Error("Skill reference must be a relative text file");
  }
  const root = await fs.realpath(path.dirname(skillFile));
  const candidate = path.resolve(root, referencePath);
  assertInsideDirectory(root, candidate);
  if (!/\.(?:md|txt)$/i.test(candidate)) {
    throw new Error("Skill reference must be a .md or .txt file");
  }
  const realCandidate = await fs.realpath(candidate);
  assertInsideDirectory(root, realCandidate);
  await validatePath(realCandidate);
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) throw new Error("Skill reference must be a regular file");
  const file = await fs.open(realCandidate, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return {
      path: realCandidate,
      content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf-8"),
      truncated: stat.size > maxBytes || bytesRead > maxBytes,
    };
  } finally {
    await file.close();
  }
}

export async function loadProjectSkill(
  workspaceRoot: string,
  name: string,
  maxBytes = 200_000,
  referencePath?: string
): Promise<{
  skill: SkillSummary;
  content: string;
  truncated: boolean;
  reference_only?: boolean;
  references?: Array<{ path: string; content: string; truncated: boolean }>;
}> {
  const skill = (await loadProjectSkills(workspaceRoot)).find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Unknown project skill: ${name}`);
  await validatePath(skill.path);
  if (referencePath !== undefined) {
    const reference = await readSkillReference(skill.path, referencePath, maxBytes);
    return {
      skill,
      content: "",
      truncated: reference.truncated,
      reference_only: true,
      references: [reference],
    };
  }
  const data = await fs.readFile(skill.path);
  const content = data.subarray(0, maxBytes).toString("utf-8");
  let remaining = maxBytes - Buffer.byteLength(content);
  let truncated = data.length > maxBytes;
  const references: Array<{ path: string; content: string; truncated: boolean }> = [];

  if (skill.source === "plugin" && skill.name === "computer-use" && remaining > 0) {
    const pluginRoot = path.resolve(path.dirname(skill.path), "..", "..");
    for (const file of ["guidance.md", "api.md", "confirmations.md"]) {
      const referencePath = path.join(pluginRoot, "docs", file);
      try {
        const reference = await fs.readFile(referencePath);
        const referenceContent = reference.subarray(0, remaining).toString("utf-8");
        const referenceTruncated = reference.length > remaining;
        references.push({ path: referencePath, content: referenceContent, truncated: referenceTruncated });
        remaining -= Buffer.byteLength(referenceContent);
        truncated ||= referenceTruncated;
        if (remaining <= 0) break;
      } catch {
        // A Codex version may omit an optional Computer Use reference document.
      }
    }
  }

  return {
    skill,
    content,
    truncated,
    ...(references.length ? { references } : {}),
  };
}
