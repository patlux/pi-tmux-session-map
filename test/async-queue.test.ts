import assert from "node:assert/strict";
import { test } from "node:test";

import { createAsyncQueue } from "../src/domain/async-queue.ts";

test("createAsyncQueue runs operations in enqueue order", async () => {
  const queue = createAsyncQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    events.push("first:start");
    await firstBlocker;
    events.push("first:end");
    return 1;
  });
  const second = queue.enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst?.();

  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("createAsyncQueue continues after failed operation", async () => {
  const queue = createAsyncQueue();
  const events: string[] = [];

  const first = queue.enqueue(async () => {
    events.push("first");
    throw new Error("boom");
  });
  const second = queue.enqueue(async () => {
    events.push("second");
    return 2;
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, 2);
  assert.deepEqual(events, ["first", "second"]);
});
