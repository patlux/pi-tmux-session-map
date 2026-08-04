import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRestoreAck, restoreAckPath, restoreExpectationFromEnvironment } from "../src/domain/restore-ack.ts";

const pane = {
  backend: "tmux" as const,
  paneKey: "tws_project_main:1.0",
  paneId: "%42",
  sessionName: "tws_project_main",
  windowIndex: 1,
  paneIndex: 0,
};

const session = {
  cwd: "/tmp/project",
  sessionFile: "/tmp/session.jsonl",
  sessionName: "Recovery fixture",
};

test("restore acknowledgement proves exact pane and session identity", () => {
  const expectation = {
    token: "token-1",
    paneKey: pane.paneKey,
    sessionId: "session-id",
    sessionFile: "/tmp/session.jsonl",
    ackDir: "/tmp/acks",
  };
  const ack = buildRestoreAck(expectation, pane, session, "session-id", "startup", 1234);
  assert.equal(ack.status, "resumed");
  assert.equal(ack.actualSessionId, "session-id");
  assert.equal(restoreAckPath(expectation), "/tmp/acks/token-1.json");
});

test("restore acknowledgement reports mismatch instead of false success", () => {
  const expectation = {
    token: "token-2",
    paneKey: "other:1.0",
    sessionId: "expected-id",
    sessionFile: "/tmp/expected.jsonl",
    ackDir: "/tmp/acks",
  };
  const ack = buildRestoreAck(expectation, pane, session, "actual-id", "startup", 1234);
  assert.equal(ack.status, "mismatch");
  assert.equal(ack.actualPaneKey, pane.paneKey);
  assert.equal(ack.actualSessionFile, session.sessionFile);
});

test("restore expectation requires the complete environment contract", () => {
  assert.equal(restoreExpectationFromEnvironment({ PI_TMUX_RESTORE_TOKEN: "partial" }), undefined);
  assert.deepEqual(restoreExpectationFromEnvironment({
    PI_TMUX_RESTORE_TOKEN: "token",
    PI_TMUX_EXPECTED_PANE: pane.paneKey,
    PI_TMUX_EXPECTED_SESSION_ID: "session-id",
    PI_TMUX_EXPECTED_SESSION_FILE: "/tmp/session.jsonl",
    PI_TMUX_RESTORE_ACK_DIR: "/tmp/acks",
  }), {
    token: "token",
    paneKey: pane.paneKey,
    sessionId: "session-id",
    sessionFile: "/tmp/session.jsonl",
    ackDir: "/tmp/acks",
  });
});
