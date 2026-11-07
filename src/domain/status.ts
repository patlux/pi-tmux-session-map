import type { WorkState } from "./state.ts";

export type PaneInfo = {
  backend: "tmux" | "zellij" | "mex";
  paneKey: string;
  paneId: string;
  tmuxServerPid: string | null;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
};

export type SessionInfo = {
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
};

export type LiveSessionIdentity = {
  sessionId: string;
  piPid: number;
};

/** Leaf before the run's prompt entry and the run start (agent_start). */
export type RunAnchor = {
  leaf_id: string | null;
  started_at_ms: number;
};

/**
 * Why a session_shutdown happened: a SIGHUP/SIGTERM (terminal closed, tmux server
 * died, reboot), an interactive quit, a reload, or a session replacement.
 */
export type ShutdownCause = "signal" | "quit" | "reload" | "replace";

/**
 * Auto-continue state of this Pi for displays (TWS). `state`: planned, dispatched, admitted, an
 * outcome (done, failed, cancelled, …), uncertain, skipped or stopped; `reason` for skipped and
 * stopped. Slot and deadline come from the released plan; `key` and `ledger_dir` name the ledger
 * entry, where TWS may veto a planned continuation with `<key>.skip`.
 */
export type ContinueStatus = {
  state: string;
  reason: string | null;
  slot_ms: number | null;
  deadline_ms: number | null;
  key: string;
  ledger_dir: string;
};

export type RecoveryEvidence = {
  runAnchor: RunAnchor | null;
  shutdownCause: ShutdownCause | null;
  continueState?: ContinueStatus | null;
};

export type TwsStatusPayload = {
  schema: 1;
  agent: "pi";
  backend: "tmux" | "zellij" | "mex";
  pane_id: string;
  pane_key: string;
  tmux_session_name: string;
  window_index: number;
  pane_index: number;
  cwd: string;
  session_file: string | null;
  session_name: string | null;
  // Additive live identity: valid even before the session JSONL exists.
  session_id: string;
  pi_pid: number;
  tmux_server_pid: string | null;
  state: WorkState;
  updated_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  // Additive recovery evidence for tmux-recovery's auto-continue decision.
  run_anchor: RunAnchor | null;
  shutdown_cause: ShutdownCause | null;
  continue?: ContinueStatus;
};

export function buildTwsStatusPayload(
  pane: PaneInfo,
  session: SessionInfo,
  state: WorkState,
  updatedAtMs: number,
  startedAtMs: number | null,
  finishedAtMs: number | null,
  identity: LiveSessionIdentity,
  evidence: RecoveryEvidence = { runAnchor: null, shutdownCause: null },
): TwsStatusPayload {
  return {
    schema: 1,
    agent: "pi",
    backend: pane.backend,
    pane_id: pane.paneId,
    pane_key: pane.paneKey,
    tmux_session_name: pane.sessionName,
    window_index: pane.windowIndex,
    pane_index: pane.paneIndex,
    cwd: session.cwd,
    session_file: session.sessionFile,
    session_name: session.sessionName,
    session_id: identity.sessionId,
    pi_pid: identity.piPid,
    tmux_server_pid: pane.tmuxServerPid,
    state,
    updated_at_ms: updatedAtMs,
    started_at_ms: startedAtMs,
    finished_at_ms: finishedAtMs,
    run_anchor: evidence.runAnchor,
    shutdown_cause: state === "shutdown" ? evidence.shutdownCause : null,
    ...(evidence.continueState ? { continue: evidence.continueState } : {}),
  };
}

export function serializeStatusPayload(payload: TwsStatusPayload): string {
  return `${JSON.stringify(payload)}\n`;
}
