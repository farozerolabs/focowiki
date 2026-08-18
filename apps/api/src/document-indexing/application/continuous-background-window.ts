export type ContinuousBackgroundWork = { publicId: string };

export function createContinuousBackgroundWindow<
  TWork extends ContinuousBackgroundWork
>(input: {
  capacity: number;
  claim(limit: number): Promise<readonly TWork[]>;
  process(work: TWork, signal: AbortSignal): Promise<void>;
  waitForWork(signal: AbortSignal): Promise<void>;
  onError?(error: unknown, work: TWork): void;
}) {
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > 1_000) {
    throw new Error("Continuous background window capacity is invalid");
  }

  return {
    async run(signal: AbortSignal): Promise<void> {
      const active = new Map<string, Promise<void>>();

      while (!signal.aborted) {
        const freeSlots = input.capacity - active.size;
        if (freeSlots > 0) {
          const claimed = await input.claim(freeSlots);
          if (claimed.length > freeSlots) {
            throw new Error("Background claim exceeded the requested window capacity");
          }
          for (const work of claimed) {
            if (!work.publicId || active.has(work.publicId)) {
              throw new Error("Background claim returned a duplicate or invalid identity");
            }
            const processing = Promise.resolve()
              .then(() => input.process(work, signal))
              .catch((error: unknown) => input.onError?.(error, work))
              .finally(() => {
                if (active.get(work.publicId) === processing) {
                  active.delete(work.publicId);
                }
              });
            active.set(work.publicId, processing);
          }
        }

        if (signal.aborted) break;
        await waitForRefillOpportunity(
          active,
          input.capacity,
          input.waitForWork,
          signal
        );
      }

      await Promise.allSettled([...active.values()]);
    }
  };
}

async function waitForRefillOpportunity(
  active: ReadonlyMap<string, Promise<void>>,
  capacity: number,
  waitForWork: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  if (active.size === 0) {
    await waitForWork(signal);
    return;
  }
  if (active.size >= capacity) {
    await Promise.race(active.values());
    return;
  }

  const waitController = new AbortController();
  const stopWait = () => waitController.abort(signal.reason);
  signal.addEventListener("abort", stopWait, { once: true });
  try {
    const wake = waitForWork(waitController.signal).catch((error: unknown) => {
      if (waitController.signal.aborted) return;
      throw error;
    });
    await Promise.race([
      ...active.values(),
      wake
    ]);
  } finally {
    signal.removeEventListener("abort", stopWait);
    waitController.abort();
  }
}
