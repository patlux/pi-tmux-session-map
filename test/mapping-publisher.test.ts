import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publishSessionMapping } from "../src/domain/mapping-publisher.ts";
import { mappingFileName, paneIdMappingFileName } from "../src/domain/pane-key.ts";
import { parseSessionMapping } from "../src/domain/session-mapping.ts";

const pane = {
  backend: "tmux" as const,
  paneKey: "work:3.0",
  paneId: "%42",
  tmuxServerPid: "89538",
  sessionName: "work",
  windowIndex: 3,
  paneIndex: 0,
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tmux-mapping-publisher-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("publishSessionMapping writes key and live alias only for matching on-disk identity", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "session-id", cwd: dir, version: 3 })}\n`);
    const result = await publishSessionMapping(
      dir,
      pane,
      { cwd: dir, sessionFile, sessionName: "Work" },
      "session-id",
      1234,
    );
    assert.deepEqual(result, {
      keyFileName: mappingFileName(pane.paneKey),
      paneIdFileName: paneIdMappingFileName(pane.paneId),
    });
    const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".session")).sort();
    assert.deepEqual(entries, [mappingFileName(pane.paneKey), paneIdMappingFileName(pane.paneId)].sort());
    for (const entry of entries) {
      const parsed = parseSessionMapping(await readFile(join(dir, entry), "utf8"));
      assert.equal(parsed?.format, "structured");
      if (parsed?.format === "structured") {
        assert.equal(parsed.mapping.schema, 3);
        if (parsed.mapping.schema === 3) {
          assert.equal(parsed.mapping.paneId, "%42");
          assert.equal(parsed.mapping.tmuxServerPid, "89538");
          assert.equal(parsed.mapping.sessionId, "session-id");
        }
      }
    }
  });
});

test("publishSessionMapping fails closed without deleting old mappings", async () => {
  await withTempDir(async (dir) => {
    const old = join(dir, "old.session");
    await writeFile(old, "old mapping\n");
    const missing = join(dir, "missing.jsonl");
    assert.equal(
      await publishSessionMapping(dir, pane, { cwd: dir, sessionFile: missing, sessionName: null }, "session-id"),
      undefined,
    );
    const wrong = join(dir, "wrong.jsonl");
    await writeFile(wrong, `${JSON.stringify({ type: "session", id: "other-id", cwd: dir, version: 3 })}\n`);
    assert.equal(
      await publishSessionMapping(dir, pane, { cwd: dir, sessionFile: wrong, sessionName: null }, "session-id"),
      undefined,
    );
    assert.deepEqual(await readdir(dir), ["old.session", "wrong.jsonl"]);
  });
});

test("publishSessionMapping replaces a renumbered key only after publishing both new identities", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "session-id", cwd: dir, version: 3 })}\n`);
    const oldPane = { ...pane, paneKey: "work:2.0" };
    await publishSessionMapping(dir, oldPane, { cwd: dir, sessionFile, sessionName: null }, "session-id", 1);
    await publishSessionMapping(dir, pane, { cwd: dir, sessionFile, sessionName: null }, "session-id", 2);
    const mappings = (await readdir(dir)).filter((entry) => entry.endsWith(".session")).sort();
    assert.deepEqual(mappings, [mappingFileName(pane.paneKey), paneIdMappingFileName(pane.paneId)].sort());
  });
});
