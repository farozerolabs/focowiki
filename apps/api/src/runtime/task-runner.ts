export type BoundedTaskRunner = {
  run: <T>(task: () => Promise<T>) => Promise<T>;
};

export function createBoundedTaskRunner(concurrency: number): BoundedTaskRunner {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive integer");
  }

  const queue: Array<() => void> = [];
  let active = 0;

  const drain = () => {
    if (active >= concurrency) {
      return;
    }

    const next = queue.shift();

    if (next) {
      active += 1;
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
