import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let atomicWriteCounter = 0;

export type CleanupResult = {
  scanned: number;
  removed: number;
};

export async function ensureDirectory(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
}

function nextTempPath(file: string): string {
  atomicWriteCounter += 1;
  return join(dirname(file), `${basename(file)}.tmp-${process.pid}-${atomicWriteCounter}`);
}

export async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = nextTempPath(file);
  let renamed = false;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tmp, { force: true });
    }
  }
}

export async function cleanupStaleTempFiles(
  dir: string,
  maxAgeMs: number,
  nowMs = Date.now(),
): Promise<CleanupResult> {
  if (maxAgeMs <= 0) {
    return { scanned: 0, removed: 0 };
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { scanned: 0, removed: 0 };
  }

  let scanned = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.includes(".tmp-")) {
      continue;
    }
    scanned += 1;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (nowMs - info.mtimeMs <= maxAgeMs) {
        continue;
      }
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup only.
    }
  }
  return { scanned, removed };
}

export async function cleanupSupersededStatusFiles(
  dir: string,
  currentFileName: string,
  paneId: string,
): Promise<CleanupResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { scanned: 0, removed: 0 };
  }

  let scanned = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === currentFileName) {
      continue;
    }
    scanned += 1;
    const path = join(dir, entry);
    try {
      const payload = JSON.parse(await readFile(path, "utf8"));
      if (payload?.pane_id !== paneId) {
        continue;
      }
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup only; malformed files are ignored here and skipped
      // by tws when read.
    }
  }
  return { scanned, removed };
}

export async function cleanupStaleSessionMappings(
  dir: string,
  maxAgeMs: number,
  nowMs = Date.now(),
): Promise<CleanupResult> {
  if (maxAgeMs <= 0) {
    return { scanned: 0, removed: 0 };
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { scanned: 0, removed: 0 };
  }

  let scanned = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".session")) {
      continue;
    }
    scanned += 1;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (nowMs - info.mtimeMs <= maxAgeMs) {
        continue;
      }

      const sessionFile = (await readFile(path, "utf8")).split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (sessionFile !== "") {
        try {
          await stat(sessionFile);
          continue;
        } catch {
          // Missing target session file means the mapping is stale.
        }
      }

      await rm(path, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup only.
    }
  }
  return { scanned, removed };
}
