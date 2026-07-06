import type { WorkState } from "./state.ts";

export type PaneInfo = {
  paneKey: string;
  paneId: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
};

export type SessionInfo = {
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
};

export type TwsStatusPayload = {
  schema: 1;
  agent: "pi";
  pane_id: string;
  pane_key: string;
  tmux_session_name: string;
  window_index: number;
  pane_index: number;
  cwd: string;
  session_file: string | null;
  session_name: string | null;
  state: WorkState;
  updated_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
};

export function buildTwsStatusPayload(
  pane: PaneInfo,
  session: SessionInfo,
  state: WorkState,
  updatedAtMs: number,
  startedAtMs: number | null,
  finishedAtMs: number | null,
): TwsStatusPayload {
  return {
    schema: 1,
    agent: "pi",
    pane_id: pane.paneId,
    pane_key: pane.paneKey,
    tmux_session_name: pane.sessionName,
    window_index: pane.windowIndex,
    pane_index: pane.paneIndex,
    cwd: session.cwd,
    session_file: session.sessionFile,
    session_name: session.sessionName,
    state,
    updated_at_ms: updatedAtMs,
    started_at_ms: startedAtMs,
    finished_at_ms: finishedAtMs,
  };
}

export function serializeStatusPayload(payload: TwsStatusPayload): string {
  return `${JSON.stringify(payload)}\n`;
}
