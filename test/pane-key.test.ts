import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mappingFileName,
  normalizePaneKey,
  sanitizeKey,
} from "../src/domain/pane-key.ts";

test("sanitizeKey keeps safe characters", () => {
  assert.equal(sanitizeKey("main:1.0"), "main_1.0");
  assert.equal(sanitizeKey("tws_infra_fix-resume:12.3"), "tws_infra_fix-resume_12.3");
});

test("sanitizeKey replaces every unsafe character with underscore", () => {
  assert.equal(sanitizeKey("my session:1.0"), "my_session_1.0");
  assert.equal(sanitizeKey("a/b\\c:1.0"), "a_b_c_1.0");
});

test("sanitizeKey matches shell `tr -c 'A-Za-z0-9._-' '_'` for ASCII input", () => {
  const input = "sess name:2.1";
  const shellEquivalent = input
    .split("")
    .map((ch) => (/[A-Za-z0-9._-]/.test(ch) ? ch : "_"))
    .join("");
  assert.equal(sanitizeKey(input), shellEquivalent);
});

test("mappingFileName appends .session suffix", () => {
  assert.equal(mappingFileName("main:1.0"), "main_1.0.session");
});

test("normalizePaneKey trims tmux output", () => {
  assert.equal(normalizePaneKey("main:1.0\n"), "main:1.0");
});

test("normalizePaneKey rejects empty output", () => {
  assert.equal(normalizePaneKey(""), undefined);
  assert.equal(normalizePaneKey("\n"), undefined);
});
