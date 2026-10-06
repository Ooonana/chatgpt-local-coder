import path from "node:path";

/**
 * Normalize a local path for identity comparisons without changing the path
 * returned to callers. Windows path identity is case-insensitive.
 */
export function normalizedPathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function sameResolvedPath(left: string, right: string): boolean {
  return normalizedPathIdentity(left) === normalizedPathIdentity(right);
}

/**
 * Lexically test whether target is root itself or a descendant. A child named
 * "..cache" is valid; only the actual ".." path segment escapes the root.
 */
export function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = normalizedPathIdentity(root);
  const normalizedTarget = normalizedPathIdentity(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}