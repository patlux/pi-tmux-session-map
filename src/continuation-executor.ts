// Timer, veto latch and admission tracking around src/domain/continuation.ts.
// index.ts forwards the Pi events; this class never registers handlers itself.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CONTINUE_CUSTOM_TYPE, acquireDispatchLock, continuationMessage, createExclusive, decide, lastDispatchMs,
  lastMessageEntryId, readMode, readPlan, readyState, releaseDispatchLock, testCheckpoint, watchdogAlive, writeAtomicSync,
  writeOutcome, writeSkip, type ContinuePlan, type LiveFacts,
} from "./domain/continuation.ts";

const POLL_MS = 1000;
const LOCK_RETRY_MS = 1000;
const ADMISSION_TIMEOUT_MS = 120_000;
/** Without a ready.json the restore never released this attempt. */
const READY_WAIT_LIMIT_MS = 30 * 60 * 1000;

export type LiveSource = {
  ackResumed(): boolean | undefined;
  paneKey(): string | null;
  sessionId(): string;
  sessionFile(): string | null;
  branch(): readonly { id?: string; type?: string; message?: { role?: string } }[];
  idle(): boolean;
  pendingMessages(): boolean;
  editorText(): string;
};

export type SendMessage = (
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
  options: { triggerTurn: boolean },
) => void;

export class ContinuationExecutor {
  readonly continuationId = randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private admissionTimer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;
  private claimed = false;
  private admitted = false;
  private outcomeWritten = false;
  private userActive = false;
  private promptDepth = 0;
  private startedAtMs = Date.now();
  private stateValue = "planned";
  readonly planPath: string;
  readonly plan: ContinuePlan;
  private readonly live: LiveSource;
  private readonly send: SendMessage;
  private readonly onChange: () => void;
  private readonly watchdogRoot: string;

  private constructor(planPath: string, plan: ContinuePlan, live: LiveSource, send: SendMessage, onChange: () => void, watchdogRoot: string) {
    this.planPath = planPath;
    this.plan = plan;
    this.live = live;
    this.send = send;
    this.onChange = onChange;
    this.watchdogRoot = watchdogRoot;
  }

  static fromEnvironment(live: LiveSource, send: SendMessage, onChange: () => void, env = process.env): ContinuationExecutor | undefined {
    const planPath = env.PI_TMUX_CONTINUE_PLAN;
    if (!planPath) return undefined;
    const plan = readPlan(planPath);
    if (!plan || plan.sessionId !== live.sessionId()) return undefined;
    return new ContinuationExecutor(planPath, plan, live, send, onChange, env.PI_TMUX_SESSION_WATCHDOG_ROOT ?? "/tmp");
  }

  /** Display value for the status sidecar `continue` field. */
  state(): string {
    return this.stateValue;
  }

  start(): void {
    this.startedAtMs = Date.now();
    this.schedule(0);
  }

  // -- events forwarded by index.ts -------------------------------------------

  noteUserActivity(): void {
    if (this.claimed || this.finished) return;
    this.userActive = true;
    this.skip("veto", "user-active");
  }

  notePrompt(open: boolean): void {
    this.promptDepth = Math.max(0, this.promptDepth + (open ? 1 : -1));
    if (open) this.noteUserActivity();
  }

  beforeAgentStart(event: { messageType?: string; message?: { customType?: string; details?: { continuationId?: string } } }): void {
    if (event.messageType === "custom" && event.message?.customType === CONTINUE_CUSTOM_TYPE
      && event.message.details?.continuationId === this.continuationId) {
      this.admit();
      return;
    }
    // Any other run before the dispatch is activity in this session.
    if (!this.claimed && !this.finished) {
      this.skip("veto", "busy");
    }
  }

  agentSettled(outcome: string): void {
    // Only the continuation turn's own outcome; later user runs are not ours.
    if (!this.admitted || this.outcomeWritten) return;
    this.outcomeWritten = true;
    writeOutcome(this.plan, outcome, this.continuationId);
    this.setState(outcome);
  }

  shutdown(): void {
    this.clearTimers();
    if (!this.claimed && !this.finished) {
      writeSkip(this.plan, "process-end", "session-ended");
      this.finish("skipped:session-ended");
    }
  }

  // -- internals ----------------------------------------------------------------

  private setState(value: string): void {
    this.stateValue = value;
    this.onChange();
  }

  private finish(value: string): void {
    this.finished = true;
    this.clearTimers();
    this.setState(value);
  }

  private skip(skipClass: "process-end" | "veto", reason: string): void {
    writeSkip(this.plan, skipClass, reason);
    this.finish(`skipped:${reason}`);
  }

