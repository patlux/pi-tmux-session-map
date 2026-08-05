export type SessionMappingV2 = {
  schema: 2;
  paneKey: string;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  sessionName: string | null;
  updatedAtMs: number;
};

export type SessionMapping = {
  schema: 3;
  paneKey: string;
  paneId: string;
  tmuxServerPid: string;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  sessionName: string | null;
  updatedAtMs: number;
};

export type StructuredSessionMapping = SessionMappingV2 | SessionMapping;

export type ParsedSessionMapping =
  | { format: "structured"; mapping: StructuredSessionMapping }
  | { format: "legacy"; sessionFile: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CommonMappingFields = {
  paneKey: string;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  sessionName: string | null;
  updatedAtMs: number;
};

function hasCommonFields(value: Record<string, unknown>): value is Record<string, unknown> & CommonMappingFields {
  return (
    typeof value.paneKey === "string"
    && typeof value.sessionFile === "string"
    && typeof value.sessionId === "string"
    && typeof value.cwd === "string"
    && (typeof value.sessionName === "string" || value.sessionName === null)
    && typeof value.updatedAtMs === "number"
  );
}

export function buildSessionMapping(
  paneKey: string,
  paneId: string,
  tmuxServerPid: string,
  sessionFile: string,
  sessionId: string,
  cwd: string,
  sessionName: string | null,
  updatedAtMs: number,
): SessionMapping {
  return {
    schema: 3,
    paneKey,
    paneId,
    tmuxServerPid,
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
  if (!isRecord(value) || !hasCommonFields(value)) {
    return undefined;
  }
  if (value.schema === 2) {
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
  if (
    value.schema === 3
    && typeof value.paneId === "string"
    && value.paneId !== ""
    && typeof value.tmuxServerPid === "string"
    && value.tmuxServerPid !== ""
  ) {
    return {
      format: "structured",
      mapping: {
        schema: 3,
        paneKey: value.paneKey,
        paneId: value.paneId,
        tmuxServerPid: value.tmuxServerPid,
        sessionFile: value.sessionFile,
        sessionId: value.sessionId,
        cwd: value.cwd,
        sessionName: value.sessionName,
        updatedAtMs: value.updatedAtMs,
      },
    };
  }
  return undefined;
}

export function mappedSessionFile(content: string): string | undefined {
  const parsed = parseSessionMapping(content);
  if (!parsed) {
    return undefined;
  }
  return parsed.format === "structured" ? parsed.mapping.sessionFile : parsed.sessionFile;
}

export function mappedPaneIdentity(content: string): { paneId: string; tmuxServerPid: string } | undefined {
  const parsed = parseSessionMapping(content);
  if (!parsed || parsed.format !== "structured" || parsed.mapping.schema !== 3) {
    return undefined;
  }
  return {
    paneId: parsed.mapping.paneId,
    tmuxServerPid: parsed.mapping.tmuxServerPid,
  };
}
