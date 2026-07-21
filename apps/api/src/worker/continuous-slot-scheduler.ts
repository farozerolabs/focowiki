export function createContinuousSlotScheduler(input: { concurrency: number }) {
  assertPositiveInteger(input.concurrency, "concurrency");

  return {
    async run<TItem, TResult>(
      items: readonly TItem[],
      worker: (item: TItem, index: number) => Promise<TResult>,
      options: { shouldStop?: (result: TResult) => boolean } = {}
    ): Promise<{ results: TResult[]; unstarted: TItem[] }> {
      const results = new Map<number, TResult>();
      let nextIndex = 0;
      let stopped = false;
      const runners = Array.from(
        { length: Math.min(input.concurrency, items.length) },
        async () => {
          while (!stopped) {
            const index = nextIndex;
            const item = items[index];
            if (item === undefined) return;
            nextIndex += 1;
            const result = await worker(item, index);
            results.set(index, result);
            if (options.shouldStop?.(result)) stopped = true;
          }
        }
      );
      await Promise.all(runners);
      return {
        results: [...results.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, result]) => result),
        unstarted: items.slice(nextIndex)
      };
    }
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
