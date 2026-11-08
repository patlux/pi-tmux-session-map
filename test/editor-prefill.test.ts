import assert from "node:assert/strict";
import { after, test } from "node:test";

import { EDITOR_PREFILL_OPTION, prefilledEditorText, takeEditorPrefill } from "../src/domain/editor-prefill.ts";
import { loadExtensionHarness } from "./support/extension-harness.ts";

// TWS's "New Pi with reference" sets a one-shot pane option and types `pi`;
// the Pi that starts in that pane puts the text into its editor, unsent.

const harness = await loadExtensionHarness();
delete process.env.PI_TMUX_RESTORE_TOKEN;
after(() => harness.cleanup());

const REFERENCE = "siehe pi session 01a1ac09-0000-7000-8000-00000000a11a ";

test("a starting Pi puts the pane's prefill in front of text typed meanwhile and clears it", async () => {
  harness.setEditorPrefill(REFERENCE);
  const session = harness.session("prefill-startup");
  session.editorText = "review es";
  await harness.loadExtension().session_start!({ reason: "startup" }, session.ctx);
  assert.equal(session.editorText, `${REFERENCE}review es`);
  assert.equal(harness.editorPrefillSet(), false, "the prefill is one-shot");
  assert.deepEqual(harness.editorPrefillCalls().slice(-2), [
    `show-options -p -q -v -t %7 ${EDITOR_PREFILL_OPTION}`,
    `set-option -p -u -t %7 ${EDITOR_PREFILL_OPTION}`,
  ]);

  // The next Pi in the same pane starts with its editor as it is.
  const next = harness.session("prefill-next");
  await harness.loadExtension().session_start!({ reason: "startup" }, next.ctx);
  assert.equal(next.editorText, "");
});

test("only the interactive pane owner takes the prefill, and only at startup", async () => {
  harness.setEditorPrefill(REFERENCE);
  for (const reason of ["new", "resume", "fork", "reload"]) {
    const session = harness.session(`prefill-${reason}`);
    await harness.loadExtension().session_start!({ reason }, session.ctx);
    assert.equal(session.editorText, "", reason);
  }
  const headless = harness.session("prefill-rpc");
  headless.ctx.mode = "rpc";
  await harness.loadExtension().session_start!({ reason: "startup" }, headless.ctx);
  assert.equal(headless.editorText, "");
  process.env.PI_TMUX_RESTORE_TOKEN = "restore-prefill";
  try {
    const restored = harness.session("prefill-restored");
    await harness.loadExtension().session_start!({ reason: "startup" }, restored.ctx);
    assert.equal(restored.editorText, "");
  } finally {
    delete process.env.PI_TMUX_RESTORE_TOKEN;
  }
  assert.equal(harness.editorPrefillSet(), true, "the prefill waits for the right Pi");

  const owner = harness.session("prefill-owner");
  await harness.loadExtension().session_start!({ reason: "startup" }, owner.ctx);
  assert.equal(owner.editorText, REFERENCE);
});

test("a prefill that cannot be cleared is not used", async () => {
  const calls: string[] = [];
  const failingClear = async (args: readonly string[]) => {
    calls.push(args[0] ?? "");
    if (args[0] === "set-option") {
      throw new Error("tmux timed out");
    }
    return `${REFERENCE}\n`;
  };
  await assert.rejects(takeEditorPrefill(failingClear, "%7"), /timed out/);
  assert.deepEqual(calls, ["show-options", "set-option"]);
  assert.equal(await takeEditorPrefill(async () => "", "%7"), null);
  // Only tmux's own newline is removed; the reference keeps its trailing space.
  assert.equal(await takeEditorPrefill(async () => `${REFERENCE}\n`, "%7"), REFERENCE);
  assert.equal(prefilledEditorText(REFERENCE, ""), REFERENCE);
});
