import assert from "node:assert/strict";
import { test } from "node:test";

import { createRuntimeState, nextStatusTransition, refreshStatusTransition } from "../src/domain/state.ts";

test("working starts a new run and clears prior finish time", () => {
  const initial = createRuntimeState();
  const transition = nextStatusTransition(initial, "working", 1000);

  assert.equal(transition.shouldWrite, true);
  assert.equal(transition.lastState, "working");
  assert.equal(transition.startedAtMs, 1000);
  assert.equal(transition.finishedAtMs, null);
  assert.equal(transition.sequence, 1);
});

test("done preserves start time and records first finish time", () => {
  const working = nextStatusTransition(createRuntimeState(), "working", 1000);
  const done = nextStatusTransition(working, "done", 2000);
  const repeatedDone = nextStatusTransition(done, "done", 3000);

  assert.equal(done.shouldWrite, true);
  assert.equal(done.lastState, "done");
  assert.equal(done.startedAtMs, 1000);
  assert.equal(done.finishedAtMs, 2000);
  assert.equal(repeatedDone.finishedAtMs, 2000);
});

test("shutdown after done advances state sequence but does not write", () => {
  const working = nextStatusTransition(createRuntimeState(), "working", 1000);
  const done = nextStatusTransition(working, "done", 2000);
  const shutdown = nextStatusTransition(done, "shutdown", 3000);

  assert.equal(shutdown.shouldWrite, false);
  assert.equal(shutdown.lastState, "done");
  assert.equal(shutdown.sequence, 3);
});

test("idle resets run timestamps", () => {
  const working = nextStatusTransition(createRuntimeState(), "working", 1000);
  const done = nextStatusTransition(working, "done", 2000);
  const idle = nextStatusTransition(done, "idle", 3000);

  assert.equal(idle.shouldWrite, true);
  assert.equal(idle.lastState, "idle");
  assert.equal(idle.startedAtMs, null);
  assert.equal(idle.finishedAtMs, null);
});

test("refreshStatusTransition preserves current working start time", () => {
  const working = nextStatusTransition(createRuntimeState(), "working", 1000);
  const refresh = refreshStatusTransition(working, 2000);

  assert.equal(refresh.shouldWrite, true);
  assert.equal(refresh.lastState, "working");
  assert.equal(refresh.startedAtMs, 1000);
  assert.equal(refresh.finishedAtMs, null);
  assert.equal(refresh.sequence, 2);
});

test("refreshStatusTransition preserves current done finish time", () => {
  const working = nextStatusTransition(createRuntimeState(), "working", 1000);
  const done = nextStatusTransition(working, "done", 2000);
  const refresh = refreshStatusTransition(done, 3000);

  assert.equal(refresh.shouldWrite, true);
  assert.equal(refresh.lastState, "done");
  assert.equal(refresh.startedAtMs, 1000);
  assert.equal(refresh.finishedAtMs, 2000);
  assert.equal(refresh.sequence, 3);
});
