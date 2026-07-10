import assert from "node:assert/strict";
import { test } from "node:test";

import { finalWorkStateForMessages, provisionalWorkState } from "../src/index.ts";

test("finalWorkStateForMessages reports normal completion as done", () => {
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "stop" }]), "done");
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "toolUse" }]), "done");
});

test("finalWorkStateForMessages distinguishes terminal outcomes", () => {
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "error" }]), "failed");
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "aborted" }]), "cancelled");
  assert.equal(finalWorkStateForMessages([{ role: "assistant", stopReason: "length" }]), "incomplete");
});

test("finalWorkStateForMessages uses the final assistant message", () => {
  assert.equal(
    finalWorkStateForMessages([
      { role: "assistant", stopReason: "stop" },
      { role: "toolResult" },
      { role: "assistant", stopReason: "error" },
    ]),
    "failed",
  );
});

test("finalWorkStateForMessages defaults to done without an assistant message", () => {
  assert.equal(finalWorkStateForMessages([{ role: "custom" }]), "done");
});

test("provisionalWorkState only turns technical failures into retrying", () => {
  assert.equal(provisionalWorkState("failed"), "retrying");
  assert.equal(provisionalWorkState("cancelled"), "cancelled");
  assert.equal(provisionalWorkState("incomplete"), "incomplete");
  assert.equal(provisionalWorkState("done"), "done");
});
