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
    paneKey,
    paneId,
    sessionName,
    windowIndex: parseTmuxIndex(rawWindowIndex ?? "0"),
    paneIndex: parseTmuxIndex(rawPaneIndex ?? "0"),
  };
}
