import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function tempPath(target: string): string {
  return `${target}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
}

async function existingMode(target: string): Promise<number | undefined> {
  try {
    return (await fs.stat(target)).mode & 0o777;
  } catch {
    return undefined;
  }
}

function existingModeSync(target: string): number | undefined {
  try {
    return fsSync.statSync(target).mode & 0o777;
  } catch {
    return undefined;
  }
}

export async function atomicWriteText(
  targetPath: string,
  content: string,
  options?: { mode?: number }
): Promise<void> {
  const target = path.resolve(targetPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = tempPath(target);
  const mode = options?.mode ?? await existingMode(target);
  try {
    await fs.writeFile(temp, content, {
      encoding: "utf-8",
      ...(mode === undefined ? {} : { mode }),
    });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export function atomicWriteTextSync(
  targetPath: string,
  content: string,
  options?: { mode?: number }
): void {
  const target = path.resolve(targetPath);
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  const temp = tempPath(target);
  const mode = options?.mode ?? existingModeSync(target);
  try {
    fsSync.writeFileSync(temp, content, {
      encoding: "utf-8",
      ...(mode === undefined ? {} : { mode }),
    });
    fsSync.renameSync(temp, target);
  } finally {
    try { fsSync.rmSync(temp, { force: true }); } catch {}
  }
}