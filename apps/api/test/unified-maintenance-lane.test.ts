import { describe, expect, it, vi } from "vitest";
import { createUnifiedMaintenanceLane } from
  "../src/document-indexing/application/unified-maintenance-lane.js";

describe("unified maintenance lane", () => {
  it("claims every class once per bounded interval without busy polling", async () => {
    let now = 1_000;
    const run = vi.fn(async () => undefined);
    const lane = createUnifiedMaintenanceLane({
      schedule: {
        mutation: 150,
        deletion: 100,
        maintenance: 200,
        orphan: 400
      },
      run,
      clock: () => now
    });
    expect(await lane.claim(10)).toHaveLength(4);
    expect(await lane.claim(10)).toEqual([]);
    now += 100;
    const next = await lane.claim(10);
    expect(next.map((item) => item.workClass)).toEqual(["deletion"]);
    await lane.process(next[0]!, new AbortController().signal);
    expect(run).toHaveBeenCalledWith("deletion", expect.any(AbortSignal));
  });
});
