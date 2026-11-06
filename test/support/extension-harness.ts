// Loads the real extension against an isolated environment and a fake `tmux`.
// The extension reads its configuration at import time, so call
// `loadExtensionHarness()` before anything else imports src/index.ts.

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<void> | void;

export type FakeSession = {
  id: string;
  file: string;
  leafId: string | null;
  branch: Record<string, unknown>[];
  idle: boolean;
  editorText: string;
  /** Handlers registered through ctx.ui.onTerminalInput. */
  terminalInput: ((data: string) => unknown)[];
  ctx: Record<string, unknown>;
};

export type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> | undefined };

export async function loadExtensionHarness(paneKey = "tws_fixture_main:1.0") {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-ext-"));
  const failures = join(root, "remaining-failures");
  const fakeTmux = join(root, "tmux");
  writeFileSync(failures, "0");
  const [session, rest] = paneKey.split(":");
  const [window, pane] = (rest ?? "1.0").split(".");
  // While `remaining-failures` is positive, a call decrements it and hangs past
  // the extension's timeout, like a tmux server busy with a restore.
  writeFileSync(fakeTmux, `#!/bin/sh
remaining=$(cat '${failures}')
if [ "$remaining" -gt 0 ]; then
  echo $((remaining - 1)) > '${failures}'
  sleep 5
  exit 0
fi
printf '${paneKey}\\t${session}\\t${window}\\t${pane}\\t4242\\n'
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
  const module = await import("../../src/index.ts");

  return {
    root,
    statusDir: join(root, "tws", "pi-status"),
    setTmuxFailures(count: number) {
      writeFileSync(failures, String(count));
    },
    loadExtension(sent: SentMessage[] = []): Record<string, Handler> {
      const handlers: Record<string, Handler> = {};
      module.default({
        on: (name: string, handler: Handler) => { handlers[name] = handler; },
        sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => { sent.push({ message, options }); },
      } as never);
      return handlers;
    },
    session(id: string): FakeSession {
      const file = join(root, `${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`);
      const fake: FakeSession = {
        id,
        file,
        leafId: null,
        branch: [],
        idle: true,
        editorText: "",
        terminalInput: [],
        ctx: {},
      };
      fake.ctx = {
        mode: "tui",
        cwd: root,
        sessionManager: {
          getSessionFile: () => file,
          getSessionName: () => "Fixture",
          getSessionId: () => id,
          getLeafId: () => fake.leafId,
          getBranch: () => fake.branch,
        },
        isIdle: () => fake.idle,
        hasPendingMessages: () => false,
        ui: {
          getEditorText: () => fake.editorText,
          onTerminalInput: (handler: (data: string) => unknown) => {
            fake.terminalInput.push(handler);
            return () => undefined;
          },
        },
      };
      return fake;
    },
    readStatus(): Record<string, unknown> {
      const files = readdirSync(join(root, "tws", "pi-status")).filter((name: string) => name.endsWith(".json"));
      if (files.length !== 1) {
        throw new Error(`expected one status file, found ${files.length}`);
      }
      return JSON.parse(readFileSync(join(root, "tws", "pi-status", files[0]!), "utf8"));
    },
    readStatusFor(sessionId: string): Record<string, unknown> {
      const dir = join(root, "tws", "pi-status");
      for (const name of readdirSync(dir).filter((entry: string) => entry.endsWith(".json"))) {
        const status = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (status.session_id === sessionId) return status;
      }
      throw new Error(`no status file for ${sessionId}`);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
