import { describe, expect, it, vi } from "vitest";
import { readGeneratedContentWithMetrics } from "../src/application/generated-content-read.js";

describe("generated content read metrics", () => {
  it("reports metadata lookup and object transfer as separate bounded phases", async () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(31);
    const onComplete = vi.fn();

    const result = await readGeneratedContentWithMetrics({
      resolve: async () => ({ objectKey: "internal/object" }),
      read: async () => "# Content",
      now,
      onComplete
    });

    expect(result).toEqual({
      descriptor: { objectKey: "internal/object" },
      content: "# Content"
    });
    expect(onComplete).toHaveBeenCalledWith({
      metadataLookupMs: 4,
      objectTransferMs: 11,
      outcome: "found"
    });
  });

  it("reports missing metadata without starting object transfer", async () => {
    const onComplete = vi.fn();

    const result = await readGeneratedContentWithMetrics({
      resolve: async () => null,
      read: async () => "unused",
      now: vi.fn<() => number>().mockReturnValueOnce(5).mockReturnValueOnce(8),
      onComplete
    });

    expect(result).toEqual({ descriptor: null, content: null });
    expect(onComplete).toHaveBeenCalledWith({
      metadataLookupMs: 3,
      objectTransferMs: null,
      outcome: "not_found"
    });
  });

  it("reports the failed phase and preserves the original error", async () => {
    const failure = new Error("storage unavailable");
    const onComplete = vi.fn();

    await expect(
      readGeneratedContentWithMetrics({
        resolve: async () => ({ objectKey: "internal/object" }),
        read: async () => {
          throw failure;
        },
        now: vi
          .fn<() => number>()
          .mockReturnValueOnce(1)
          .mockReturnValueOnce(3)
          .mockReturnValueOnce(4)
          .mockReturnValueOnce(9),
        onComplete
      })
    ).rejects.toBe(failure);
    expect(onComplete).toHaveBeenCalledWith({
      metadataLookupMs: 2,
      objectTransferMs: 5,
      outcome: "failed"
    });
  });
});
