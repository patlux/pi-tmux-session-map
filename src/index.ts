import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { open, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { cleanupStaleSessionMappings, cleanupStaleTempFiles, cleanupSupersededStatusFiles, ensureDirectory, writeAtomic } from "./domain/atomic-write.ts";
import { createAsyncQueue } from "./domain/async-queue.ts";
import { createThrottledErrorReporter } from "./domain/error-reporter.ts";
import { publishSessionMapping } from "./domain/mapping-publisher.ts";
import { PANE_KEY_FORMAT, defaultStateDir, statusFileName } from "./domain/pane-key.ts";
import { parsePaneInfoOutput, parseZellijPaneInfo, mexPaneInfo } from "./domain/pane-info.ts";
import { ownsInteractivePane, paneOwnershipEvidence } from "./domain/pane-ownership.ts";
import { buildRestoreAck, restoreAckPath, restoreExpectationFromEnvironment, serializeRestoreAck } from "./domain/restore-ack.ts";
import { createRuntimeState, nextStatusTransition, refreshStatusTransition, type FinalWorkState, type RuntimeState, type WorkState } from "./domain/state.ts";
import { buildTwsStatusPayload, serializeStatusPayload, type PaneInfo, type SessionInfo } from "./domain/status.ts";

function execFileAsync(file: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: muxTimeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}
const stateDir = process.env.PI_TMUX_SESSION_MAP_STATE_DIR ?? defaultStateDir();
const twsConfigDir = process.env.PI_TMUX_SESSION_MAP_TWS_CONFIG_DIR ?? join(homedir(), ".config", "tws");
const twsStatusDir = process.env.PI_TMUX_SESSION_MAP_TWS_STATUS_DIR ?? join(twsConfigDir, "pi-status");
const twsTriggerFile = process.env.PI_TMUX_SESSION_MAP_TWS_TRIGGER_FILE ?? join(twsConfigDir, "agent.trigger");
const tmuxBin = process.env.PI_TMUX_SESSION_MAP_TMUX_BIN ?? "tmux";
const zellijBin = process.env.PI_TMUX_SESSION_MAP_ZELLIJ_BIN ?? "zellij";
const muxTimeoutMs = 1000;
const cleanupMaxAgeMs = 24 * 60 * 60 * 1000;
const reconcileIntervalMs = Math.max(
  10_000,
  Number.parseInt(process.env.PI_TMUX_SESSION_MAP_RECONCILE_INTERVAL_MS ?? "60000", 10) || 60_000,
);
const PANE_INFO_FORMAT = `${PANE_KEY_FORMAT}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pid}`;

type StatusAction = WorkState | "refresh" | null;

type EventAction = {
  mapping: boolean;
  status: StatusAction;
  cleanup?: boolean;
  restoreReason?: string;
  refreshPane?: boolean;
};

type ArtifactCache = {
  paneInfo: PaneInfo | undefined;
  paneInfoResolved: boolean;
  mappingSignature: string | null;
  statusSignature: string | null;
};

type AgentEndMessage = {
  role: string;
  stopReason?: string;
};

export function finalWorkStateForMessages(messages: readonly AgentEndMessage[]): FinalWorkState {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    switch (message.stopReason) {
      case "error":
        return "failed";
      case "aborted":
        return "cancelled";
      case "length":
        return "incomplete";
      default:
        return "done";
    }
  }
  return "done";
}

export function provisionalWorkState(finalState: FinalWorkState): WorkState {
  return finalState === "failed" ? "retrying" : finalState;
}

export async function resolvePaneInfo(): Promise<PaneInfo | undefined> {
  const tmuxPane = process.env.TMUX_PANE;
  if (process.env.TMUX && tmuxPane) {
    try {
      const { stdout } = await execFileAsync(
        tmuxBin,
        ["display-message", "-p", "-t", tmuxPane, PANE_INFO_FORMAT],
      );
      return parsePaneInfoOutput(stdout, tmuxPane);
    } catch {
      return undefined;
    }
  }

  const zellijSession = process.env.ZELLIJ_SESSION_NAME;
  const zellijPane = process.env.ZELLIJ_PANE_ID;
  if (process.env.ZELLIJ && zellijSession && zellijPane) {
    try {
      const { stdout } = await execFileAsync(
        zellijBin,
        ["--session", zellijSession, "action", "list-panes", "--json", "--all"],
      );
      return parseZellijPaneInfo(stdout, zellijSession, zellijPane);
    } catch {
      return undefined;
    }
  }

  const mexSession = process.env.MEX_SESSION;
  if (mexSession && !process.env.TMUX_PANE) {
    return mexPaneInfo(mexSession);
  }

  return undefined;
}

async function touchTwsTrigger(path = twsTriggerFile): Promise<void> {
  const now = new Date();
  try {
    await utimes(path, now, now);
  } catch {
    try {
      const handle = await open(path, "w", 0o600);
      await handle.close();
    } catch {
      // Status files are still picked up by tws on its periodic scan.
    }
  }
}

