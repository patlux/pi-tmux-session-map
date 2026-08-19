import assert from "node:assert/strict";
import { test } from "node:test";

import { ownsInteractivePane, paneOwnershipEvidence } from "../src/domain/pane-ownership.ts";

test("interactive TUI with a real stdin TTY owns its pane", () => {
  const evidence = paneOwnershipEvidence("tui", true, {});

  assert.deepEqual(evidence, {
    mode: "tui",
    stdinIsTty: true,
    subagentChild: false,
  });
  assert.equal(ownsInteractivePane(evidence), true);
});

test("headless modes never own a tmux pane", () => {
  assert.equal(ownsInteractivePane(paneOwnershipEvidence("json", true, {})), false);
  assert.equal(ownsInteractivePane(paneOwnershipEvidence("print", true, {})), false);
  assert.equal(ownsInteractivePane(paneOwnershipEvidence("rpc", true, {})), false);
});

test("a process without an interactive stdin never owns a tmux pane", () => {
  assert.equal(ownsInteractivePane(paneOwnershipEvidence("tui", false, {})), false);
  assert.equal(ownsInteractivePane(paneOwnershipEvidence("tui", undefined, {})), false);
});

test("pi-subagents children never own their inherited parent pane", () => {
  const evidence = paneOwnershipEvidence("tui", true, { PI_SUBAGENT_CHILD: "1" });

  assert.equal(evidence.subagentChild, true);
  assert.equal(ownsInteractivePane(evidence), false);
});
