import { normalizePaneKey } from "./pane-key.ts";
import type { PaneInfo } from "./status.ts";

export function parseTmuxIndex(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePaneInfoOutput(stdout: string, paneId: string): PaneInfo | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return undefined;
  }

  const [rawPaneKey, sessionName, rawWindowIndex, rawPaneIndex] = trimmed.split("\t");
  const paneKey = normalizePaneKey(rawPaneKey ?? "");
  if (!paneKey || !sessionName) {
    return undefined;
  }

  return {
    backend: "tmux",
    paneKey,
    paneId,
    sessionName,
    windowIndex: parseTmuxIndex(rawWindowIndex ?? "0"),
    paneIndex: parseTmuxIndex(rawPaneIndex ?? "0"),
  };
}

type ZellijPane = {
  id?: unknown;
  is_plugin?: unknown;
  tab_position?: unknown;
};

function isZellijPane(value: unknown): value is ZellijPane {
  return typeof value === "object" && value !== null;
}

export function parseZellijPaneInfo(
  stdout: string,
  sessionName: string,
  paneId: string,
): PaneInfo | undefined {
  if (!sessionName || !paneId) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const numericId = Number.parseInt(paneId, 10);
  if (!Number.isFinite(numericId)) {
    return undefined;
  }
  const pane = raw.find(
    (entry) => isZellijPane(entry) && entry.is_plugin !== true && entry.id === numericId,
  );
  if (!isZellijPane(pane)) {
    return undefined;
  }
  const tabPosition = typeof pane.tab_position === "number" ? pane.tab_position : 0;
  const normalizedPaneId = `terminal_${numericId}`;
  return {
    backend: "zellij",
    paneKey: `${sessionName}:${tabPosition}.${numericId}`,
    paneId: normalizedPaneId,
    sessionName,
    windowIndex: tabPosition,
    paneIndex: numericId,
  };
}
