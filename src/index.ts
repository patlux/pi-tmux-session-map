import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { open, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { cleanupStaleSessionMappings, cleanupStaleTempFiles, cleanupSupersededSessionMappings, cleanupSupersededStatusFiles, ensureDirectory, writeAtomic } from "./domain/atomic-write.ts";
import { createAsyncQueue } from "./domain/async-queue.ts";
import { createThrottledErrorReporter } from "./domain/error-reporter.ts";
import { PANE_KEY_FORMAT, defaultStateDir, mappingFileName, statusFileName } from "./domain/pane-key.ts";
import { parsePaneInfoOutput } from "./domain/pane-info.ts";
import { createRuntimeState, nextStatusTransition, refreshStatusTransition, type RuntimeState, type WorkState } from "./domain/state.ts";
import { buildTwsStatusPayload, serializeStatusPayload, type PaneInfo, type SessionInfo } from "./domain/status.ts";

const execFileAsync = promisify(execFile);
const stateDir = process.env.PI_TMUX_SESSION_MAP_STATE_DIR ?? defaultStateDir();
const twsConfigDir = process.env.PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR ?? join(homedir(), ".config", "tws");
const twsStatusDir = process.env.PI_TMUX_SESSION_MAP_TWS_STATUS_DIR ?? join(twsConfigDir, "pi-status");
const twsTriggerFile = process.env.PI_TMUX_SESSION_MAP_TWS_TRIGGER_FILE ?? join(twsConfigDir, "agent.trigger");
const tmuxBin = process.env.PI_TMUX_SESSION_MAP_TMUX_BIN ?? "tmux";
const tmuxTimeoutMs = 1000;
const cleanupMaxAgeMs = 24 * 60 * 60 * 1000;
const PANE_INFO_FORMAT = `${PANE_KEY_FORMAT}\t#{session_name}\t#{window_index}\t#{pane_index}`;

type StatusAction = WorkState | "refresh" | null;

type EventAction = {
  mapping: boolean;
  status: StatusAction;
  cleanup?: boolean;
};

async function resolvePaneInfo(): Promise<PaneInfo | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(
      tmuxBin,
      ["display-message", "-p", "-t", pane, PANE_INFO_FORMAT],
      { timeout: tmuxTimeoutMs },
    );
    return parsePaneInfoOutput(stdout, pane);
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
      const handle = await open(twsTriggerFile, "w", 0o600);
      await handle.close();
    } catch {
      // Status files are still picked up by tws on its periodic scan.
    }
  }
}

async function writeSessionMapping(info: PaneInfo, sessionFile: string): Promise<void> {
  const fileName = mappingFileName(info.paneKey);
  await ensureDirectory(stateDir);
  await writeAtomic(join(stateDir, fileName), `${sessionFile}\n`, 0o600);
  await cleanupSupersededSessionMappings(stateDir, fileName, sessionFile);
}

function getSessionInfo(ctx: ExtensionContext): SessionInfo {
  return {
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    sessionName: ctx.sessionManager.getSessionName() ?? null,
  };
}

async function writeTwsStatus(
  info: PaneInfo,
  session: SessionInfo,
  state: WorkState,
  updatedAtMs: number,
  startedAtMs: number | null,
  finishedAtMs: number | null,
): Promise<void> {
  const payload = buildTwsStatusPayload(info, session, state, updatedAtMs, startedAtMs, finishedAtMs);

  const fileName = statusFileName(info.paneKey);
  await ensureDirectory(twsStatusDir);
  await writeAtomic(join(twsStatusDir, fileName), serializeStatusPayload(payload), 0o600);
  await cleanupSupersededStatusFiles(twsStatusDir, fileName, info.paneId);
  await touchTwsTrigger();
}

async function cleanupStaleFiles(): Promise<void> {
  await cleanupStaleTempFiles(stateDir, cleanupMaxAgeMs);
  await cleanupStaleTempFiles(twsStatusDir, cleanupMaxAgeMs);
  await cleanupStaleSessionMappings(stateDir, 30 * cleanupMaxAgeMs);
}

async function applyEventAction(
  ctx: ExtensionContext,
  action: EventAction,
  runtimeState: RuntimeState,
): Promise<RuntimeState> {
  const session = getSessionInfo(ctx);
  const mappingSessionFile = action.mapping ? session.sessionFile : null;
  if (mappingSessionFile === null && action.status === null) {
    return runtimeState;
  }

  const info = await resolvePaneInfo();
  if (!info) {
    return runtimeState;
  }

  if (mappingSessionFile !== null) {
    await writeSessionMapping(info, mappingSessionFile);
  }

  if (action.status === null) {
    return runtimeState;
  }

  const now = Date.now();
  const transition =
    action.status === "refresh"
      ? refreshStatusTransition(runtimeState, now)
      : action.status === runtimeState.lastState
        ? refreshStatusTransition(runtimeState, now)
        : nextStatusTransition(runtimeState, action.status, now);
  if (!transition.shouldWrite) {
    return transition;
  }

  await writeTwsStatus(info, session, transition.state, now, transition.startedAtMs, transition.finishedAtMs);
  return transition;
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
  const queue = createAsyncQueue();
  const errorReporter = createThrottledErrorReporter();
  let runtimeState = createRuntimeState();

  const enqueue = async (ctx: ExtensionContext, action: EventAction) => {
    await queue.enqueue(async () => {
      try {
        if (action.cleanup === true) {
          await cleanupStaleFiles();
        }
        runtimeState = await applyEventAction(ctx, action, runtimeState);
      } catch (error) {
        errorReporter.report("pi-tmux-session-map: failed to update sidecars", error);
      }
    });
  };

  // Intentionally no cleanup on session_shutdown: the mapping must survive a
  // tmux server restart so resurrect can restore the exact session.
  pi.on("session_start", async (_event, ctx) => {
    await enqueue(ctx, { mapping: true, status: "idle", cleanup: true });
  });
  pi.on("session_info_changed", async (_event, ctx) => {
    await enqueue(ctx, { mapping: true, status: "refresh" });
  });
  pi.on("agent_start", async (_event, ctx) => {
    await enqueue(ctx, { mapping: true, status: "working" });
  });
  // Covers sessions whose file only exists after the first agent turn.
  pi.on("agent_end", async (_event, ctx) => {
    await enqueue(ctx, { mapping: true, status: "done" });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await enqueue(ctx, { mapping: false, status: "shutdown" });
  });
}
