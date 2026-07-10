export type WorkState =
  | "idle"
  | "working"
  | "retrying"
  | "done"
  | "cancelled"
  | "incomplete"
  | "failed"
  | "shutdown";

export type FinalWorkState = "done" | "cancelled" | "incomplete" | "failed";

function isFinalWorkState(state: WorkState | null): state is FinalWorkState {
  return state === "done" || state === "cancelled" || state === "incomplete" || state === "failed";
}

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

  if (state === "shutdown" && isFinalWorkState(current.lastState)) {
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

  if (state === "retrying") {
    return {
      startedAtMs: current.startedAtMs ?? nowMs,
      finishedAtMs: null,
      lastState: "retrying",
      sequence,
      state,
      shouldWrite: true,
    };
  }

  if (isFinalWorkState(state)) {
    return {
      startedAtMs: current.startedAtMs,
      finishedAtMs: current.finishedAtMs ?? nowMs,
      lastState: state,
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

  if (isFinalWorkState(state) && current.finishedAtMs === null) {
    return nextStatusTransition(current, state, nowMs);
  }

  return {
    ...current,
    sequence: current.sequence + 1,
    state,
    shouldWrite: true,
  };
}
