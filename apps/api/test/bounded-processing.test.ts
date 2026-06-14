import { describe, expect, it } from "vitest";
import { iterateCursorPages, mapWithConcurrency } from "../src/runtime/bounded.js";

describe("bounded runtime processing helpers", () => {
  it("iterates database cursor pages with a bounded limit", async () => {
    const calls: Array<{ cursor: string | null; limit: number }> = [];
    const seen: number[] = [];

    for await (const item of iterateCursorPages({
      pageSize: 2,
      fetchPage: async ({ cursor, limit }) => {
        calls.push({ cursor, limit });

        if (!cursor) {
          return { items: [1, 2], nextCursor: "page-2" };
        }

        if (cursor === "page-2") {
          return { items: [3], nextCursor: null };
        }

        return { items: [], nextCursor: null };
      }
    })) {
      seen.push(item);
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(calls).toEqual([
      { cursor: null, limit: 2 },
      { cursor: "page-2", limit: 2 }
    ]);
  });

  it("rejects invalid page sizes before reading pages", async () => {
    await expect(async () => {
      for await (const _item of iterateCursorPages({
        pageSize: 0,
        fetchPage: async () => ({ items: [1], nextCursor: null })
      })) {
        // no-op
      }
    }).rejects.toThrow(/page size/i);
  });

  it("limits concurrent work", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
