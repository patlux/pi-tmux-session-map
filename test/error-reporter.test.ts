import assert from "node:assert/strict";
import { test } from "node:test";

import { createThrottledErrorReporter, formatError } from "../src/domain/error-reporter.ts";

test("formatError handles Error and non-Error values", () => {
  assert.equal(formatError(new Error("boom")), "boom");
  assert.equal(formatError("plain"), "plain");
});

test("createThrottledErrorReporter suppresses repeated messages within window", () => {
  const messages: string[] = [];
  const reporter = createThrottledErrorReporter(1000, (message) => messages.push(message));

  reporter.report("prefix", new Error("boom"), 1000);
  reporter.report("prefix", new Error("boom"), 1100);
  reporter.report("prefix", new Error("boom"), 1200);
  reporter.report("prefix", new Error("boom"), 2101);

  assert.deepEqual(messages, ["prefix: boom", "prefix: boom (suppressed 2 similar errors)"]);
});

test("createThrottledErrorReporter does not merge different errors", () => {
  const messages: string[] = [];
  const reporter = createThrottledErrorReporter(1000, (message) => messages.push(message));

  reporter.report("prefix", new Error("one"), 1000);
  reporter.report("prefix", new Error("two"), 1100);

  assert.deepEqual(messages, ["prefix: one", "prefix: two"]);
});
