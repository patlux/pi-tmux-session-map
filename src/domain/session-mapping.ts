export type SessionMapping = {
  schema: 2;
  paneKey: string;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  sessionName: string | null;
  updatedAtMs: number;
};

export type ParsedSessionMapping =
  | { format: "structured"; mapping: SessionMapping }
  | { format: "legacy"; sessionFile: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildSessionMapping(
  paneKey: string,
  sessionFile: string,
  sessionId: string,
  cwd: string,
  sessionName: string | null,
  updatedAtMs: number,
): SessionMapping {
  return {
    schema: 2,
    paneKey,
    sessionFile,
    sessionId,
    cwd,
    sessionName,
    updatedAtMs,
  };
}

export function serializeSessionMapping(mapping: SessionMapping): string {
  return `${JSON.stringify(mapping)}\n`;
}

export function parseSessionMapping(content: string): ParsedSessionMapping | undefined {
  const trimmed = content.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!trimmed.startsWith("{")) {
    return { format: "legacy", sessionFile: trimmed.split(/\r?\n/, 1)[0] ?? "" };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value)
    || value.schema !== 2
    || typeof value.paneKey !== "string"
    || typeof value.sessionFile !== "string"
    || typeof value.sessionId !== "string"
    || typeof value.cwd !== "string"
    || !(typeof value.sessionName === "string" || value.sessionName === null)
    || typeof value.updatedAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    format: "structured",
    mapping: {
      schema: 2,
      paneKey: value.paneKey,
      sessionFile: value.sessionFile,
      sessionId: value.sessionId,
      cwd: value.cwd,
      sessionName: value.sessionName,
      updatedAtMs: value.updatedAtMs,
    },
  };
}

export function mappedSessionFile(content: string): string | undefined {
  const parsed = parseSessionMapping(content);
  if (!parsed) {
    return undefined;
  }
  return parsed.format === "structured" ? parsed.mapping.sessionFile : parsed.sessionFile;
}
