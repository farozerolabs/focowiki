import { describe, expect, it } from "vitest";
import { boundedConcurrentMap } from
  "../src/document-indexing/application/bounded-concurrent-map.js";

describe("bounded concurrent map", () => {
  it("keeps order while bounding live operations", async () => {
    let active = 0;
    let maximum = 0;
    const results = await boundedConcurrentMap({
      values: [1, 2, 3, 4, 5],
      concurrency: 2,
      async map(value) {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      }
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBe(2);
  });

  it("stops assigning work after cancellation", async () => {
    const controller = new AbortController();
    let processed = 0;
    await expect(boundedConcurrentMap({
      values: [1, 2, 3], concurrency: 1, signal: controller.signal,
      async map() {
        processed += 1;
        controller.abort(new Error("cancelled"));
        return processed;
      }
    })).rejects.toThrow("cancelled");
    expect(processed).toBe(1);
  });
});
