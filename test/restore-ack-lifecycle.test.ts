import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtensionHarness } from "./support/extension-harness.ts";

// Regression for the 2026-11-06 Tart host-mirror drill: a restored Pi started
// while the restore kept tmux busy, its 1 s `tmux display-message` timed out,
// and session_start returned before the one-shot restore acknowledgement. The
// restore then reported the correctly resumed pane as `unverified`.

const harness = await loadExtensionHarness();
const ackDir = join(harness.root, "acks");
mkdirSync(ackDir);
after(() => harness.cleanup());

function expectRestore(token: string, id: string, file: string): string {
  Object.assign(process.env, {
    PI_TMUX_RESTORE_TOKEN: token,
    PI_TMUX_EXPECTED_PANE: "tws_fixture_main:1.0",
    PI_TMUX_EXPECTED_SESSION_ID: id,
    PI_TMUX_EXPECTED_SESSION_FILE: file,
    PI_TMUX_RESTORE_ACK_DIR: ackDir,
  });
  return join(ackDir, `${token}.json`);
}

function readAck(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("a tmux timeout at session_start still produces the restore acknowledgement", async () => {
  const session = harness.session("session-a");
  const ackPath = expectRestore("token-a", session.id, session.file);
  harness.setTmuxFailures(1);
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
  assert.ok(existsSync(ackPath), "restore acknowledgement was not written");
  const ack = readAck(ackPath);
  assert.equal(ack.status, "resumed");
  assert.equal(ack.actualSessionId, "session-a");
  assert.equal(ack.actualPaneKey, "tws_fixture_main:1.0");
});

test("a pending acknowledgement is written by the next successful event", async () => {
  const session = harness.session("session-b");
  const ackPath = expectRestore("token-b", session.id, session.file);
  harness.setTmuxFailures(3);
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  assert.equal(existsSync(ackPath), false, "every pane lookup failed, so no acknowledgement yet");
  await handlers.agent_start!({}, session.ctx);
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
  assert.equal(readAck(ackPath).status, "resumed");
});

test("the first acknowledgement for a token is never replaced", async () => {
  const restored = harness.session("session-c");
  const ackPath = expectRestore("token-c", restored.id, restored.file);
  harness.setTmuxFailures(0);
  let handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, restored.ctx);
  await handlers.session_shutdown!({ reason: "new" }, restored.ctx);
  const first = readFileSync(ackPath, "utf8");
  // `/new` in the same process: a new extension instance starts with another session.
  const replacement = harness.session("session-d");
  handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "new" }, replacement.ctx);
  await handlers.session_shutdown!({ reason: "quit" }, replacement.ctx);
  assert.equal(readFileSync(ackPath, "utf8"), first);
  assert.equal(readAck(ackPath).actualSessionId, "session-c");
});
