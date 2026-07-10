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

test("retrying preserves the run start and remains unfinished", () => {
  const working = nextStatusTransition(createRuntimeState(), "working", 1000);
  const retrying = nextStatusTransition(working, "retrying", 2000);

  assert.equal(retrying.shouldWrite, true);
  assert.equal(retrying.lastState, "retrying");
  assert.equal(retrying.startedAtMs, 1000);
  assert.equal(retrying.finishedAtMs, null);
});

test("terminal outcomes preserve start time and record finish time", () => {
  for (const finalState of ["done", "cancelled", "incomplete", "failed"] as const) {
    const working = nextStatusTransition(createRuntimeState(), "working", 1000);
    const finished = nextStatusTransition(working, finalState, 2000);

    assert.equal(finished.shouldWrite, true);
    assert.equal(finished.lastState, finalState);
    assert.equal(finished.startedAtMs, 1000);
    assert.equal(finished.finishedAtMs, 2000);
  }
});

test("shutdown after terminal state advances sequence but does not overwrite it", () => {
  for (const finalState of ["done", "cancelled", "incomplete", "failed"] as const) {
    const working = nextStatusTransition(createRuntimeState(), "working", 1000);
    const finished = nextStatusTransition(working, finalState, 2000);
    const shutdown = nextStatusTransition(finished, "shutdown", 3000);

    assert.equal(shutdown.shouldWrite, false);
    assert.equal(shutdown.lastState, finalState);
    assert.equal(shutdown.sequence, 3);
  }
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

test("refreshStatusTransition preserves terminal finish time", () => {
  for (const finalState of ["done", "cancelled", "incomplete", "failed"] as const) {
    const working = nextStatusTransition(createRuntimeState(), "working", 1000);
    const finished = nextStatusTransition(working, finalState, 2000);
    const refresh = refreshStatusTransition(finished, 3000);

    assert.equal(refresh.shouldWrite, true);
    assert.equal(refresh.lastState, finalState);
    assert.equal(refresh.startedAtMs, 1000);
    assert.equal(refresh.finishedAtMs, 2000);
    assert.equal(refresh.sequence, 3);
  }
});
