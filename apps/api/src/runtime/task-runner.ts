export type BoundedTaskRunner = {
  run: <T>(task: () => Promise<T>) => Promise<T>;
};

export function createBoundedTaskRunner(
  concurrency: number,
  options: { minStartIntervalMs?: number } = {}
): BoundedTaskRunner {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive integer");
  }

  const queue: Array<() => void> = [];
  const minStartIntervalMs = readMinStartIntervalMs(options.minStartIntervalMs);
  let active = 0;
  let nextStartAt = 0;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  const drain = () => {
    if (active >= concurrency || drainTimer || queue.length === 0) {
      return;
    }

    const delayMs = Math.max(0, nextStartAt - Date.now());

    if (delayMs > 0) {
      drainTimer = setTimeout(() => {
        drainTimer = null;
        drain();
      }, delayMs);
      return;
    }

    const next = queue.shift();

    if (next) {
      active += 1;
      nextStartAt = Date.now() + minStartIntervalMs;
      next();
    }
  };

  return {
    run: (task) =>
      new Promise((resolve, reject) => {
        queue.push(() => {
          task().then(resolve, reject).finally(() => {
            active -= 1;
            drain();
          });
        });
        drain();
      })
  };
}

function readMinStartIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Minimum start interval must be a non-negative integer");
  }

  return value;
}
