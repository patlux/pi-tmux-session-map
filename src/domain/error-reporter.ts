export type LogError = (message: string) => void;

export type ErrorReporter = {
  report(prefix: string, error: unknown, nowMs?: number): void;
};

type ErrorBucket = {
  lastLoggedAtMs: number;
  suppressed: number;
};

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createThrottledErrorReporter(
  windowMs = 60_000,
  log: LogError = console.error,
): ErrorReporter {
  const buckets = new Map<string, ErrorBucket>();

  return {
    report(prefix: string, error: unknown, nowMs = Date.now()): void {
      const message = formatError(error);
      const key = `${prefix}\n${message}`;
      const bucket = buckets.get(key);

      if (bucket && nowMs - bucket.lastLoggedAtMs < windowMs) {
        bucket.suppressed += 1;
        return;
      }

      const suppressed = bucket?.suppressed ?? 0;
      buckets.set(key, { lastLoggedAtMs: nowMs, suppressed: 0 });
      const suffix = suppressed > 0 ? ` (suppressed ${suppressed} similar error${suppressed === 1 ? "" : "s"})` : "";
      log(`${prefix}: ${message}${suffix}`);
    },
  };
}
