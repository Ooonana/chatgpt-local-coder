import { canonicalizePotentialPath, validatePath } from "./path-security.js";
import { detectProjectRoot, isProjectRoot } from "./project-affinity.js";
import { getCurrentSessionState } from "./session-context.js";
import { sameResolvedPath } from "./path-identity.js";

export interface WorkspaceScope {
  scoped: boolean;
  projectRoot: string | null;
}

export async function canonicalProjectRootForPath(inputPath: string): Promise<string | null> {
  const canonical = await canonicalizePotentialPath(inputPath);
  const root = await detectProjectRoot(canonical).catch(() => canonical);
  if (!(await isProjectRoot(root).catch(() => false))) return null;
  return await canonicalizePotentialPath(root);
}

export async function resolveWorkspaceScope(workspace?: string): Promise<WorkspaceScope> {
  if (workspace) {
    const validated = await validatePath(workspace);
    return { scoped: true, projectRoot: await canonicalProjectRootForPath(validated) };
  }
  const session = getCurrentSessionState();
  if (session?.workspace_kind === "project" && session.project_root) {
    return {
      scoped: true,
      projectRoot: await canonicalProjectRootForPath(session.project_root) || await canonicalizePotentialPath(session.project_root),
    };
  }
  if (session?.workspace_kind === "machine") return { scoped: true, projectRoot: null };
  return { scoped: false, projectRoot: null };
}

export function sameProjectRoot(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return left == null && right == null;
  return sameResolvedPath(left, right);
}