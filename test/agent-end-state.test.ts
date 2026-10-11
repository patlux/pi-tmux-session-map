import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalWorkStateForMessages,
  provisionalWorkState,
  reconciliationDelayMs,
  sessionMappingSignature,
  twsStatusSignature,
} from "../src/index.ts";

test("finalWorkStateForMessages reports normal completion as done", () => {
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "stop" }]), "done");
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "toolUse" }]), "done");
});

test("finalWorkStateForMessages distinguishes terminal outcomes", () => {
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "error" }]), "failed");
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "aborted" }]), "cancelled");
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "length" }]), "incomplete");
});

test("finalWorkStateForMessages uses the final assistant message", () => {
  assert.equal(
    finalWorkStateForMessages([
      { role: "assistant", stopReason: "stop" },
      { role: "toolResult" },
      { role: "assistant", stopReason: "error" },
    ]),
    "failed",
  );
});

test("finalWorkStateForMessages defaults to done without an assistant message", () => {
  assert.equal(finalWorkStateForMessages([{ role: "custom" }]), "done");
});

test("artifact signatures deduplicate unchanged mapping and status content", () => {
  const pane = {
    backend: "tmux" as const,
    paneKey: "work:1.0",
    paneId: "%1",
    tmuxServerPid: "89538",
    sessionName: "work",
    windowIndex: 1,
    paneIndex: 0,
  };
  const session = {
    cwd: "/tmp/work",
    sessionFile: "/tmp/session.jsonl",
    sessionName: "Optimize",
  };

  assert.equal(
    sessionMappingSignature(pane, session, "session-id"),
    sessionMappingSignature(pane, { ...session }, "session-id"),
  );
  assert.notEqual(
    sessionMappingSignature(pane, session, "session-id"),
    sessionMappingSignature(pane, { ...session, sessionName: "Renamed" }, "session-id"),
  );
  assert.equal(
    twsStatusSignature(pane, session, "working", 10, null, "session-id"),
    twsStatusSignature(pane, { ...session }, "working", 10, null, "session-id"),
  );
  assert.notEqual(
    twsStatusSignature(pane, session, "working", 10, null, "session-id"),
    twsStatusSignature(pane, session, "done", 10, 20, "session-id"),
  );
  assert.notEqual(
    twsStatusSignature(pane, { ...session, sessionFile: null }, "idle", null, null, "first"),
    twsStatusSignature(pane, { ...session, sessionFile: null }, "idle", null, null, "second"),
  );
});

test("mapping signatures include stable pane ids", () => {
  const session = { cwd: "/tmp", sessionFile: "/tmp/session.jsonl", sessionName: null };
  const pane = {
    backend: "tmux" as const,
    paneKey: "work:1.0",
    paneId: "%1",
    tmuxServerPid: "89538",
    sessionName: "work",
    windowIndex: 1,
    paneIndex: 0,
  };
  assert.notEqual(
    sessionMappingSignature(pane, session, "id"),
    sessionMappingSignature({ ...pane, paneId: "%2" }, session, "id"),
  );
});

test("reconciliation jitter is deterministic and bounded", () => {
  assert.equal(reconciliationDelayMs("%42", 60_000), reconciliationDelayMs("%42", 60_000));
  assert.ok(reconciliationDelayMs("%42", 60_000) >= 0);
  assert.ok(reconciliationDelayMs("%42", 60_000) < 60_000);
});

test("mapping signatures exclude non-tmux and missing session files", () => {
  const session = { cwd: "/tmp", sessionFile: "/tmp/session.jsonl", sessionName: null };
  assert.equal(sessionMappingSignature({
    backend: "mex",
    paneKey: "mex:id",
    paneId: "id",
    tmuxServerPid: null,
    sessionName: "id",
    windowIndex: 0,
    paneIndex: 0,
  }, session, "id"), null);
  assert.equal(sessionMappingSignature({
    backend: "tmux",
    paneKey: "work:1.0",
    paneId: "%1",
    tmuxServerPid: "89538",
    sessionName: "work",
    windowIndex: 1,
    paneIndex: 0,
  }, { ...session, sessionFile: null }, "id"), null);
});

test("provisionalWorkState only turns technical failures into retrying", () => {
  assert.equal(provisionalWorkState("failed"), "retrying");
  assert.equal(provisionalWorkState("cancelled"), "cancelled");
  assert.equal(provisionalWorkState("incomplete"), "incomplete");
  assert.equal(provisionalWorkState("done"), "done");
});