export function sessionMappingSignature(
  info: PaneInfo,
  session: SessionInfo,
  sessionId: string,
): string | null {
  if (session.sessionFile === null || info.backend !== "tmux") {
    return null;
  }
  return JSON.stringify([
    info.paneKey,
    info.paneId,
    info.tmuxServerPid,
    session.sessionFile,
    sessionId,
    session.cwd,
    session.sessionName,
  ]);
}

export function reconciliationDelayMs(identity: string, intervalMs = reconcileIntervalMs): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(identity, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % intervalMs;
}

export function twsStatusSignature(
  info: PaneInfo,
  session: SessionInfo,
  state: WorkState,
  startedAtMs: number | null,
  finishedAtMs: number | null,
): string {
  return JSON.stringify([
    info.backend,
    info.paneKey,
    info.paneId,
    info.tmuxServerPid,
    info.sessionName,
    info.windowIndex,
    info.paneIndex,
    session.cwd,
    session.sessionFile,
    session.sessionName,
    state,
    startedAtMs,
    finishedAtMs,
  ]);
}

async function writeSessionMapping(info: PaneInfo, session: SessionInfo, sessionId: string): Promise<boolean> {
  return (await publishSessionMapping(stateDir, info, session, sessionId)) !== undefined;
}

async function writeRestoreAcknowledgement(
  info: PaneInfo,
  session: SessionInfo,
  sessionId: string,
  reason: string,
): Promise<void> {
  const expectation = restoreExpectationFromEnvironment();
  if (!expectation) {
    return;
  }
  const ack = buildRestoreAck(expectation, info, session, sessionId, reason, Date.now());
  await ensureDirectory(expectation.ackDir);
  await writeAtomic(restoreAckPath(expectation), serializeRestoreAck(ack), 0o600);
}

function getSessionInfo(ctx: ExtensionContext): SessionInfo {
  return {
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    sessionName: ctx.sessionManager.getSessionName() ?? null,
  };
}

function statusDirectory(info: PaneInfo): string {
  switch (info.backend) {
    case "zellij":
      return process.env.PI_TMUX_SESSION_MAP_ZELLIJ_STATUS_DIR
        ?? join(homedir(), ".config", "tws-zellij", "pi-status");
    case "tmux":
    case "mex":
      // mex shares the default tws pi-status dir + trigger with tmux.
      return twsStatusDir;
  }
}

function triggerFile(info: PaneInfo): string {
  switch (info.backend) {
    case "zellij":
      return process.env.PI_TMUX_SESSION_MAP_ZELLIJ_TRIGGER_FILE
        ?? join(homedir(), ".config", "tws-zellij", "agent.trigger");
    case "tmux":
    case "mex":
      return twsTriggerFile;
  }
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

  const directory = statusDirectory(info);
  const fileName = statusFileName(info.paneKey);
  await ensureDirectory(directory);
  await writeAtomic(join(directory, fileName), serializeStatusPayload(payload), 0o600);
  await cleanupSupersededStatusFiles(directory, fileName, info.paneId);

  await touchTwsTrigger(triggerFile(info));
}

async function cleanupStaleFiles(): Promise<void> {
  const zellijStatusDir = process.env.PI_TMUX_SESSION_MAP_ZELLIJ_STATUS_DIR
    ?? join(homedir(), ".config", "tws-zellij", "pi-status");
  await cleanupStaleTempFiles(stateDir, cleanupMaxAgeMs);
  await cleanupStaleTempFiles(twsStatusDir, cleanupMaxAgeMs);
  await cleanupStaleTempFiles(zellijStatusDir, cleanupMaxAgeMs);
  await cleanupStaleSessionMappings(stateDir, 30 * cleanupMaxAgeMs);
}

