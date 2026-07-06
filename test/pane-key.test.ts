import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hashKey,
  keyFileStem,
  mappingFileName,
  normalizePaneKey,
  sanitizeKey,
  statusFileName,
} from "../src/domain/pane-key.ts";

test("sanitizeKey keeps safe characters", () => {
  assert.equal(sanitizeKey("main:1.0"), "main_1.0");
  assert.equal(sanitizeKey("tws_infra_fix-resume:12.3"), "tws_infra_fix-resume_12.3");
});

test("sanitizeKey replaces every unsafe character with underscore", () => {
  assert.equal(sanitizeKey("my session:1.0"), "my_session_1.0");
  assert.equal(sanitizeKey("a/b\\c:1.0"), "a_b_c_1.0");
});

test("sanitizeKey matches shell `tr -c 'A-Za-z0-9._-' '_'` behavior", () => {
  const input = "sess näme:2.1";
  const shellEquivalent = Array.from(Buffer.from(input, "utf8"))
    .map((byte) => {
      const isDigit = byte >= 0x30 && byte <= 0x39;
      const isUpper = byte >= 0x41 && byte <= 0x5a;
      const isLower = byte >= 0x61 && byte <= 0x7a;
      const isPunctuation = byte === 0x2e || byte === 0x5f || byte === 0x2d;
      return isDigit || isUpper || isLower || isPunctuation ? String.fromCharCode(byte) : "_";
    })
    .join("");
  assert.equal(sanitizeKey(input), shellEquivalent);
});

test("hashKey is stable and compact", () => {
  assert.equal(hashKey("main:1.0"), "bd05483bcdd9");
});

test("keyFileStem keeps a readable sanitized prefix and hash suffix", () => {
  assert.equal(keyFileStem("main:1.0"), "main_1.0-bd05483bcdd9");
});

test("keyFileStem avoids collisions for pane keys with same sanitized prefix", () => {
  assert.notEqual(keyFileStem("a:b"), keyFileStem("a/b"));
});

test("keyFileStem bounds very long names", () => {
  const stem = keyFileStem(`${"a".repeat(400)}:1.0`);
  assert.ok(stem.length <= 133);
  assert.match(stem, /^a+-[a-f0-9]{12}$/);
});

test("mappingFileName appends .session suffix", () => {
  assert.equal(mappingFileName("main:1.0"), "main_1.0-bd05483bcdd9.session");
});

test("statusFileName appends .json suffix", () => {
  assert.equal(statusFileName("main:1.0"), "main_1.0-bd05483bcdd9.json");
});

test("normalizePaneKey trims tmux output", () => {
  assert.equal(normalizePaneKey("main:1.0\n"), "main:1.0");
});

test("normalizePaneKey rejects empty output", () => {
  assert.equal(normalizePaneKey(""), undefined);
  assert.equal(normalizePaneKey("\n"), undefined);
});
