// Executor side of tmux-recovery's auto-continue (tmux-recovery
// docs/pi-auto-continue.md §3.4, §3.5, §4.2). The restore engine plans and
// releases a ledger entry; this module decides, immediately before dispatch,
// whether the one visible continuation turn may start, and records it.
//
// Exclusivity: O_EXCL files only. `K.claim` is created with "wx" and never
// removed; `K.skip` is first-writer-wins, so a veto is never downgraded; the
// global dispatch lock is a hard link of a fully written file and is only
// removed by its owner (inode check) or by the restore engine's reconciler.
// Everything here is synchronous so a dispatch decision cannot interleave with
// user input or another turn in this process.

import {
  closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export const CONTINUE_CUSTOM_TYPE = "tmux-recovery-continue";

export type ContinuePlan = {
  schema: number;
  key: string;
  state: string;
  chain: number;
  token: string;
  paneKey: string;
  sessionId: string;
  sessionFile: string;
  frozenLeafId: string;
  interruptedAtMs: number | null;
  cause: "signal" | "hard" | null;
  toolCalls: { id: string; name: string }[];
  ledgerDir: string;
  readyPath: string;
  configPath: string;
  holdFile: string;
  spacingMs: number;
  slotMs: number | null;
  deadlineMs: number | null;
};

export function readPlan(path: string): ContinuePlan | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value?.key !== "string" || typeof value?.token !== "string" || typeof value?.ledgerDir !== "string") {
      return undefined;
    }
    return value as ContinuePlan;
  } catch {
    return undefined;
  }
}

export type ReadyState = "waiting" | "released" | "not-released";

export function readyState(plan: ContinuePlan): ReadyState {
  if (!existsSync(plan.readyPath)) {
    return "waiting";
  }
  try {
    const ready = JSON.parse(readFileSync(plan.readyPath, "utf8"));
    return ready?.tokens?.[plan.token] ? "released" : "not-released";
  } catch {
    return "waiting";
  }
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create `path` with `content` only if it does not exist (O_EXCL). */
export function createExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
  return true;
}

export function writeAtomicSync(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

export type SkipClass = "process-end" | "veto";

/** First writer wins: a veto written earlier is kept. */
export function writeSkip(plan: ContinuePlan, skipClass: SkipClass, reason: string, nowMs = Date.now()): boolean {
  if (existsSync(join(plan.ledgerDir, `${plan.key}.claim`))) {
    return false;
  }
  return createExclusive(
    join(plan.ledgerDir, `${plan.key}.skip`),
    `${JSON.stringify({ class: skipClass, reason, token: plan.token, pid: process.pid, atMs: nowMs })}\n`,
  );
}

export function writeOutcome(plan: ContinuePlan, outcome: string, continuationId: string, extra: Record<string, unknown> = {}): void {
  writeAtomicSync(
    join(plan.ledgerDir, `${plan.key}.outcome`),
    `${JSON.stringify({ outcome, continuationId, atMs: Date.now(), pid: process.pid, ...extra })}\n`,
  );
}

// -- dispatch lock -----------------------------------------------------------

export type DispatchLock = { path: string; inode: number };

export function acquireDispatchLock(ledgerDir: string, continuationId: string): DispatchLock | undefined {
  const path = join(ledgerDir, "dispatch.lock");
  const tmp = join(ledgerDir, `.dispatch.lock.${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, continuationId, atMs: Date.now() })}\n`, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw error;
  } finally {
    unlinkSync(tmp);
  }
  return { path, inode: statSync(path).ino };
}

export function releaseDispatchLock(lock: DispatchLock): void {
  try {
    if (statSync(lock.path).ino === lock.inode) {
      unlinkSync(lock.path);
    }
  } catch {
    // Already reclaimed; never touch a successor's lock.
  }
}

export function lastDispatchMs(ledgerDir: string): number | null {
  try {
    const value = JSON.parse(readFileSync(join(ledgerDir, ".last-dispatch"), "utf8"));
    return typeof value?.atMs === "number" ? value.atMs : null;
  } catch {
    return null;
  }
}

// -- executor rules E1-E7 ----------------------------------------------------

export type LiveFacts = {
  nowMs: number;
  ackResumed: boolean;
  sessionId: string;
  sessionFile: string | null;
  paneKey: string | null;
  lastMessageEntryId: string | null;
  idle: boolean;
  pendingMessages: boolean;
  editorText: string;
  userActive: boolean;
  promptOpen: boolean;
  watchdogAlive: boolean;
  mode: string;
  holdPresent: boolean;
};

export type Verdict =
  | { kind: "dispatch" }
  | { kind: "wait"; untilMs: number }
  | { kind: "skip"; skipClass: SkipClass; reason: string }
  | { kind: "stop"; reason: string };

/** E1-E7 against the plan as currently on disk. Caller holds the dispatch lock (E7). */
export function decide(plan: ContinuePlan, onDisk: ContinuePlan | undefined, facts: LiveFacts, ledgerHasClaim: boolean, lastDispatch: number | null): Verdict {
  // E1
  if (!facts.ackResumed) return { kind: "skip", skipClass: "process-end", reason: "ack" };
  // E7: plan state, claim, deadline, spacing
  if (!onDisk || onDisk.token !== plan.token || onDisk.state !== "released") return { kind: "stop", reason: "not-released" };
  if (ledgerHasClaim) return { kind: "stop", reason: "claimed" };
  if (onDisk.deadlineMs !== null && facts.nowMs > onDisk.deadlineMs) return { kind: "skip", skipClass: "process-end", reason: "timeout" };
  if (onDisk.slotMs !== null && facts.nowMs < onDisk.slotMs) return { kind: "wait", untilMs: onDisk.slotMs };
  if (lastDispatch !== null && facts.nowMs < lastDispatch + plan.spacingMs) return { kind: "wait", untilMs: lastDispatch + plan.spacingMs };
  // E6
  if (facts.mode !== "on") return { kind: "skip", skipClass: "veto", reason: "disabled" };
  if (facts.holdPresent) return { kind: "skip", skipClass: "veto", reason: "hold" };
  // E2
  if (facts.sessionId !== plan.sessionId || facts.sessionFile !== plan.sessionFile || facts.paneKey !== plan.paneKey) {
    return { kind: "skip", skipClass: "veto", reason: "identity" };
  }
  // E3
  if (facts.lastMessageEntryId !== plan.frozenLeafId) return { kind: "skip", skipClass: "veto", reason: "new-entry" };
  // E4
  if (facts.userActive || facts.editorText.trim() !== "" || facts.promptOpen) {
    return { kind: "skip", skipClass: "veto", reason: "user-active" };
  }
  if (!facts.idle || facts.pendingMessages) return { kind: "skip", skipClass: "veto", reason: "busy" };
  // E5
  if (facts.watchdogAlive) return { kind: "skip", skipClass: "veto", reason: "watchdog" };
  return { kind: "dispatch" };
}

export function readMode(configPath: string): string {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof value?.mode === "string" ? value.mode : "off";
  } catch {
    return "off";
  }
}

