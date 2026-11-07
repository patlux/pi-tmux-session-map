import assert from "node:assert/strict";
import { after, test } from "node:test";

import { loadExtensionHarness } from "./support/extension-harness.ts";

// Regression for the 2026-11-07 Tart host-mirror demo: seven Pis sent their prompts at the same
// moment, one `tmux display-message` at agent_start ran past its 1 s timeout, and the handler
// dropped the pane info and returned before the status write. The running Pi stayed `idle` with
// no run anchor, so TWS showed it idle and auto-continue would have skipped it after a crash.

const harness = await loadExtensionHarness();
after(() => harness.cleanup());

test("a tmux timeout at agent_start still publishes working with the run anchor", async () => {
  const session = harness.session("busy-start");
  session.leafId = "leaf-before-prompt";
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  assert.equal(harness.readStatusFor(session.id).state, "idle");
  harness.setTmuxFailures(1);
  await handlers.agent_start!({}, session.ctx);
  const status = harness.readStatusFor(session.id);
  assert.equal(status.state, "working");
  assert.deepEqual((status.run_anchor as Record<string, unknown> | null)?.leaf_id, "leaf-before-prompt");
  assert.equal(status.pane_key, "tws_fixture_main:1.0", "the last known pane of this process");
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
});

test("a tmux timeout at agent_end still publishes the provisional state", async () => {
  const session = harness.session("busy-end");
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  await handlers.agent_start!({}, session.ctx);
  harness.setTmuxFailures(1);
  await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "error" }] }, session.ctx);
  assert.equal(harness.readStatusFor(session.id).state, "retrying");
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
});
