import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { LOCAL_TOOL_CATALOG, SLIM_CHATGPT_TOOLS } from "./tool-profile.js";

export interface RuntimeIdentity {
  run_id: string;
  started_at: string;
  package_version: string;
  build_commit: string | null;
  schema_hash: string;
  previous_schema_hash: string | null;
  schema_changed_since_previous_run: boolean;
  connector_refresh_recommended: boolean;
  tool_profile: string;
  native_tool_count: number;
  slim_tool_count: number;
}

const RUN_ID = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const STARTED_AT = new Date().toISOString();

function packageVersion(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8")) as { version?: string };
    return parsed.version || "unknown";
  } catch {
    return "unknown";
  }
}

function buildCommit(): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      windowsHide: true,
      timeout: 2_000,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

function schemaHash(): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ catalog: LOCAL_TOOL_CATALOG, slim: [...SLIM_CHATGPT_TOOLS].sort(), version: packageVersion() }));
  for (const relative of ["dist/server-factory.js", "dist/tools", "src/server-factory.ts", "src/tools"]) {
    const target = path.resolve(process.cwd(), relative);
    try {
      const stat = fs.statSync(target);
      if (stat.isFile()) {
        hash.update(relative).update(fs.readFileSync(target));
      } else if (stat.isDirectory()) {
        for (const name of fs.readdirSync(target).filter((item) => /\.(?:js|ts)$/.test(item)).sort()) {
          hash.update(`${relative}/${name}`).update(fs.readFileSync(path.join(target, name)));
        }
      }
    } catch {}
  }
  return hash.digest("hex").slice(0, 24);
}

function statePath(scope?: string): string {
  const explicit = process.env.MCP_RUNTIME_IDENTITY_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  if (!scope) return path.join(process.cwd(), ".mcp-state", "runtime-identity.json");
  const key = createHash("sha256").update(path.resolve(scope).toLowerCase()).digest("hex").slice(0, 20);
  return path.join(process.cwd(), ".mcp-state", "runtime-identities", `${key}.json`);
}

const CURRENT_SCHEMA_HASH = schemaHash();
let IDENTITY: RuntimeIdentity = {
  run_id: RUN_ID,
  started_at: STARTED_AT,
  package_version: packageVersion(),
  build_commit: buildCommit(),
  schema_hash: CURRENT_SCHEMA_HASH,
  previous_schema_hash: null,
  schema_changed_since_previous_run: false,
  connector_refresh_recommended: false,
  tool_profile: process.env.CHATGPT_TOOL_PROFILE || "slim",
  native_tool_count: LOCAL_TOOL_CATALOG.length,
  slim_tool_count: SLIM_CHATGPT_TOOLS.size,
};

function readPrevious(target: string): { schema_hash?: string; build_commit?: string | null } | null {
  try {
    return JSON.parse(fs.readFileSync(target, "utf-8")) as { schema_hash?: string; build_commit?: string | null };
  } catch {
    return null;
  }
}

/** Persist runtime identity only from the real server bootstrap, never merely on module import. */
export function initializeRuntimeIdentity(scope: string): RuntimeIdentity {
  const target = statePath(scope);
  const scopedPrevious = readPrevious(target);
  const legacyPath = statePath();
  const legacyPrevious = scopedPrevious ? null : readPrevious(legacyPath);
  const previous = scopedPrevious || legacyPrevious;
  const previousSchemaHash = previous?.schema_hash || null;
  const schemaChanged = Boolean(previousSchemaHash && previousSchemaHash !== CURRENT_SCHEMA_HASH);
  // One-time migration from the old global identity file also uses the commit as a
  // conservative signal because test imports in older builds could overwrite its schema hash.
  const legacyCommitMismatch = Boolean(
    legacyPrevious?.build_commit && IDENTITY.build_commit && legacyPrevious.build_commit !== IDENTITY.build_commit
  );
  IDENTITY = {
    ...IDENTITY,
    previous_schema_hash: previousSchemaHash,
    schema_changed_since_previous_run: schemaChanged,
    connector_refresh_recommended: schemaChanged || legacyCommitMismatch,
  };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(IDENTITY, null, 2) + "\n", "utf-8");
    fs.renameSync(temp, target);
    if (legacyPrevious && legacyPath !== target) fs.rmSync(legacyPath, { force: true });
  } catch {}
  return { ...IDENTITY };
}

export function getRuntimeIdentity(): RuntimeIdentity {
  return { ...IDENTITY };
}
