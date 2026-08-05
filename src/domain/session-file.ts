import { open } from "node:fs/promises";

export type SessionHeader = {
  id: string;
  cwd: string;
  version: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSessionHeader(line: string): SessionHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value)
    || value.type !== "session"
    || typeof value.id !== "string"
    || value.id === ""
    || typeof value.cwd !== "string"
    || value.cwd === ""
    || typeof value.version !== "number"
    || !Number.isInteger(value.version)
    || value.version < 1
    || value.version > 3
  ) {
    return undefined;
  }
  return { id: value.id, cwd: value.cwd, version: value.version };
}

export async function readSessionHeader(path: string): Promise<SessionHeader | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
    return parseSessionHeader(firstLine);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function sessionFileMatches(path: string, sessionId: string): Promise<boolean> {
  const header = await readSessionHeader(path);
  return header?.id === sessionId;
}
