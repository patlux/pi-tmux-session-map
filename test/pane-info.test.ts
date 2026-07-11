import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePaneInfoOutput, parseTmuxIndex, parseZellijPaneInfo } from "../src/domain/pane-info.ts";

test("parseTmuxIndex parses decimal numbers and falls back to zero", () => {
  assert.equal(parseTmuxIndex("12"), 12);
  assert.equal(parseTmuxIndex("not-a-number"), 0);
  assert.equal(parseTmuxIndex(""), 0);
});

test("parsePaneInfoOutput parses tmux pane info", () => {
  assert.deepEqual(parsePaneInfoOutput("tws_proj:1.0\ttws_proj\t1\t0\n", "%42"), {
    backend: "tmux",
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

test("parseZellijPaneInfo resolves a terminal pane and normalizes its id", () => {
  const panes = JSON.stringify([
    { id: 0, is_plugin: true, tab_position: 0 },
    { id: 42, is_plugin: false, tab_position: 3 },
  ]);
  assert.deepEqual(parseZellijPaneInfo(panes, "twz_personal_infra_main", "42"), {
    backend: "zellij",
    paneKey: "twz_personal_infra_main:3.42",
    paneId: "terminal_42",
    sessionName: "twz_personal_infra_main",
    windowIndex: 3,
    paneIndex: 42,
  });
});

test("parseZellijPaneInfo rejects invalid and plugin-only data", () => {
  assert.equal(parseZellijPaneInfo("not json", "session", "1"), undefined);
  assert.equal(
    parseZellijPaneInfo(JSON.stringify([{ id: 1, is_plugin: true }]), "session", "1"),
    undefined,
  );
});
