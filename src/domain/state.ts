export type WorkState = "idle" | "working" | "done" | "shutdown";

export type RuntimeState = {
  startedAtMs: number | null;
  finishedAtMs: number | null;
  lastState: WorkState | null;
  sequence: number;
};

export type StatusTransition = RuntimeState & {
  state: WorkState;
  shouldWrite: boolean;
};

export function createRuntimeState(): RuntimeState {
  return {
    startedAtMs: null,
    finishedAtMs: null,
    lastState: null,
    sequence: 0,
  };
}

export function nextStatusTransition(
  current: RuntimeState,
  state: WorkState,
  nowMs: number,
): StatusTransition {
  const sequence = current.sequence + 1;

  if (state === "shutdown" && current.lastState === "done") {
    return {
      ...current,
      sequence,
      state,
      shouldWrite: false,
    };
  }

  if (state === "working") {
    return {
      startedAtMs: nowMs,
      finishedAtMs: null,
      lastState: "working",
      sequence,
      state,
      shouldWrite: true,
    };
  }

  if (state === "done") {
    return {
      startedAtMs: current.startedAtMs,
      finishedAtMs: current.finishedAtMs ?? nowMs,
      lastState: "done",
      sequence,
      state,
      shouldWrite: true,
    };
  }

  return {
    startedAtMs: state === "idle" ? null : current.startedAtMs,
    finishedAtMs: state === "idle" ? null : current.finishedAtMs,
    lastState: state,
    sequence,
    state,
    shouldWrite: true,
  };
}

export function refreshStatusTransition(current: RuntimeState, nowMs: number): StatusTransition {
  const state = current.lastState ?? "idle";

  if (state === "idle" && current.lastState === null) {
    return nextStatusTransition(current, "idle", nowMs);
  }

  if (state === "working" && current.startedAtMs === null) {
    return nextStatusTransition(current, "working", nowMs);
  }

  if (state === "done" && current.finishedAtMs === null) {
    return nextStatusTransition(current, "done", nowMs);
  }

  return {
    ...current,
    sequence: current.sequence + 1,
    state,
    shouldWrite: true,
  };
}
