import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ContinuationExecutor, type LiveSource } from "../src/continuation-executor.ts";
import {
  acquireDispatchLock, continuationMessage, createExclusive, decide, existingSkipReason, lastMessageEntryId, releaseDispatchLock,
  testCheckpoint, writeSkip, type ContinuePlan, type LiveFacts,
} from "../src/domain/continuation.ts";

const root = mkdtempSync(join(tmpdir(), "pi-continue-exec-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

function fixture(overrides: Partial<ContinuePlan> = {}, ready = true) {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  const ledgerDir = join(dir, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  const plan: ContinuePlan = {
    schema: 1, key: `key${counter}`, state: "released", chain: 1, token: `tok${counter}`, paneKey: "s:1.0",
    sessionId: "sid", sessionFile: "/s.jsonl", frozenLeafId: "e4", interruptedAtMs: Date.now() - 14 * 86_400_000,
    cause: "signal", toolCalls: [{ id: "call-1", name: "drill_block" }], ledgerDir, readyPath: join(dir, "ready.json"),
    configPath: join(dir, "continue.json"), holdFile: join(dir, "hold"), spacingMs: 300, slotMs: Date.now(),
    deadlineMs: Date.now() + 600_000, ...overrides,
  };
  const planPath = join(ledgerDir, `${plan.key}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(plan.configPath, JSON.stringify({ mode: "on" }));
  if (ready) {
    writeFileSync(plan.readyPath, JSON.stringify({ tokens: { [plan.token]: { key: plan.key } } }));
  }
  return { plan, planPath, ledgerDir };
}

function live(overrides: Partial<Record<keyof LiveSource, unknown>> = {}): LiveSource {
  const base: LiveSource = {
    ackResumed: () => true,
    paneKey: () => "s:1.0",
    sessionId: () => "sid",
    sessionFile: () => "/s.jsonl",
    branch: () => [{ id: "e3", type: "message", message: { role: "user" } }, { id: "e4", type: "message", message: { role: "assistant" } }],
    idle: () => true,
    pendingMessages: () => false,
    editorText: () => "",
  };
  return { ...base, ...(overrides as Partial<LiveSource>) };
}

type Sent = { message: { content: string; details: Record<string, unknown> }; at: number };

function executor(planPath: string, source = live(), sent: Sent[] = [], send?: () => void) {
  const env = { PI_TMUX_CONTINUE_PLAN: planPath, PI_TMUX_SESSION_WATCHDOG_ROOT: join(root, "no-watchdog") };
  const created = ContinuationExecutor.fromEnvironment(
    source,
    (message) => {
      send?.();
      sent.push({ message: message as never, at: Date.now() });
    },
    () => undefined,
    env,
  );
  assert.ok(created);
  return created!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

// -- rules --------------------------------------------------------------------

function facts(overrides: Partial<LiveFacts> = {}): LiveFacts {
  return {
    nowMs: 1000, ackResumed: true, sessionId: "sid", sessionFile: "/s.jsonl", paneKey: "s:1.0", lastMessageEntryId: "e4",
    idle: true, pendingMessages: false, editorText: "", userActive: false, promptOpen: false, watchdogAlive: false,
    mode: "on", holdPresent: false, skipReason: null, ...overrides,
  };
}

test("E1-E7 decide each case with its reason", () => {
  const { plan } = fixture({ slotMs: 500, deadlineMs: 5000 });
  const onDisk = plan;
  assert.deepEqual(decide(plan, onDisk, facts(), false, null), { kind: "dispatch" });
  const cases: [Partial<LiveFacts>, string][] = [
    [{ ackResumed: false }, "ack"], [{ mode: "off" }, "disabled"], [{ holdPresent: true }, "hold"],
    [{ sessionId: "other" }, "identity"], [{ paneKey: "x:1.0" }, "identity"], [{ lastMessageEntryId: "e5" }, "new-entry"],
    [{ userActive: true }, "user-active"], [{ editorText: "draft" }, "user-active"], [{ promptOpen: true }, "user-active"],
    [{ idle: false }, "busy"], [{ pendingMessages: true }, "busy"], [{ watchdogAlive: true }, "watchdog"],
    [{ nowMs: 6000 }, "timeout"],
  ];
  for (const [override, reason] of cases) {
    const verdict = decide(plan, onDisk, facts(override), false, null);
    assert.equal(verdict.kind, "skip", reason);
    assert.equal((verdict as { reason: string }).reason, reason);
  }
  assert.deepEqual(decide(plan, onDisk, facts({ nowMs: 400 }), false, null), { kind: "wait", untilMs: 500 });
  assert.deepEqual(decide(plan, onDisk, facts(), false, 900), { kind: "wait", untilMs: 1200 }, "spacing from the last dispatch");
  assert.deepEqual(decide(plan, onDisk, facts(), true, null), { kind: "stop", reason: "claimed" });
  assert.deepEqual(decide(plan, onDisk, facts({ skipReason: "skipped-in-tws" }), false, null), { kind: "vetoed", reason: "skipped-in-tws" });
  assert.deepEqual(decide(plan, onDisk, facts({ skipReason: "skipped-in-tws" }), true, null), { kind: "stop", reason: "claimed" }, "the claim beats a later veto");
  assert.deepEqual(decide(plan, { ...onDisk, state: "expired:ack" }, facts(), false, null), { kind: "stop", reason: "not-released" });
  assert.deepEqual(decide(plan, { ...onDisk, token: "rebound" }, facts(), false, null), { kind: "stop", reason: "not-released" });
});

test("O_EXCL files: one claimant, the first skip wins, no skip after a claim", () => {
  const { plan, ledgerDir } = fixture();
  assert.equal(createExclusive(join(ledgerDir, "x.claim"), "a"), true);
  assert.equal(createExclusive(join(ledgerDir, "x.claim"), "b"), false);
  assert.equal(readFileSync(join(ledgerDir, "x.claim"), "utf8"), "a");
  assert.equal(writeSkip(plan, "veto", "user-active"), true);
  assert.equal(writeSkip(plan, "process-end", "session-ended"), false, "a veto is never downgraded");
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).class, "veto");
  const other = fixture();
  createExclusive(join(other.ledgerDir, `${other.plan.key}.claim`), "{}");
  assert.equal(writeSkip(other.plan, "veto", "late"), false);
});

test("the dispatch lock admits one holder and is removed only by its owner", () => {
  const { ledgerDir } = fixture();
  const first = acquireDispatchLock(ledgerDir, "a");
  assert.ok(first);
  assert.equal(acquireDispatchLock(ledgerDir, "b"), undefined);
  assert.equal(json(join(ledgerDir, "dispatch.lock")).continuationId, "a", "content is complete when the lock appears");
  // a reconciler replaced the stale lock with a successor's lock
  rmSync(join(ledgerDir, "dispatch.lock"));
  const successor = acquireDispatchLock(ledgerDir, "c");
  releaseDispatchLock(first!);
  assert.ok(existsSync(join(ledgerDir, "dispatch.lock")), "the successor's lock survives");
  releaseDispatchLock(successor!);
  assert.equal(existsSync(join(ledgerDir, "dispatch.lock")), false);
});

test("a successor's dispatch lock survives even when its inode is reused", () => {
  const { ledgerDir } = fixture();
  const first = acquireDispatchLock(ledgerDir, "first");
  assert.ok(first);
  rmSync(join(ledgerDir, "dispatch.lock"));
  const successor = acquireDispatchLock(ledgerDir, "successor");
  assert.ok(successor);
  try {
    // Model immediate inode reuse independently of the host filesystem's allocator.
    releaseDispatchLock({ ...first, inode: successor.inode });
    assert.equal(existsSync(join(ledgerDir, "dispatch.lock")), true, "the successor's lock survives");
    assert.equal(json(join(ledgerDir, "dispatch.lock")).continuationId, "successor");
  } finally {
    releaseDispatchLock(successor);
  }
  assert.equal(existsSync(join(ledgerDir, "dispatch.lock")), false, "the actual owner releases it");
});

test("the continuation message states the stop, the elapsed time and the open tool call", () => {
  const { plan } = fixture();
  const text = continuationMessage(plan, plan.interruptedAtMs! + 14 * 86_400_000, "cid-1");
  assert.match(text, /^\[tmux-recovery\] Diese Session lief/);
  assert.match(text, /vor 14 Tagen/);
  assert.match(text, /`drill_block` \(call-1\)/);
  assert.match(text, /Prüfe zuerst den tatsächlichen Stand/);
  assert.match(text, /ist unbekannt/);
  assert.match(text, /continuationId=cid-1$/);
  assert.match(continuationMessage({ ...plan, toolCalls: [] }, plan.interruptedAtMs! + 30_000, "x"), /kein Werkzeugaufruf offen.*\n?/);
});

test("the last message entry ignores system and bookkeeping entries", () => {
  assert.equal(lastMessageEntryId([
    { id: "a", type: "message", message: { role: "user" } },
    { id: "b", type: "message", message: { role: "assistant" } },
    { id: "c", type: "context_edit" },
    { id: "d", type: "message", message: { role: "system" } },
  ]), "b");
  assert.equal(lastMessageEntryId([{ id: "m", type: "custom_message" }]), "m");
  assert.equal(lastMessageEntryId([]), null);
});

test("a test pause point is inert by default and blocks only while armed", () => {
  const { ledgerDir } = fixture();
  const started = Date.now();
  testCheckpoint(ledgerDir, "after-claim", {});
  assert.ok(Date.now() - started < 50, "inactive without env or file");
  assert.equal(existsSync(join(ledgerDir, ".test-reached-after-claim")), false);
  writeFileSync(join(ledgerDir, ".test-pause-at"), "after-claim\n");
  testCheckpoint(ledgerDir, "in-dispatch-lock", {});
  assert.equal(existsSync(join(ledgerDir, ".test-reached-in-dispatch-lock")), false, "only the named point");
  writeFileSync(join(ledgerDir, ".test-release-after-claim"), "");
  testCheckpoint(ledgerDir, "after-claim", {});
  assert.equal(json(join(ledgerDir, ".test-reached-after-claim")).pid, process.pid);
});

// -- executor -----------------------------------------------------------------

test("a released plan is dispatched once, admitted and finished", async () => {
  const { plan, planPath, ledgerDir } = fixture();
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent);
  run.start();
  await sleep(150);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.details.continuationId, run.continuationId);
  const claim = json(join(ledgerDir, `${plan.key}.claim`));
  assert.equal(claim.continuationId, run.continuationId);
  assert.ok(existsSync(join(ledgerDir, ".last-dispatch")));
  assert.equal(existsSync(join(ledgerDir, "dispatch.lock")), false, "the lock is released");
  assert.equal(run.state(), "dispatched");
  run.beforeAgentStart({ messageType: "custom", message: { customType: "tmux-recovery-continue", details: { continuationId: run.continuationId } } });
  assert.equal(json(join(ledgerDir, `${plan.key}.outcome`)).outcome, "admitted");
  run.agentSettled("done");
  run.agentSettled("failed");
  assert.equal(json(join(ledgerDir, `${plan.key}.outcome`)).outcome, "done", "only the continuation turn's outcome");
  run.shutdown();
  assert.equal(existsSync(join(ledgerDir, `${plan.key}.skip`)), false, "a claimed plan is never skipped");
});

test("user activity before the slot vetoes durably and nothing is sent", async () => {
  const { plan, planPath, ledgerDir } = fixture({ slotMs: Date.now() + 300 });
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent);
  run.start();
  await sleep(50);
  run.noteUserActivity();
  await sleep(400);
  assert.equal(sent.length, 0);
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).reason, "user-active");
  run.shutdown();
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).class, "veto", "shutdown does not downgrade the veto");
});

test("another run before the dispatch is a veto; a session end is a process-end skip", async () => {
  const busy = fixture({ slotMs: Date.now() + 300 });
  const run = executor(busy.planPath);
  run.start();
  run.beforeAgentStart({ messageType: "user" });
  assert.equal(json(join(busy.ledgerDir, `${busy.plan.key}.skip`)).reason, "busy");

  const ended = fixture({ slotMs: Date.now() + 300 });
  const other = executor(ended.planPath);
  other.start();
  other.shutdown();
  const skip = json(join(ended.ledgerDir, `${ended.plan.key}.skip`));
  assert.deepEqual([skip.class, skip.reason], ["process-end", "session-ended"]);
});

const twsVeto = (ledgerDir: string, key: string) =>
  writeFileSync(join(ledgerDir, `${key}.skip`), `${JSON.stringify({ class: "veto", reason: "skipped-in-tws", atMs: Date.now(), by: "tws" })}\n`, { flag: "wx" });

test("existing skips are read with their reason, and a damaged one is still a veto", () => {
  const { plan, ledgerDir } = fixture();
  assert.equal(existingSkipReason(plan), null);
  twsVeto(ledgerDir, plan.key);
  assert.equal(existingSkipReason(plan), "skipped-in-tws");
  const damaged = fixture();
  writeFileSync(join(damaged.ledgerDir, `${damaged.plan.key}.skip`), "");
  assert.equal(existingSkipReason(damaged.plan), "vetoed", "an empty file (still being written) counts");
});

test("a TWS veto before the claim ends the wait within a second, without a claim or a skip of its own", async () => {
  const { plan, planPath, ledgerDir } = fixture({ slotMs: Date.now() + 3000 });
  const sent: Sent[] = [];
  let changes = 0;
  const run = ContinuationExecutor.fromEnvironment(live(), (message) => sent.push({ message: message as never, at: Date.now() }), () => {
    changes += 1;
  }, { PI_TMUX_CONTINUE_PLAN: planPath, PI_TMUX_SESSION_WATCHDOG_ROOT: join(root, "no-watchdog") });
  assert.ok(run);
  run.start();
  await sleep(100);
  assert.deepEqual(run.status(), { state: "planned", reason: null, slot_ms: plan.slotMs, deadline_ms: plan.deadlineMs, key: plan.key, ledger_dir: ledgerDir });
  twsVeto(ledgerDir, plan.key);
  const vetoedAt = Date.now();
  while (run.state() === "planned" && Date.now() - vetoedAt < 2000) await sleep(20);
  assert.ok(Date.now() - vetoedAt <= 1100, `noticed after ${Date.now() - vetoedAt} ms`);
  assert.deepEqual([run.status().state, run.status().reason], ["skipped", "skipped-in-tws"]);
  assert.ok(changes >= 1, "the sidecar is refreshed");
  run.shutdown();
  assert.equal(sent.length, 0);
  assert.equal(existsSync(join(ledgerDir, `${plan.key}.claim`)), false);
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).by, "tws", "the veto is not replaced");
});

test("a TWS veto during the spacing wait stops the dispatch", async () => {
  const { plan, planPath, ledgerDir } = fixture({ spacingMs: 2500 });
  writeFileSync(join(ledgerDir, ".last-dispatch"), JSON.stringify({ atMs: Date.now() }));
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent);
  run.start();
  await sleep(200);
  assert.equal(run.state(), "planned", "waiting for the spacing");
  twsVeto(ledgerDir, plan.key);
  await sleep(1200);
  assert.equal(run.state(), "skipped:skipped-in-tws");
  await sleep(1500);
  assert.equal(sent.length, 0);
  assert.equal(existsSync(join(ledgerDir, `${plan.key}.claim`)), false);
});

test("a veto after the claim has no effect", async () => {
  const { plan, planPath, ledgerDir } = fixture();
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent);
  run.start();
  await sleep(150);
  assert.equal(run.state(), "dispatched");
  assert.equal(writeSkip(plan, "veto", "skipped-in-tws"), false, "the domain refuses a skip after a claim");
  twsVeto(ledgerDir, plan.key); // a writer that ignores the claim
  run.beforeAgentStart({ messageType: "custom", message: { customType: "tmux-recovery-continue", details: { continuationId: run.continuationId } } });
  run.agentSettled("done");
  assert.equal(sent.length, 1);
  assert.equal(run.status().state, "done");
  assert.equal(json(join(ledgerDir, `${plan.key}.outcome`)).outcome, "done");
});

test("the status follows the slot of the released plan", async () => {
  const { plan, planPath } = fixture({ state: "planned", slotMs: null, deadlineMs: null }, false);
  let changes = 0;
  const run = ContinuationExecutor.fromEnvironment(live({ ackResumed: () => undefined }), () => undefined, () => {
    changes += 1;
  }, { PI_TMUX_CONTINUE_PLAN: planPath, PI_TMUX_SESSION_WATCHDOG_ROOT: join(root, "no-watchdog") });
  assert.ok(run);
  run.start();
  assert.equal(changes, 1, "start publishes the planned state");
  await sleep(100);
  assert.deepEqual([run.status().slot_ms, run.status().deadline_ms], [null, null]);
  const slot = Date.now() + 5000;
  writeFileSync(planPath, JSON.stringify({ ...plan, state: "released", slotMs: slot, deadlineMs: slot + 600_000 }));
  writeFileSync(plan.readyPath, JSON.stringify({ tokens: { [plan.token]: { key: plan.key } } }));
  await sleep(1200);
  assert.deepEqual([run.status().state, run.status().slot_ms, run.status().deadline_ms], ["planned", slot, slot + 600_000]);
  assert.equal(changes, 2, "one refresh for the new slot");
  run.shutdown();
});

test("a ready.json without this token stops without sending", async () => {
  const { plan, planPath, ledgerDir } = fixture({}, false);
  writeFileSync(plan.readyPath, JSON.stringify({ tokens: {} }));
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent);
  run.start();
  await sleep(100);
  assert.equal(sent.length, 0);
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).reason, "not-released");
});

test("two executors of one key send once; executors of two keys keep the spacing", async () => {
  const shared = fixture();
  const sent: Sent[] = [];
  const a = executor(shared.planPath, live(), sent);
  const b = executor(shared.planPath, live(), sent);
  a.start();
  b.start();
  // past the spacing (300 ms) and several lock retries: the second executor
  // must stop at the claim, not merely wait for its slot
  await sleep(1500);
  assert.equal(sent.length, 1, "one claim per key");
  assert.deepEqual([a.state(), b.state()].sort(), ["dispatched", "stopped:claimed"]);

  const first = fixture();
  const second = fixture({ ledgerDir: first.ledgerDir });
  writeFileSync(join(first.ledgerDir, `${second.plan.key}.json`), JSON.stringify({ ...second.plan, ledgerDir: first.ledgerDir }));
  const spaced: Sent[] = [];
  const x = executor(first.planPath, live(), spaced);
  const y = executor(join(first.ledgerDir, `${second.plan.key}.json`), live(), spaced);
  x.start();
  y.start();
  await sleep(900);
  assert.equal(spaced.length, 2);
  assert.ok(spaced[1]!.at - spaced[0]!.at >= first.plan.spacingMs - 5, `gap ${spaced[1]!.at - spaced[0]!.at} ms`);
});

test("the spacing timestamp follows completion of a slow send", async () => {
  const { planPath, ledgerDir } = fixture();
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent, () => {
    // Model synchronous work during send without letting another timer interleave.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  });
  try {
    run.start();
    await sleep(150);
    assert.equal(sent.length, 1);
    const dispatchedAt = json(join(ledgerDir, ".last-dispatch")).atMs;
    assert.ok(dispatchedAt >= sent[0]!.at, "spacing starts only after the send completes");
  } finally {
    run.shutdown();
  }
});

test("a claim taken after the pre-check wins over this executor (O_EXCL)", async () => {
  const { plan, planPath, ledgerDir } = fixture();
  const claimPath = join(ledgerDir, `${plan.key}.claim`);
  const sent: Sent[] = [];
  // the live facts are read after the pre-check: another holder claims here
  const race = live({
    idle: () => {
      if (!existsSync(claimPath)) writeFileSync(claimPath, JSON.stringify({ continuationId: "other" }));
      return true;
    },
  });
  const run = executor(planPath, race, sent);
  run.start();
  await sleep(150);
  assert.equal(sent.length, 0);
  assert.equal(run.state(), "stopped:claimed");
  assert.equal(json(claimPath).continuationId, "other", "the foreign claim is untouched");
});

test("the dispatch lock is held while the message is sent", async () => {
  const { planPath, ledgerDir } = fixture();
  let probe: unknown = "not sent";
  const run = executor(planPath, live(), [], () => {
    // another executor trying to dispatch right now must find the lock taken
    probe = acquireDispatchLock(ledgerDir, "probe");
  });
  run.start();
  await sleep(150);
  assert.equal(probe, undefined, "the lock was free during the send");
  assert.equal(existsSync(join(ledgerDir, "dispatch.lock")), false, "released afterwards");
});

test("a veto that arrives during the dispatch section cannot interleave with it", async () => {
  const { plan, planPath, ledgerDir } = fixture();
  const sent: Sent[] = [];
  let run: ContinuationExecutor | undefined;
  // the activity is queued while the rules are checked; it may only run after the section
  const racing = live({
    idle: () => {
      queueMicrotask(() => run?.noteUserActivity());
      return true;
    },
  });
  run = executor(planPath, racing, sent);
  run.start();
  await sleep(150);
  const claimed = existsSync(join(ledgerDir, `${plan.key}.claim`));
  const vetoed = existsSync(join(ledgerDir, `${plan.key}.skip`));
  assert.ok(claimed !== vetoed, `claim and veto both or neither: claim=${claimed} veto=${vetoed}`);
  assert.equal(sent.length, claimed ? 1 : 0);
});

test("a busy dispatch lock is retried, never stolen", async () => {
  const { planPath, ledgerDir } = fixture();
  writeFileSync(join(ledgerDir, "dispatch.lock"), JSON.stringify({ pid: 1, continuationId: "other" }));
  const sent: Sent[] = [];
  const run = executor(planPath, live(), sent);
  run.start();
  await sleep(300);
  assert.equal(sent.length, 0);
  assert.equal(json(join(ledgerDir, "dispatch.lock")).continuationId, "other");
  rmSync(join(ledgerDir, "dispatch.lock"));
  await sleep(1200);
  assert.equal(sent.length, 1);
});

test("a throwing send leaves an uncertain outcome and releases the lock", async () => {
  const { plan, planPath, ledgerDir } = fixture();
  const run = executor(planPath, live(), [], () => {
    throw new Error("boom");
  });
  run.start();
  await sleep(150);
  assert.equal(json(join(ledgerDir, `${plan.key}.outcome`)).outcome, "uncertain");
  assert.ok(existsSync(join(ledgerDir, `${plan.key}.claim`)), "the claim stays: never resent");
  assert.equal(existsSync(join(ledgerDir, "dispatch.lock")), false);
});

test("a new message entry or an unknown acknowledgement prevents the dispatch", async () => {
  const moved = fixture();
  const sent: Sent[] = [];
  executor(moved.planPath, live({ branch: () => [{ id: "e9", type: "message", message: { role: "user" } }] }), sent).start();
  await sleep(150);
  assert.equal(sent.length, 0);
  assert.equal(json(join(moved.ledgerDir, `${moved.plan.key}.skip`)).reason, "new-entry");

  const pending = fixture();
  const waiting = executor(pending.planPath, live({ ackResumed: () => undefined }), sent);
  waiting.start();
  await sleep(150);
  assert.equal(sent.length, 0);
  assert.equal(waiting.state(), "planned", "waits while the acknowledgement is pending");
  waiting.shutdown();
});
