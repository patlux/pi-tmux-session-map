import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanupStaleSessionMappings, cleanupStaleTempFiles, cleanupSupersededSessionMappings, cleanupSupersededStatusFiles, ensureDirectory, writeAtomic } from "../src/domain/atomic-write.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tmux-session-map-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeAtomic writes final content and cleans temp files", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "status.json");

    await writeAtomic(file, "one\n", 0o600);
    await writeAtomic(file, "two\n", 0o600);

    assert.equal(await readFile(file, "utf8"), "two\n");
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["status.json"]);
  });
});

test("concurrent writeAtomic calls use unique temp files", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "status.json");

    await Promise.all([
      writeAtomic(file, "one\n", 0o600),
      writeAtomic(file, "two\n", 0o600),
      writeAtomic(file, "three\n", 0o600),
    ]);

    const finalContent = await readFile(file, "utf8");
    assert.ok(["one\n", "two\n", "three\n"].includes(finalContent));
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["status.json"]);
  });
});

test("cleanupStaleTempFiles removes only old temp files", async () => {
  await withTempDir(async (dir) => {
    const oldTemp = join(dir, "status.json.tmp-1");
    const freshTemp = join(dir, "status.json.tmp-2");
    const normal = join(dir, "status.json");
    await writeFile(oldTemp, "old");
    await writeFile(freshTemp, "fresh");
    await writeFile(normal, "normal");
    const oldDate = new Date(1000);
    await utimes(oldTemp, oldDate, oldDate);

    const result = await cleanupStaleTempFiles(dir, 5000, 10000);

    assert.equal(result.scanned, 2);
    assert.equal(result.removed, 1);
    assert.deepEqual((await readdir(dir)).sort(), ["status.json", "status.json.tmp-2"]);
  });
});

test("cleanupSupersededStatusFiles removes older status files for the same pane id", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "old.json"), JSON.stringify({ pane_id: "%22", state: "working" }));
    await writeFile(join(dir, "current.json"), JSON.stringify({ pane_id: "%22", state: "done" }));
    await writeFile(join(dir, "other-pane.json"), JSON.stringify({ pane_id: "%23", state: "working" }));
    await writeFile(join(dir, "broken.json"), "not json");

    const result = await cleanupSupersededStatusFiles(dir, "current.json", "%22");

    assert.equal(result.scanned, 3);
    assert.equal(result.removed, 1);
    assert.deepEqual((await readdir(dir)).sort(), ["broken.json", "current.json", "other-pane.json"]);
  });
});

test("cleanupSupersededSessionMappings removes other mappings pointing at the same session file", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "session-019f272f.jsonl");
    // Same live session reached under an old key name and a legacy filename.
    await writeFile(join(dir, "tws_a_progress_1.0-hash.session"), `${target}\n`);
    await writeFile(join(dir, "tws_a_notification_1.0.session"), `${target}\n`);
    await writeFile(join(dir, "tws_a_notification_1.0-old.session"), `${target}\n`);
    // Unrelated session must survive.
    await writeFile(join(dir, "tws_b_other_1.0-hash.session"), `${join(dir, "other.jsonl")}\n`);

    const result = await cleanupSupersededSessionMappings(dir, "tws_a_progress_1.0-hash.session", target);

    assert.equal(result.scanned, 3);
    assert.equal(result.removed, 2);
    assert.deepEqual((await readdir(dir)).sort(), [
      "tws_a_progress_1.0-hash.session",
      "tws_b_other_1.0-hash.session",
    ]);
  });
});

test("cleanupStaleSessionMappings removes only old mappings with missing target session files", async () => {
  await withTempDir(async (dir) => {
    const liveTarget = join(dir, "live-session.jsonl");
    const oldLiveMapping = join(dir, "old-live.session");
    const oldMissingMapping = join(dir, "old-missing.session");
    const freshMissingMapping = join(dir, "fresh-missing.session");
    const status = join(dir, "status.json");
    await writeFile(liveTarget, "session");
    await writeFile(oldLiveMapping, `${liveTarget}\n`);
    await writeFile(oldMissingMapping, `${join(dir, "missing-session.jsonl")}\n`);
    await writeFile(freshMissingMapping, `${join(dir, "missing-fresh-session.jsonl")}\n`);
    await writeFile(status, "status");
    const oldDate = new Date(1000);
    await utimes(oldLiveMapping, oldDate, oldDate);
    await utimes(oldMissingMapping, oldDate, oldDate);

    const result = await cleanupStaleSessionMappings(dir, 5000, 10000);

    assert.equal(result.scanned, 3);
    assert.equal(result.removed, 1);
    assert.deepEqual((await readdir(dir)).sort(), [
      "fresh-missing.session",
      "live-session.jsonl",
      "old-live.session",
      "status.json",
    ]);
  });
});

test("ensureDirectory creates nested private directory", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "a", "b");
    await ensureDirectory(nested);
    await writeFile(join(nested, "ok"), "ok");
    assert.equal(await readFile(join(nested, "ok"), "utf8"), "ok");
  });
});
