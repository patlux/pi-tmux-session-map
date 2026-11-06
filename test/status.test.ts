import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTwsStatusPayload, serializeStatusPayload } from "../src/domain/status.ts";

test("buildTwsStatusPayload maps pane and session metadata", () => {
  const payload = buildTwsStatusPayload(
    {
      backend: "tmux",
      paneKey: "tws_proj:1.0",
      paneId: "%42",
      tmuxServerPid: "89538",
      sessionName: "tws_proj",
      windowIndex: 1,
      paneIndex: 0,
    },
    {
      cwd: "/tmp/project",
      sessionFile: "/tmp/session.jsonl",
      sessionName: "Review plugin",
    },
    "done",
    2000,
    1000,
    2000,
    { sessionId: "saved-session", piPid: 321 },
  );

  assert.deepEqual(payload, {
    schema: 1,
    agent: "pi",
    backend: "tmux",
    pane_id: "%42",
    pane_key: "tws_proj:1.0",
    tmux_session_name: "tws_proj",
    window_index: 1,
    pane_index: 0,
    cwd: "/tmp/project",
    session_file: "/tmp/session.jsonl",
    session_name: "Review plugin",
    session_id: "saved-session",
    pi_pid: 321,
    tmux_server_pid: "89538",
    state: "done",
    updated_at_ms: 2000,
    started_at_ms: 1000,
    finished_at_ms: 2000,
    run_anchor: null,
    shutdown_cause: null,
  });
});

test("buildTwsStatusPayload maps mex pane metadata", () => {
  const payload = buildTwsStatusPayload(
    {
      backend: "mex",
      paneKey: "mex:19fb891d9de001",
      paneId: "19fb891d9de001",
      tmuxServerPid: null,
      sessionName: "19fb891d9de001",
      windowIndex: 0,
      paneIndex: 0,
    },
    {
      cwd: "/tmp/project",
      sessionFile: "/tmp/session.jsonl",
      sessionName: "Review plugin",
    },
    "working",
    3000,
    1000,
    null,
    { sessionId: "mex-session", piPid: 654 },
  );

  assert.deepEqual(payload, {
    schema: 1,
    agent: "pi",
    backend: "mex",
    pane_id: "19fb891d9de001",
    pane_key: "mex:19fb891d9de001",
    tmux_session_name: "19fb891d9de001",
    window_index: 0,
    pane_index: 0,
    cwd: "/tmp/project",
    session_file: "/tmp/session.jsonl",
    session_name: "Review plugin",
    session_id: "mex-session",
    pi_pid: 654,
    tmux_server_pid: null,
    state: "working",
    updated_at_ms: 3000,
    started_at_ms: 1000,
    finished_at_ms: null,
    run_anchor: null,
    shutdown_cause: null,
  });
});

test("serializeStatusPayload emits newline-terminated JSON", () => {
  const payload = buildTwsStatusPayload(
    {
      backend: "tmux",
      paneKey: "tws_proj:1.0",
      paneId: "%42",
      tmuxServerPid: "89538",
      sessionName: "tws_proj",
      windowIndex: 1,
      paneIndex: 0,
    },
    {
      cwd: "/tmp/project",
      sessionFile: null,
      sessionName: null,
    },
    "idle",
    1,
    null,
    null,
    { sessionId: "unsaved-session", piPid: 987 },
  );
  assert.equal(payload.session_file, null);
  assert.equal(payload.session_id, "unsaved-session");
  assert.equal(payload.pi_pid, 987);
  assert.equal(payload.tmux_server_pid, "89538");

  const serialized = serializeStatusPayload(payload);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), payload);
});

test("buildTwsStatusPayload publishes recovery evidence and the cause only for shutdown", () => {
  const pane = { backend: "tmux" as const, paneKey: "p:1.0", paneId: "%1", tmuxServerPid: "7", sessionName: "p", windowIndex: 1, paneIndex: 0 };
  const session = { cwd: "/tmp", sessionFile: "/tmp/s.jsonl", sessionName: null };
  const evidence = { runAnchor: { leaf_id: "leaf", started_at_ms: 10 }, shutdownCause: "signal" as const };
  const shutdown = buildTwsStatusPayload(pane, session, "shutdown", 20, 10, null, { sessionId: "s", piPid: 1 }, evidence);
  assert.deepEqual(shutdown.run_anchor, { leaf_id: "leaf", started_at_ms: 10 });
  assert.equal(shutdown.shutdown_cause, "signal");
  const working = buildTwsStatusPayload(pane, session, "working", 20, 10, null, { sessionId: "s", piPid: 1 }, evidence);
  assert.equal(working.shutdown_cause, null);
});
