import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseSessionHeader, readSessionHeader, sessionFileMatches } from "../src/domain/session-file.ts";

test("parseSessionHeader accepts supported Pi session headers", () => {
  assert.deepEqual(parseSessionHeader(JSON.stringify({
    type: "session",
    id: "019fa5b7-6b58-72ec-a435-1f762efcc952",
    cwd: "/tmp/project",
    version: 3,
  })), {
    id: "019fa5b7-6b58-72ec-a435-1f762efcc952",
    cwd: "/tmp/project",
    version: 3,
  });
});

test("parseSessionHeader rejects malformed, incomplete, and unsupported headers", () => {
  assert.equal(parseSessionHeader("not json"), undefined);
  assert.equal(parseSessionHeader(JSON.stringify({ type: "message", id: "id", cwd: "/tmp", version: 3 })), undefined);
  assert.equal(parseSessionHeader(JSON.stringify({ type: "session", id: "id", cwd: "/tmp", version: 4 })), undefined);
});

test("sessionFileMatches verifies on-disk header identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tmux-session-file-"));
  try {
    const file = join(dir, "session.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "session", id: "session-id", cwd: dir, version: 3 })}\n${JSON.stringify({ type: "message" })}\n`);
    assert.deepEqual(await readSessionHeader(file), { id: "session-id", cwd: dir, version: 3 });
    assert.equal(await sessionFileMatches(file, "session-id"), true);
    assert.equal(await sessionFileMatches(file, "other-id"), false);
    assert.equal(await sessionFileMatches(join(dir, "missing.jsonl"), "session-id"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
