import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, open, rename, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PANE_KEY_FORMAT,
  defaultStateDir,
  mappingFileName,
  normalizePaneKey,
  statusFileName,
} from "./domain/pane-key.ts";

const execFileAsync = promisify(execFile);
const stateDir = defaultStateDir();
const twsConfigDir = join(homedir(), ".config", "tws");
const twsStatusDir = join(twsConfigDir, "pi-status");
const twsTriggerFile = join(twsConfigDir, "agent.trigger");
const PANE_INFO_FORMAT = `${PANE_KEY_FORMAT}\t#{session_name}\t#{window_index}\t#{pane_index}`;

type WorkState = "idle" | "working" | "done" | "shutdown";

type PaneInfo = {
  paneKey: string;
  paneId: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
};

type TwsStatusPayload = {
  schema: 1;
  agent: "pi";
  pane_id: string;
  pane_key: string;
  tmux_session_name: string;
  window_index: number;
  pane_index: number;
  cwd: string;
  session_file: string | null;
  session_name: string | null;
  state: WorkState;
  updated_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
};

function parseIndex(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function resolvePaneInfo(): Promise<PaneInfo | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "-t",
      pane,
      PANE_INFO_FORMAT,
    ]);
    const trimmed = stdout.trim();
    if (trimmed === "") {
      return undefined;
    }
    const [rawPaneKey, sessionName, rawWindowIndex, rawPaneIndex] = trimmed.split("\t");
    const paneKey = normalizePaneKey(rawPaneKey ?? "");
    if (!paneKey || !sessionName) {
      return undefined;
    }
    return {
      paneKey,
      paneId: pane,
      sessionName,
      windowIndex: parseIndex(rawWindowIndex ?? "0"),
      paneIndex: parseIndex(rawPaneIndex ?? "0"),
    };
  } catch {
    return undefined;
  }
}

async function touchTwsTrigger(): Promise<void> {
  const now = new Date();
  try {
    await utimes(twsTriggerFile, now, now);
  } catch {
    try {
      const handle = await open(twsTriggerFile, "w");
      await handle.close();
    } catch {
      // Status files are still picked up by tws on its periodic scan.
    }
  }
}

async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
}

async function writeSessionMapping(info: PaneInfo, sessionFile: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, mappingFileName(info.paneKey)), sessionFile + "\n", {
    mode: 0o600,
  });
}

async function writeTwsStatus(
  info: PaneInfo,
  ctx: ExtensionContext,
  state: WorkState,
  startedAtMs: number | null,
): Promise<void> {
  const now = Date.now();
  const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
  const payload: TwsStatusPayload = {
    schema: 1,
    agent: "pi",
    pane_id: info.paneId,
    pane_key: info.paneKey,
    tmux_session_name: info.sessionName,
    window_index: info.windowIndex,
    pane_index: info.paneIndex,
    cwd: ctx.cwd,
    session_file: sessionFile,
    session_name: ctx.sessionManager.getSessionName() ?? null,
    state,
    updated_at_ms: now,
    started_at_ms: startedAtMs,
    finished_at_ms: state === "done" ? now : null,
  };

  await mkdir(twsStatusDir, { recursive: true, mode: 0o700 });
  await writeAtomic(
    join(twsStatusDir, statusFileName(info.paneKey)),
    `${JSON.stringify(payload)}\n`,
    0o600,
  );
  await touchTwsTrigger();
}

function reportError(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${prefix}: ${message}`);
}

/**
 * Maps each tmux pane (session:window.pane) to the Pi session file running in
 * it, so tmux-resurrect can restore the exact session (e.g. via a
 * `pi-tmux-resume` wrapper) instead of blindly continuing the newest session
 * of the pane's working directory.
 *
 * Also writes tws-compatible Pi work-status sidecar JSON files so tws can show
 * a spinner while Pi is working and a checkmark when it finishes.
 */
export default function tmuxSessionMap(pi: ExtensionAPI) {
  let startedAtMs: number | null = null;
  let lastState: WorkState | null = null;

  const updateMapping = async (ctx: ExtensionContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      return;
    }
    const info = await resolvePaneInfo();
    if (!info) {
      return;
    }
    try {
      await writeSessionMapping(info, sessionFile);
    } catch (error) {
      reportError("pi-tmux-session-map: failed to write session mapping", error);
    }
  };

  const updateStatus = async (ctx: ExtensionContext, state: WorkState) => {
    // Never downgrade a finished marker to "shutdown": quitting Pi right after
    // it finished should keep the ✓ visible in tws.
    if (state === "shutdown" && lastState === "done") {
      return;
    }

    const info = await resolvePaneInfo();
    if (!info) {
      return;
    }
    try {
      const currentStartedAtMs = state === "working" ? Date.now() : startedAtMs;
      await writeTwsStatus(info, ctx, state, currentStartedAtMs);
      startedAtMs = state === "working" ? currentStartedAtMs : null;
      lastState = state;
    } catch (error) {
      reportError("pi-tmux-session-map: failed to write tws status", error);
    }
  };

  // Intentionally no cleanup on session_shutdown: the mapping must survive a
  // tmux server restart so resurrect can restore the exact session.
  pi.on("session_start", async (_event, ctx) => {
    await updateMapping(ctx);
    await updateStatus(ctx, "idle");
  });
  pi.on("session_info_changed", async (_event, ctx) => {
    await updateMapping(ctx);
    await updateStatus(ctx, lastState ?? "idle");
  });
  pi.on("agent_start", async (_event, ctx) => {
    await updateMapping(ctx);
    await updateStatus(ctx, "working");
  });
  // Covers sessions whose file only exists after the first agent turn.
  pi.on("agent_end", async (_event, ctx) => {
    await updateMapping(ctx);
    await updateStatus(ctx, "done");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await updateStatus(ctx, "shutdown");
  });
}
