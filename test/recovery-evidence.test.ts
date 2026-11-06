import assert from "node:assert/strict";
import { after, test } from "node:test";

import { resetRecordedTerminationSignal } from "../src/domain/signal-evidence.ts";
import { loadExtensionHarness } from "./support/extension-harness.ts";

// Evidence for tmux-recovery's auto-continue decision (docs/pi-auto-continue.md
// §3.1 in tmux-recovery): `run_anchor` marks a running agent turn, and
// `shutdown_cause` separates a signal (closed terminal, dead tmux server,
// reboot) from an interactive quit, which both reach extensions as "quit".

const harness = await loadExtensionHarness();
const { shutdownCauseFor } = await import("../src/index.ts");
after(() => harness.cleanup());

test("shutdown causes map session_shutdown reasons and recorded signals", () => {
  assert.equal(shutdownCauseFor("quit", null), "quit");
  assert.equal(shutdownCauseFor("quit", "SIGHUP"), "signal");
  assert.equal(shutdownCauseFor("quit", "SIGTERM"), "signal");
  assert.equal(shutdownCauseFor("reload", "SIGHUP"), "reload");
  assert.equal(shutdownCauseFor("new", null), "replace");
  assert.equal(shutdownCauseFor("resume", null), "replace");
  assert.equal(shutdownCauseFor("fork", null), "replace");
});

test("a run anchor captures the leaf before the prompt and survives retries", async () => {
  const session = harness.session("anchor");
  session.leafId = "leaf-before-prompt";
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  assert.equal(harness.readStatus().run_anchor, null);
  await handlers.agent_start!({}, session.ctx);
  const working = harness.readStatus();
  assert.equal(working.state, "working");
  assert.deepEqual((working.run_anchor as Record<string, unknown>).leaf_id, "leaf-before-prompt");
  const anchor = working.run_anchor;
  // A technical error is provisional (`retrying`); Pi's retry starts another agent run.
  session.leafId = "leaf-after-error";
  await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "error" }] }, session.ctx);
  assert.equal(harness.readStatus().state, "retrying");
  await handlers.agent_start!({}, session.ctx);
  assert.deepEqual(harness.readStatus().run_anchor, anchor, "a retry keeps the original anchor");
  await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, session.ctx);
  await handlers.agent_settled!({}, session.ctx);
  const done = harness.readStatus();
  assert.equal(done.state, "done");
  assert.equal(done.run_anchor, null, "a final state ends the run");
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
});

test("an interactive quit during a run is recorded as quit", async () => {
  resetRecordedTerminationSignal();
  const session = harness.session("quit");
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  await handlers.agent_start!({}, session.ctx);
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
  const status = harness.readStatus();
  assert.equal(status.state, "shutdown");
  assert.equal(status.shutdown_cause, "quit");
  assert.notEqual(status.run_anchor, null);
});

test("a signal is recorded even when Pi starts the shutdown before this listener runs", async () => {
  resetRecordedTerminationSignal();
  const session = harness.session("signal");
  const handlers = harness.loadExtension();
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  await handlers.agent_start!({}, session.ctx);
  // Pi registers its own handler with prependListener during init and calls the
  // session_shutdown handlers from it (`void this.shutdown({ fromSignal: true })`).
  // Register the same shape in front of the extension's listener.
  let shutdown: Promise<void> | undefined;
  const piHandler = () => {
    shutdown = Promise.resolve(handlers.session_shutdown!({ reason: "quit" }, session.ctx));
  };
  process.prependListener("SIGHUP", piHandler);
  try {
    process.emit("SIGHUP");
    await shutdown;
  } finally {
    process.removeListener("SIGHUP", piHandler);
  }
  const status = harness.readStatus();
  assert.equal(status.state, "shutdown");
  assert.equal(status.shutdown_cause, "signal");
});

test("a replacement shutdown removes the signal listener", async () => {
  const session = harness.session("replace");
  const handlers = harness.loadExtension();
  const before = process.listenerCount("SIGHUP");
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  assert.equal(process.listenerCount("SIGHUP"), before + 1);
  await handlers.session_shutdown!({ reason: "new" }, session.ctx);
  assert.equal(process.listenerCount("SIGHUP"), before);
  assert.equal(harness.readStatus().shutdown_cause, "replace");
});
