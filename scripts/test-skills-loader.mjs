import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSkillControls, saveSkillControls, loadProjectSkills, loadProjectSkill,
} from "../dist/lib/skills-loader.js";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-skills-"));
const oldDirs = process.env.LOCAL_CODER_SKILL_DIRS;
const oldPermissions = process.env.PERMISSIONS_CONFIG;
const oldGlobalSkillControls = process.env.LOCAL_CODER_GLOBAL_SKILLS_CONFIG;
try {
  process.env.LOCAL_CODER_GLOBAL_SKILLS_CONFIG = path.join(temporary, "global-controls.json");
  const project = path.join(temporary, "project");
  const extra = path.join(temporary, "extra");
  async function add(folder, name, description) {
    const location = path.join(folder, name);
    await fs.mkdir(location, { recursive: true });
    await fs.writeFile(path.join(location, "SKILL.md"), [
      "---", "name: " + name, "description: " + description, "---",
      "", "# " + name, "",
    ].join("\n"));
  }
  await add(path.join(project, ".agents", "skills"), "priority", "Project wins");
  await add(path.join(project, ".claude", "skills"), "priority", "Should be shadowed");
  await add(path.join(project, ".codex", "skills"), "codex-skill", "Codex project skill");
  await add(path.join(project, ".agents", "skills", "group"), "nested-skill", "Nested skill");
  await add(extra, "priority", "Global should be shadowed");
  await add(extra, "global-skill", "Configured global skill");
  process.env.LOCAL_CODER_SKILL_DIRS = extra;

  const found = await loadProjectSkills(project);
  assert.equal(found.filter((x) => x.name === "priority").length, 1);
  assert.equal(found.find((x) => x.name === "priority")?.source, "project");
  assert.equal(found.find((x) => x.name === "priority")?.description, "Project wins");
  assert.equal(found.find((x) => x.name === "nested-skill")?.source, "project");
  assert.equal(found.find((x) => x.name === "codex-skill")?.source, "project");
  assert.equal(found.find((x) => x.name === "global-skill")?.source, "global");
  const loaded = await loadProjectSkill(project, "global-skill");
  assert.match(loaded.content, /Configured global skill/);
  const referenceFolder = path.join(project, ".agents", "skills", "priority", "references");
  await fs.mkdir(referenceFolder);
  await fs.writeFile(path.join(referenceFolder, "howto.md"), "# Reference\nLong reference instructions\n");
  const ref = await loadProjectSkill(project, "priority", 500, "references/howto.md");
  assert.equal(ref.reference_only, true);
  assert.equal(ref.content, "");
  assert.match(ref.references[0].content, /Long reference instructions/);
  assert.equal(ref.truncated, false);
  const shortRef = await loadProjectSkill(project, "priority", 7, "references/howto.md");
  assert.equal(shortRef.truncated, true);
  assert.equal(shortRef.references[0].content.length, 7);
  await assert.rejects(loadProjectSkill(project, "priority", 100, "../missing.md"), /inside its skill directory/);
  await assert.rejects(loadProjectSkill(project, "priority", 100, "references/../missing.json"), /\.md or \.txt file/);
  const external = path.join(temporary, "external.md");
  await fs.writeFile(external, "Outside skill directory");
  try {
    await fs.symlink(external, path.join(referenceFolder, "external.md"));
    await assert.rejects(loadProjectSkill(project, "priority", 100, "references/external.md"), /inside its skill directory/);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  }
  await assert.rejects(loadProjectSkill(project, "missing"), /Unknown project skill/);
  await saveSkillControls(project, "project", { version: 1, disabled: ["priority"] });
  assert.deepEqual((await getSkillControls(project, "project")).disabled, ["priority"]);
  assert.equal((await loadProjectSkills(project)).some((skill) => skill.name === "priority"), false);
  assert.equal((await loadProjectSkills(project, true)).find((skill) => skill.name === "priority")?.enabled, false);
  await saveSkillControls(project, "project", { version: 1, disabled: [] });
  await saveSkillControls(project, "global", { version: 1, disabled: ["global-skill"] });
  assert.equal((await loadProjectSkills(project)).some((skill) => skill.name === "global-skill"), false);
  await assert.rejects(loadProjectSkill(project, "global-skill"), /Unknown project skill/);
  await saveSkillControls(project, "global", { version: 1, disabled: [] });
  await assert.rejects(
    saveSkillControls(project, "project", { version: 1, disabled: [""] }), /Invalid skill controls/
  );
  await fs.writeFile(process.env.LOCAL_CODER_GLOBAL_SKILLS_CONFIG, '{"version":1,"disabled":"broken"}');
  await assert.rejects(loadProjectSkills(project), /Invalid skill controls/);
  await saveSkillControls(project, "global", { version: 1, disabled: [] });
  const permissionFile = path.join(temporary, "permissions.json");
  await fs.writeFile(permissionFile, JSON.stringify({
    version: 1,
    profile: "workspace",
    path_roots: [project],
  }));
  process.env.PERMISSIONS_CONFIG = permissionFile;
  await assert.rejects(saveSkillControls(project, "global", { version: 1, disabled: ["priority"] }), /Permission denied/);
  const scoped = await loadProjectSkills(project);
  assert.equal(scoped.some((skill) => skill.name === "global-skill"), false);
  assert.equal(scoped.some((skill) => skill.name === "priority"), true);
  await assert.rejects(loadProjectSkill(project, "global-skill"), /Unknown project skill/);
  console.log("OK  Agent Skills discovery, precedence, safe references and project/global controls");
} finally {
  if (oldDirs === undefined) delete process.env.LOCAL_CODER_SKILL_DIRS;
  else process.env.LOCAL_CODER_SKILL_DIRS = oldDirs;
  if (oldPermissions === undefined) delete process.env.PERMISSIONS_CONFIG;
  else process.env.PERMISSIONS_CONFIG = oldPermissions;
  if (oldGlobalSkillControls === undefined) delete process.env.LOCAL_CODER_GLOBAL_SKILLS_CONFIG;
  else process.env.LOCAL_CODER_GLOBAL_SKILLS_CONFIG = oldGlobalSkillControls;
  await fs.rm(temporary, { recursive: true, force: true });
}