/** pi-session-watchdog keeps its pid file in /tmp/pi-session-watchdog-<session id>/. */
export function watchdogAlive(sessionId: string, root = "/tmp"): boolean {
  const pidFile = join(root, `pi-session-watchdog-${sessionId}`, "watchdog.pid");
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).includes("pi-session-watchdog");
  } catch {
    return true; // cannot tell: fail closed
  }
}

type BranchEntry = { id?: string; type?: string; message?: { role?: string } };

export function lastMessageEntryId(branch: readonly BranchEntry[]): string | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type === "custom_message" || (entry.type === "message" && entry.message?.role !== "system")) {
      return entry.id ?? null;
    }
  }
  return null;
}

// -- the visible message -----------------------------------------------------

function elapsedGerman(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const unit = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  if (seconds < 90) return unit(seconds, "Sekunde", "Sekunden");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return unit(minutes, "Minute", "Minuten");
  const hours = Math.round(minutes / 60);
  if (hours < 36) return unit(hours, "Stunde", "Stunden");
  return unit(Math.round(hours / 24), "Tag", "Tagen");
}

function dateGerman(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} um ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function continuationMessage(plan: ContinuePlan, nowMs: number, continuationId: string): string {
  const stopped = plan.interruptedAtMs ?? nowMs;
  const how = plan.cause === "hard" ? "abrupt beendet (Absturz oder Stromausfall)" : "beendet (Terminal geschlossen, tmux beendet oder Neustart)";
  const tools = plan.toolCalls.length > 0
    ? `Ohne Ergebnis unterbrochen: ${plan.toolCalls.map((call) => `\`${call.name}\` (${call.id})`).join(", ")}.`
    : "Es war kein Werkzeugaufruf offen.";
  return [
    `[tmux-recovery] Diese Session lief, als sie am ${dateGerman(stopped)} ${how} wurde, vor ${elapsedGerman(nowMs - stopped)}.`,
    "Pi wurde mit genau dieser Session wiederhergestellt.",
    tools,
    "Prüfe zuerst den tatsächlichen Stand (Dateien, Git, Prozesse, Remote-Effekte), bevor du eine Aktion wiederholst, die schon gelaufen sein kann.",
    "Ob Hintergrundprozesse, Subagents oder Remote-Jobs von vorher noch laufen und was sie getan haben, ist unbekannt: prüfe das, bevor du sie neu startest.",
    "Setze danach die ursprüngliche Aufgabe fort.",
    `continuationId=${continuationId}`,
  ].join("\n");
}
