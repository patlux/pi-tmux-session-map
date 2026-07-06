import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePaneInfoOutput, parseTmuxIndex } from "../src/domain/pane-info.ts";

test("parseTmuxIndex parses decimal numbers and falls back to zero", () => {
  assert.equal(parseTmuxIndex("12"), 12);
  assert.equal(parseTmuxIndex("not-a-number"), 0);
  assert.equal(parseTmuxIndex(""), 0);
});

test("parsePaneInfoOutput parses tmux pane info", () => {
  assert.deepEqual(parsePaneInfoOutput("tws_proj:1.0\ttws_proj\t1\t0\n", "%42"), {
    paneKey: "tws_proj:1.0",
    paneId: "%42",
    sessionName: "tws_proj",
    windowIndex: 1,
    paneIndex: 0,
  });
});

test("parsePaneInfoOutput rejects empty output and missing session name", () => {
  assert.equal(parsePaneInfoOutput("\n", "%1"), undefined);
  assert.equal(parsePaneInfoOutput("tws_proj:1.0\t\t1\t0\n", "%1"), undefined);
});
