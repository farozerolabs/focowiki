import { describe, expect, it } from "vitest";
import { createContinuousSlotScheduler } from "../src/worker/continuous-slot-scheduler.js";

describe("continuous slot scheduler", () => {
  it("refills a free slot before the slowest initial task completes", async () => {
    const started: number[] = [];
    const releases = new Map<number, () => void>();
    const scheduler = createContinuousSlotScheduler({ concurrency: 2 });
    const running = scheduler.run([1, 2, 3], async (value) => {
      started.push(value);
      await new Promise<void>((resolve) => releases.set(value, resolve));
      return value;
    });

    await waitFor(() => started.length === 2);
    releases.get(1)!();
    await waitFor(() => started.includes(3));
    expect(started).toEqual([1, 2, 3]);

    releases.get(2)!();
    releases.get(3)!();
    await expect(running).resolves.toEqual({ results: [1, 2, 3], unstarted: [] });
  });

  it("stops assigning new work after a stop result", async () => {
    const scheduler = createContinuousSlotScheduler({ concurrency: 1 });
    const result = await scheduler.run(
      [1, 2, 3],
      async (value) => value,
      { shouldStop: (value) => value === 2 }
    );

    expect(result).toEqual({ results: [1, 2], unstarted: [3] });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
