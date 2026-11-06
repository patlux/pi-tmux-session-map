import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Regression for the 2026-11-06 Tart host-mirror drill: a restored Pi started
// while the restore kept tmux busy, its 1 s `tmux display-message` timed out,
// and session_start returned before the one-shot restore acknowledgement. The
// restore then reported the correctly resumed pane as `unverified`.
//
// The extension reads its configuration at import time, so this file sets up an
// isolated environment first and imports the real extension afterwards.

const root = mkdtempSync(join(tmpdir(), "pi-tmux-restore-ack-"));
const ackDir = join(root, "acks");
const failures = join(root, "remaining-failures");
const calls = join(root, "calls");
const fakeTmux = join(root, "tmux");
writeFileSync(failures, "0");
writeFileSync(calls, "");
// Each call appends to `calls`. While `remaining-failures` is positive, a call
// decrements it and hangs past the extension's timeout, like a busy server.
writeFileSync(fakeTmux, `#!/bin/sh
echo call >> '${calls}'
remaining=$(cat '${failures}')
if [ "$remaining" -gt 0 ]; then
  echo $((remaining - 1)) > '${failures}'
  sleep 5
  exit 0
fi
printf 'tws_fixture_main:1.0\\ttws_fixture_main\\t1\\t0\\t4242\\n'
`);
chmodSync(fakeTmux, 0o755);

Object.assign(process.env, {
  TMUX: "/tmp/fixture-socket,4242,0",
  TMUX_PANE: "%7",
  PI_TMUX_SESSION_MAP_TMUX_BIN: fakeTmux,
  PI_TMUX_SESSION_MAP_STATE_DIR: join(root, "state"),
  PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR: join(root, "tws"),
  PI_TMUX_SESSION_MAP_RECONCILE_INTERVAL_MS: "3600000",
  PI_TMUX_SESSION_MAP_RESTORE_PANE_TIMEOUTS_MS: "300,300,600",
});
delete process.env.PI_SUBAGENT_CHILD;
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

const { default: tmuxSessionMap } = await import("../src/index.ts");

after(() => rmSync(root, { recursive: true, force: true }));

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<void> | void;

function loadExtension(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  tmuxSessionMap({ on: (name: string, handler: Handler) => { handlers[name] = handler; } } as never);
  return handlers;
}

function session(id: string) {
  const file = join(root, `${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`);
  return {
    file,
    ctx: {
      mode: "tui",
      cwd: root,
      sessionManager: {
        getSessionFile: () => file,
        getSessionName: () => "Fixture",
        getSessionId: () => id,
      },
    },
  };
}

function expectRestore(token: string, id: string, file: string): string {
  Object.assign(process.env, {
    PI_TMUX_RESTORE_TOKEN: token,
    PI_TMUX_EXPECTED_PANE: "tws_fixture_main:1.0",
    PI_TMUX_EXPECTED_SESSION_ID: id,
    PI_TMUX_EXPECTED_SESSION_FILE: file,
    PI_TMUX_RESTORE_ACK_DIR: ackDir,
  });
  return join(ackDir, `${token}.json`);
}

function readAck(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("a tmux timeout at session_start still produces the restore acknowledgement", async () => {
  const { file, ctx } = session("session-a");
  const ackPath = expectRestore("token-a", "session-a", file);
  writeFileSync(failures, "1");
  const handlers = loadExtension();
  await handlers.session_start!({ reason: "startup" }, ctx);
  await handlers.session_shutdown!({ reason: "quit" }, ctx);
  assert.ok(existsSync(ackPath), "restore acknowledgement was not written");
  const ack = readAck(ackPath);
  assert.equal(ack.status, "resumed");
  assert.equal(ack.actualSessionId, "session-a");
  assert.equal(ack.actualPaneKey, "tws_fixture_main:1.0");
});

test("a pending acknowledgement is written by the next successful event", async () => {
  const { file, ctx } = session("session-b");
  const ackPath = expectRestore("token-b", "session-b", file);
  writeFileSync(failures, "3");
  const handlers = loadExtension();
  await handlers.session_start!({ reason: "startup" }, ctx);
  assert.equal(existsSync(ackPath), false, "every pane lookup failed, so no acknowledgement yet");
  await handlers.agent_start!({}, ctx);
  await handlers.session_shutdown!({ reason: "quit" }, ctx);
  assert.equal(readAck(ackPath).status, "resumed");
});

test("the first acknowledgement for a token is never replaced", async () => {
  const restored = session("session-c");
  const ackPath = expectRestore("token-c", "session-c", restored.file);
  writeFileSync(failures, "0");
  let handlers = loadExtension();
  await handlers.session_start!({ reason: "startup" }, restored.ctx);
  await handlers.session_shutdown!({ reason: "new" }, restored.ctx);
  const first = readFileSync(ackPath, "utf8");
  // `/new` in the same process: a new extension instance starts with another session.
  const replacement = session("session-d");
  handlers = loadExtension();
  await handlers.session_start!({ reason: "new" }, replacement.ctx);
  await handlers.session_shutdown!({ reason: "quit" }, replacement.ctx);
  assert.equal(readFileSync(ackPath, "utf8"), first);
  assert.equal(readAck(ackPath).actualSessionId, "session-c");
});
