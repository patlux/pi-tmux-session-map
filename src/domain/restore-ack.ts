import { join } from "node:path";

import type { PaneInfo, SessionInfo } from "./status.ts";

export type RestoreExpectation = {
  token: string;
  paneKey: string;
  sessionId: string;
  sessionFile: string;
  ackDir: string;
};

export type RestoreAck = {
  schema: 1;
  status: "resumed" | "mismatch";
  token: string;
  expectedPaneKey: string;
  actualPaneKey: string;
  expectedSessionId: string;
  actualSessionId: string;
  expectedSessionFile: string;
  actualSessionFile: string | null;
  cwd: string;
  sessionName: string | null;
  reason: string;
  acknowledgedAtMs: number;
};

export function restoreExpectationFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RestoreExpectation | undefined {
  const token = env.PI_TMUX_RESTORE_TOKEN;
  const paneKey = env.PI_TMUX_EXPECTED_PANE;
  const sessionId = env.PI_TMUX_EXPECTED_SESSION_ID;
  const sessionFile = env.PI_TMUX_EXPECTED_SESSION_FILE;
  const ackDir = env.PI_TMUX_RESTORE_ACK_DIR;
  if (!token || !paneKey || !sessionId || !sessionFile || !ackDir) {
    return undefined;
  }
  return { token, paneKey, sessionId, sessionFile, ackDir };
}

export function buildRestoreAck(
  expectation: RestoreExpectation,
  pane: PaneInfo,
  session: SessionInfo,
  sessionId: string,
  reason: string,
  acknowledgedAtMs: number,
): RestoreAck {
  const matches = pane.paneKey === expectation.paneKey
    && sessionId === expectation.sessionId
    && session.sessionFile === expectation.sessionFile;
  return {
    schema: 1,
    status: matches ? "resumed" : "mismatch",
    token: expectation.token,
    expectedPaneKey: expectation.paneKey,
    actualPaneKey: pane.paneKey,
    expectedSessionId: expectation.sessionId,
    actualSessionId: sessionId,
    expectedSessionFile: expectation.sessionFile,
    actualSessionFile: session.sessionFile,
    cwd: session.cwd,
    sessionName: session.sessionName,
    reason,
    acknowledgedAtMs,
  };
}

export function restoreAckPath(expectation: RestoreExpectation): string {
  return join(expectation.ackDir, `${expectation.token}.json`);
}

export function serializeRestoreAck(ack: RestoreAck): string {
  return `${JSON.stringify(ack)}\n`;
}
