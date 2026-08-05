import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionMapping, mappedSessionFile, parseSessionMapping, serializeSessionMapping } from "../src/domain/session-mapping.ts";

test("structured session mapping round-trips exact Pi identity", () => {
  const mapping = buildSessionMapping(
    "tws_project_main:1.0",
    "%42",
    "89538",
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

test("schema 2 structured session mappings remain readable", () => {
  const mapping = {
    schema: 2 as const,
    paneKey: "tws_project_main:1.0",
    sessionFile: "/tmp/session.jsonl",
    sessionId: "019fa5b7-6b58-72ec-a435-1f762efcc952",
    cwd: "/tmp/project",
    sessionName: null,
    updatedAtMs: 1234,
  };
  assert.deepEqual(parseSessionMapping(`${JSON.stringify(mapping)}\n`), {
    format: "structured",
    mapping,
  });
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
  assert.equal(parseSessionMapping(JSON.stringify({
    schema: 3,
    paneKey: "work:1.0",
    paneId: "",
    tmuxServerPid: "89538",
    sessionFile: "/tmp/x",
    sessionId: "id",
    cwd: "/tmp",
    sessionName: null,
    updatedAtMs: 1,
  })), undefined);
});