  private clearTimers(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.clearTimers();
    if (this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.tick();
      } catch {
        // A file system error must not crash Pi; give up without dispatching.
        if (!this.claimed) this.finish("stopped:error");
      }
    }, Math.max(0, ms));
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.finished) return;
    const now = Date.now();
    switch (readyState(this.plan)) {
      case "waiting":
        if (now - this.startedAtMs > READY_WAIT_LIMIT_MS) {
          this.skip("process-end", "timeout");
        } else {
          this.schedule(POLL_MS);
        }
        return;
      case "not-released":
        this.skip("process-end", "not-released");
        return;
      case "released":
        break;
    }
    const onDisk = readPlan(this.planPath);
    if (onDisk?.slotMs != null && now < onDisk.slotMs && onDisk.token === this.plan.token) {
      this.schedule(onDisk.slotMs - now);
      return;
    }
    this.dispatchSection(now);
  }

  private facts(now: number): LiveFacts {
    return {
      nowMs: now,
      ackResumed: this.live.ackResumed() === true,
      sessionId: this.live.sessionId(),
      sessionFile: this.live.sessionFile(),
      paneKey: this.live.paneKey(),
      lastMessageEntryId: lastMessageEntryId(this.live.branch()),
      idle: this.live.idle(),
      pendingMessages: this.live.pendingMessages(),
      editorText: this.live.editorText(),
      userActive: this.userActive,
      promptOpen: this.promptDepth > 0,
      watchdogAlive: watchdogAlive(this.plan.sessionId, this.watchdogRoot),
      mode: readMode(this.plan.configPath),
      holdPresent: existsSync(this.plan.holdFile),
    };
  }

  /** One synchronous section: lock, E1-E7, claim, send, timestamp, unlock. */
  private dispatchSection(now: number): void {
    if (this.live.ackResumed() === undefined) {
      this.schedule(POLL_MS); // the acknowledgement is still pending
      return;
    }
    const lock = acquireDispatchLock(this.plan.ledgerDir, this.continuationId);
    if (!lock) {
      this.schedule(LOCK_RETRY_MS);
      return;
    }
    try {
      testCheckpoint(this.plan.ledgerDir, "in-dispatch-lock");
      const claimPath = join(this.plan.ledgerDir, `${this.plan.key}.claim`);
      // The pre-check runs under the dispatch lock; the O_EXCL claim below
      // still decides if another holder claimed in between (reclaimed lock).
      const claimedBefore = existsSync(claimPath);
      const verdict = decide(this.plan, readPlan(this.planPath), this.facts(now), claimedBefore, lastDispatchMs(this.plan.ledgerDir));
      switch (verdict.kind) {
        case "wait":
          this.schedule(verdict.untilMs - now);
          return;
        case "stop":
          this.finish(`stopped:${verdict.reason}`);
          return;
        case "skip":
          this.skip(verdict.skipClass, verdict.reason);
          return;
        case "dispatch":
          break;
      }
      const claim = { continuationId: this.continuationId, token: this.plan.token, key: this.plan.key, sessionId: this.plan.sessionId, pid: process.pid, claimedAtMs: now };
      if (!createExclusive(claimPath, `${JSON.stringify(claim)}\n`)) {
        this.finish("stopped:claimed");
        return;
      }
      this.claimed = true;
      testCheckpoint(this.plan.ledgerDir, "after-claim");
      try {
        this.send(
          { customType: CONTINUE_CUSTOM_TYPE, content: continuationMessage(this.plan, now, this.continuationId), display: true, details: { continuationId: this.continuationId } },
          { triggerTurn: true },
        );
        this.setState("dispatched");
        this.admissionTimer = setTimeout(() => {
          if (!this.admitted) {
            writeOutcome(this.plan, "uncertain", this.continuationId, { reason: "no-admission" });
            this.setState("uncertain");
          }
        }, ADMISSION_TIMEOUT_MS);
        this.admissionTimer.unref?.();
      } catch (error) {
        writeOutcome(this.plan, "uncertain", this.continuationId, { reason: `send failed: ${String(error)}` });
        this.setState("uncertain");
      }
      writeAtomicSync(join(this.plan.ledgerDir, ".last-dispatch"), `${JSON.stringify({ atMs: now, pid: process.pid, continuationId: this.continuationId })}\n`);
      this.finished = true;
    } finally {
      releaseDispatchLock(lock);
    }
  }

  private admit(): void {
    if (this.admitted) return;
    this.admitted = true;
    if (this.admissionTimer !== undefined) clearTimeout(this.admissionTimer);
    // A late admission upgrades an earlier `uncertain` (display only; never re-sent).
    writeOutcome(this.plan, "admitted", this.continuationId);
    this.setState("admitted");
  }
}
