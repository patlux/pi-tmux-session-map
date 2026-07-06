export type AsyncQueue = {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
};

export function createAsyncQueue(): AsyncQueue {
  let tail = Promise.resolve();

  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const run = tail.then(operation, operation);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
