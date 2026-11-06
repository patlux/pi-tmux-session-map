// Records whether this process received SIGHUP or SIGTERM, so a session_shutdown
// caused by a closed terminal, a dead tmux server or a reboot can be told apart
// from an interactive quit (both reach extensions as reason "quit").
//
// Pi's own handler starts the shutdown from the same signal dispatch. The
// listener here only sets a flag; consumers read it later, when the queued
// status write builds its payload: Node runs every signal listener
// synchronously before any promise continuation, so the flag is set by then
// regardless of listener order.

export type TerminationSignal = "SIGHUP" | "SIGTERM";

type SignalTarget = {
  prependListener(event: TerminationSignal, listener: () => void): unknown;
  removeListener(event: TerminationSignal, listener: () => void): unknown;
};

let recorded: TerminationSignal | null = null;

export function recordedTerminationSignal(): TerminationSignal | null {
  return recorded;
}

/** Test hook: forget a recorded signal. */
export function resetRecordedTerminationSignal(): void {
  recorded = null;
}

export type SignalEvidenceListener = {
  install(): void;
  uninstall(): void;
};

export function createSignalEvidenceListener(target: SignalTarget = process): SignalEvidenceListener {
  const listeners = new Map<TerminationSignal, () => void>();
  return {
    install() {
      if (listeners.size > 0) {
        return;
      }
      for (const signal of ["SIGHUP", "SIGTERM"] as const) {
        const listener = () => {
          recorded ??= signal;
        };
        listeners.set(signal, listener);
        target.prependListener(signal, listener);
      }
    },
    uninstall() {
      for (const [signal, listener] of listeners) {
        target.removeListener(signal, listener);
      }
      listeners.clear();
    },
  };
}