async function applyEventAction(
  ctx: ExtensionContext,
  action: EventAction,
  runtimeState: RuntimeState,
  artifactCache: ArtifactCache,
): Promise<RuntimeState> {
  if (!ownsInteractivePane(paneOwnershipEvidence(ctx.mode, process.stdin.isTTY))) {
    return runtimeState;
  }

  const session = getSessionInfo(ctx);
  const mappingSessionFile = action.mapping ? session.sessionFile : null;
  if (mappingSessionFile === null && action.status === null) {
    return runtimeState;
  }

  if (action.refreshPane === true || !artifactCache.paneInfoResolved) {
    artifactCache.paneInfo = await resolvePaneInfo();
    artifactCache.paneInfoResolved = true;
  }
  const info = artifactCache.paneInfo;
  if (!info) {
    return runtimeState;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const mappingSignature = sessionMappingSignature(info, session, sessionId);
  if (mappingSessionFile !== null && mappingSignature !== null && mappingSignature !== artifactCache.mappingSignature) {
    const published = await writeSessionMapping(info, session, sessionId);
    artifactCache.mappingSignature = published ? mappingSignature : null;
  }

  if (action.restoreReason !== undefined && info.backend === "tmux") {
    await writeRestoreAcknowledgement(info, session, sessionId, action.restoreReason);
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

  const statusSignature = twsStatusSignature(
    info,
    session,
    transition.state,
    transition.startedAtMs,
    transition.finishedAtMs,
  );
  if (statusSignature === artifactCache.statusSignature) {
    return transition;
  }

  await writeTwsStatus(info, session, transition.state, now, transition.startedAtMs, transition.finishedAtMs);
  artifactCache.statusSignature = statusSignature;
  return transition;
}

/**
 * Maps each tmux pane (session:window.pane) to the Pi session file running in
 * it, so tmux-resurrect can restore the exact session (e.g. via a
 * `pi-tmux-resume` wrapper) instead of blindly continuing the newest session
 * of the pane's working directory.
 *
 * Also writes tws-compatible Pi work-status sidecar JSON files so tws can show
 * active/retrying state and distinguish successful, cancelled, incomplete, and
 * failed outcomes.
 */
export default function tmuxSessionMap(pi: ExtensionAPI) {
  const queue = createAsyncQueue();
  const errorReporter = createThrottledErrorReporter();
  let runtimeState = createRuntimeState();
  let pendingFinalState: FinalWorkState = "done";
  const artifactCache: ArtifactCache = {
    paneInfo: undefined,
    paneInfoResolved: false,
    mappingSignature: null,
    statusSignature: null,
  };

  const enqueue = async (ctx: ExtensionContext, action: EventAction) => {
    await queue.enqueue(async () => {
      try {
        if (action.cleanup === true) {
          await cleanupStaleFiles();
        }
        runtimeState = await applyEventAction(ctx, action, runtimeState, artifactCache);
      } catch (error) {
        errorReporter.report("pi-tmux-session-map: failed to update sidecars", error);
      }
    });
  };

  let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconciliationActive = false;

  const stopReconciliation = () => {
    reconciliationActive = false;
    if (reconciliationTimer !== undefined) {
      clearTimeout(reconciliationTimer);
      reconciliationTimer = undefined;
    }
  };

  const scheduleReconciliation = (ctx: ExtensionContext, delayMs: number) => {
    reconciliationTimer = setTimeout(async () => {
      reconciliationTimer = undefined;
      if (!reconciliationActive) {
        return;
      }
      await enqueue(ctx, { mapping: true, status: "refresh", refreshPane: true });
      if (reconciliationActive) {
        scheduleReconciliation(ctx, reconcileIntervalMs);
      }
    }, delayMs);
    reconciliationTimer.unref();
  };

  const startReconciliation = (ctx: ExtensionContext) => {
    stopReconciliation();
    if (
      !process.env.TMUX
      || !process.env.TMUX_PANE
      || !ownsInteractivePane(paneOwnershipEvidence(ctx.mode, process.stdin.isTTY))
    ) {
      return;
    }
    reconciliationActive = true;
    scheduleReconciliation(ctx, reconciliationDelayMs(process.env.TMUX_PANE));
  };

  // Intentionally no cleanup on session_shutdown: the mapping must survive a
  // tmux server restart so resurrect can restore the exact session.
  pi.on("session_start", async (event, ctx) => {
    artifactCache.paneInfo = undefined;
    artifactCache.paneInfoResolved = false;
    artifactCache.mappingSignature = null;
    artifactCache.statusSignature = null;
    runtimeState = createRuntimeState();
    await enqueue(ctx, {
      mapping: true,
      status: "idle",
      cleanup: true,
      restoreReason: event.reason,
      refreshPane: true,
    });
    startReconciliation(ctx);
  });
  pi.on("session_info_changed", async (_event, ctx) => {
    await enqueue(ctx, { mapping: true, status: "refresh", refreshPane: true });
  });
  pi.on("agent_start", async (_event, ctx) => {
    pendingFinalState = "done";
    await enqueue(ctx, { mapping: true, status: "working", refreshPane: true });
  });
  // agent_end may be followed by automatic retry/compaction. Keep failures
  // provisional until agent_settled confirms that no continuation will run.
  pi.on("agent_end", async (event, ctx) => {
    pendingFinalState = finalWorkStateForMessages(event.messages);
    await enqueue(ctx, {
      mapping: true,
      refreshPane: true,
      // Technical errors may still recover through Pi's automatic retry or
      // compaction flow. User aborts and token-limit responses are already
      // definitive and should not briefly look like retries.
      status: provisionalWorkState(pendingFinalState),
    });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await enqueue(ctx, { mapping: true, status: pendingFinalState });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopReconciliation();
    await enqueue(ctx, { mapping: false, status: "shutdown" });
    artifactCache.paneInfo = undefined;
    artifactCache.paneInfoResolved = false;
    artifactCache.mappingSignature = null;
    artifactCache.statusSignature = null;
    runtimeState = createRuntimeState();
  });
}
