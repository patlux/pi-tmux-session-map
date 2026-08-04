import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionMapping, mappedSessionFile, parseSessionMapping, serializeSessionMapping } from "../src/domain/session-mapping.ts";

test("structured session mapping round-trips exact Pi identity", () => {
  const mapping = buildSessionMapping(
    "tws_project_main:1.0",
    "/tmp/session.jsonl",
    "019fa5b7-6b58-72ec-a435-1f762efcc952",
    "/tmp/project",
    "Recovery fixture",
    1234,
  );
  const serialized = serializeSessionMapping(mapping);
  assert.deepEqual(parseSessionMapping(serialized), { format: "structured", mapping });
  assert.equal(mappedSessionFile(serialized), "/tmp/session.jsonl");
});

test("legacy one-line session mapping remains readable", () => {
  const content = "/tmp/legacy session.jsonl\n";
  assert.deepEqual(parseSessionMapping(content), {
    format: "legacy",
    sessionFile: "/tmp/legacy session.jsonl",
  });
  assert.equal(mappedSessionFile(content), "/tmp/legacy session.jsonl");
});

test("invalid structured mapping fails closed", () => {
  assert.equal(parseSessionMapping("{not-json\n"), undefined);
  assert.equal(parseSessionMapping(JSON.stringify({ schema: 2, sessionFile: "/tmp/x" })), undefined);
});
