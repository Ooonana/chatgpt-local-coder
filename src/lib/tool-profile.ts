import fs from "fs";
import path from "path";

export type ToolProfileName = "full" | "slim";

/**
 * Every native tool declared under src/tools. Keep this catalog in sync with
 * server.registerTool() declarations; scripts/test-tool-profile.mjs verifies
 * the two sets are identical so the Admin UI/profile overrides cannot drift.
 */
export const LOCAL_TOOL_CATALOG = [
  // Filesystem
  "read_text_file",
  "read_files",
  "read_file_base64",
  "write_file",
  "write_file_base64",
  "edit_file",
  "multi_edit",
  "replace_regex",
  "apply_patch",
  "list_directory",
  "glob",
  "grep",
  "delete_file",
  "create_directory",
  "delete_directory",
  "copy_file",
  "move_file",
  "search_files",
  "directory_tree",
  "list_allowed_directories",

  // Shell / processes
  "run_command",
  "run_commands_parallel",
  "shell_status",
  "shell_reset",
  "start_process",
  "process_status",
  "process_history",
  "process_output",
  "process_input",
  "stop_process",
  "clear_processes",
  "pty",

  // Git
  "git_status",
  "git_diff",
  "git_log",
  "git_worktree",
  "git_add",
  "git_commit",
  "git_branch",
  "git_checkout",
  "git_restore",
  "git_push",
  "git_pull",
  "git_stash",
  "git_reset",

  // Context / agent state
  "list_skills",
  "load_skill",
  "project_context",
  "agent_status",
  "remember",
  "load_path_rules",
  "agent_task",
  "inspect_project",
  "verify_project",
  "repo_intel",
  "edit_transaction",
  "coding_loop_status",
  "coding_loop",
  "context_capsule",
  "subagent",
  "delegate_status",
  "node_repl",
  "ponytail_turn",
  "rewind",
  "view_image",
  "lsp",

  // Upstream MCP bridge
  "mcp_servers",
  "mcp_tools",
  "mcp_call",
] as const;

export type LocalToolName = (typeof LOCAL_TOOL_CATALOG)[number];
export const LOCAL_TOOL_COUNT = LOCAL_TOOL_CATALOG.length;

interface LocalToolOverrides {
  enabled?: string[];
  disabled?: string[];
}

const overridesPath = () => path.resolve(process.cwd(), "profiles", "tool-overrides.json");

function sanitizeLocalToolOverrides(next: LocalToolOverrides): LocalToolOverrides {
  const known = new Set<string>(LOCAL_TOOL_CATALOG);
  const clean = (names: string[] | undefined) =>
    [...new Set((names ?? []).filter((name) => known.has(name)))];
  const enabled = clean(next.enabled);
  const disabled = clean(next.disabled).filter((name) => !enabled.includes(name));
  return { enabled, disabled };
}

export function getLocalToolOverrides(): LocalToolOverrides {
  try {
    return sanitizeLocalToolOverrides(
      JSON.parse(fs.readFileSync(overridesPath(), "utf-8")) as LocalToolOverrides
    );
  } catch {
    return {};
  }
}

export function saveLocalToolOverrides(next: LocalToolOverrides): void {
  const sanitized = sanitizeLocalToolOverrides(next);
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(sanitized, null, 2) + "\n");
}

/** Core tools for the ChatGPT app — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "read_files",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "delete_file",
  "run_command",
  "run_commands_parallel",
  "shell_status",
  "start_process",
  "process_status",
  "process_history",
  "process_output",
  "process_input",
  "stop_process",
  "pty",
  "git_status",
  "git_diff",
  "git_worktree",
  "git_add",
  "git_commit",
  "git_restore",
  "agent_status",
  "project_context",
  "agent_task",
  "inspect_project",
  "verify_project",
  "repo_intel",
  "edit_transaction",
  "coding_loop_status",
  "coding_loop",
  "context_capsule",
  "subagent",
  "delegate_status",
  "remember",
  "load_path_rules",
  "list_skills",
  "load_skill",
  "rewind",
  "view_image",
  "lsp",
  "mcp_servers",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  const overrides = getLocalToolOverrides();
  if ((overrides.disabled ?? []).includes(name)) return false;
  if (profile === "full") return true;
  return SLIM_CHATGPT_TOOLS.has(name) || (overrides.enabled ?? []).includes(name);
}
