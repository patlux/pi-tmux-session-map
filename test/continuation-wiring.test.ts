import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadExtensionHarness, type SentMessage } from "./support/extension-harness.ts";

// The extension wires the auto-continue executor (tmux-recovery
// docs/pi-auto-continue.md §4): only a restored, acknowledged startup with a
// plan from the restore engine runs it, and real user activity vetoes it.

const harness = await loadExtensionHarness();
const ackDir = join(harness.root, "acks");
mkdirSync(ackDir);
process.env.PI_TMUX_SESSION_WATCHDOG_ROOT = join(harness.root, "no-watchdog");
after(() => harness.cleanup());
let counter = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function restoredPi(id: string, slotDelayMs = 0) {
  counter += 1;
  const session = harness.session(id);
  session.branch = [{ id: "e1", type: "message", message: { role: "user" } }, { id: "e2", type: "message", message: { role: "assistant" } }];
  const dir = join(harness.root, `continue-${counter}`);
  const ledgerDir = join(dir, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  const plan = {
    schema: 1, key: `k${counter}`, state: "released", chain: 1, token: `t${counter}`, paneKey: "tws_fixture_main:1.0",
    sessionId: session.id, sessionFile: session.file, frozenLeafId: "e2", interruptedAtMs: Date.now() - 3_600_000, cause: "signal",
    toolCalls: [], ledgerDir, readyPath: join(dir, "ready.json"), configPath: join(dir, "continue.json"), holdFile: join(dir, "hold"),
    spacingMs: 100, slotMs: Date.now() + slotDelayMs, deadlineMs: Date.now() + 600_000,
  };
  const planPath = join(ledgerDir, `${plan.key}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(plan.configPath, JSON.stringify({ mode: "on" }));
  writeFileSync(plan.readyPath, JSON.stringify({ tokens: { [plan.token]: { key: plan.key } } }));
  Object.assign(process.env, {
    PI_TMUX_CONTINUE_PLAN: planPath,
    PI_TMUX_RESTORE_TOKEN: `restore-${counter}`,
    PI_TMUX_EXPECTED_PANE: "tws_fixture_main:1.0",
    PI_TMUX_EXPECTED_SESSION_ID: session.id,
    PI_TMUX_EXPECTED_SESSION_FILE: session.file,
    PI_TMUX_RESTORE_ACK_DIR: ackDir,
  });
  return { session, plan, ledgerDir, ack: join(ackDir, `restore-${counter}.json`) };
}

test("an acknowledged restore with a plan sends one visible continuation and admits it", async () => {
  const { session, plan, ledgerDir, ack } = restoredPi("wired");
  const sent: SentMessage[] = [];
  const handlers = harness.loadExtension(sent);
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  await sleep(200);
  assert.equal(json(ack).status, "resumed", "the acknowledgement comes first");
  assert.equal(sent.length, 1);
  const { message, options } = sent[0]!;
  assert.equal(message.customType, "tmux-recovery-continue");
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: true });
  const continuationId = (message.details as { continuationId: string }).continuationId;
  assert.match(message.content as string, new RegExp(`continuationId=${continuationId}$`));
  assert.equal(json(join(ledgerDir, `${plan.key}.claim`)).continuationId, continuationId);

  await handlers.before_agent_start!({ messageType: "custom", message }, session.ctx);
  await handlers.agent_start!({}, session.ctx);
  assert.equal(harness.readStatusFor(session.id).continue, "admitted");
  await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, session.ctx);
  await handlers.agent_settled!({ aborted: false }, session.ctx);
  assert.equal(json(join(ledgerDir, `${plan.key}.outcome`)).outcome, "done");
  await sleep(50);
  // found by the real-Pi layer B drill: a change of `continue` alone was deduplicated away
  assert.equal(harness.readStatusFor(session.id).continue, "done", "the sidecar shows the final outcome");
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
  assert.equal(sent.length, 1, "never a second message");
});

test("a keystroke before the slot vetoes the continuation", async () => {
  const { session, plan, ledgerDir } = restoredPi("typed", 400);
  const sent: SentMessage[] = [];
  const handlers = harness.loadExtension(sent);
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  assert.equal(session.terminalInput.length, 1, "the executor listens to terminal input");
  session.terminalInput[0]!("x");
  await sleep(600);
  assert.equal(sent.length, 0);
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).reason, "user-active");
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
});

test("interactive input vetoes; extension input does not", async () => {
  const typed = restoredPi("prompted", 400);
  const sent: SentMessage[] = [];
  const handlers = harness.loadExtension(sent);
  await handlers.session_start!({ reason: "startup" }, typed.session.ctx);
  await handlers.input!({ text: "/goal resume", source: "extension" }, typed.session.ctx);
  assert.equal(existsSync(join(typed.ledgerDir, `${typed.plan.key}.skip`)), false);
  await handlers.input!({ text: "weiter", source: "interactive" }, typed.session.ctx);
  assert.equal(json(join(typed.ledgerDir, `${typed.plan.key}.skip`)).reason, "user-active");
  await handlers.session_shutdown!({ reason: "quit" }, typed.session.ctx);

  const dialog = restoredPi("dialog", 400);
  const other = harness.loadExtension(sent);
  await other.session_start!({ reason: "startup" }, dialog.session.ctx);
  await other.ui_prompt_start!({ reason: "ui_prompt", kind: "confirm" }, dialog.session.ctx);
  assert.equal(json(join(dialog.ledgerDir, `${dialog.plan.key}.skip`)).reason, "user-active");
  await other.session_shutdown!({ reason: "quit" }, dialog.session.ctx);
  assert.equal(sent.length, 0);
});

test("no executor without a plan, for a resume, or for another session", async () => {
  const sent: SentMessage[] = [];
  delete process.env.PI_TMUX_CONTINUE_PLAN;
  const plain = harness.session("plain");
  const handlers = harness.loadExtension(sent);
  await handlers.session_start!({ reason: "startup" }, plain.ctx);
  assert.equal(plain.terminalInput.length, 0);
  await handlers.session_shutdown!({ reason: "quit" }, plain.ctx);

  const resumed = restoredPi("resumed");
  const second = harness.loadExtension(sent);
  await second.session_start!({ reason: "resume" }, resumed.session.ctx);
  assert.equal(resumed.session.terminalInput.length, 0, "only the startup of the restored process");
  await second.session_shutdown!({ reason: "quit" }, resumed.session.ctx);

  const foreign = restoredPi("planned");
  const stranger = harness.session("stranger");
  const third = harness.loadExtension(sent);
  await third.session_start!({ reason: "startup" }, stranger.ctx);
  await sleep(200);
  assert.equal(stranger.terminalInput.length, 0, "the plan names another session");
  assert.equal(existsSync(join(foreign.ledgerDir, `${foreign.plan.key}.claim`)), false);
  await third.session_shutdown!({ reason: "quit" }, stranger.ctx);
  assert.equal(sent.length, 0);
});

test("a mismatching acknowledgement skips without sending", async () => {
  const { session, plan, ledgerDir } = restoredPi("mismatch");
  process.env.PI_TMUX_EXPECTED_SESSION_ID = "someone-else";
  const sent: SentMessage[] = [];
  const handlers = harness.loadExtension(sent);
  await handlers.session_start!({ reason: "startup" }, session.ctx);
  await sleep(200);
  assert.equal(sent.length, 0);
  assert.equal(json(join(ledgerDir, `${plan.key}.skip`)).reason, "ack");
  await handlers.session_shutdown!({ reason: "quit" }, session.ctx);
});
