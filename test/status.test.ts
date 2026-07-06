import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTwsStatusPayload, serializeStatusPayload } from "../src/domain/status.ts";

test("buildTwsStatusPayload maps pane and session metadata", () => {
  const payload = buildTwsStatusPayload(
    {
      paneKey: "tws_proj:1.0",
      paneId: "%42",
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
  );

  assert.deepEqual(payload, {
    schema: 1,
    agent: "pi",
    pane_id: "%42",
    pane_key: "tws_proj:1.0",
    tmux_session_name: "tws_proj",
    window_index: 1,
    pane_index: 0,
    cwd: "/tmp/project",
    session_file: "/tmp/session.jsonl",
    session_name: "Review plugin",
    state: "done",
    updated_at_ms: 2000,
    started_at_ms: 1000,
    finished_at_ms: 2000,
  });
});

test("serializeStatusPayload emits newline-terminated JSON", () => {
  const payload = buildTwsStatusPayload(
    {
      paneKey: "tws_proj:1.0",
      paneId: "%42",
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
  );

  const serialized = serializeStatusPayload(payload);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), payload);
});
