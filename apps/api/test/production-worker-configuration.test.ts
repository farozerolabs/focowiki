import { describe, expect, it, vi } from "vitest";
import { waitForDocumentResourceCapacity } from
  "../src/document-indexing/infrastructure/production-runtime.js";

describe("production worker configuration gate", () => {
  it("waits for active generation and embedding configurations without terminating", async () => {
    const capacity = {
      documentConcurrency: 4,
      sourceObjectReadConcurrency: 4,
      generationModelConcurrency: 2,
      graphRagConcurrency: 2,
      embeddingConcurrency: 4,
      databaseConnectionLimit: 8,
      searchConcurrency: 8
    };
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(capacity);
    const wait = vi.fn(async () => undefined);
    const warn = vi.fn();

    await expect(waitForDocumentResourceCapacity({
      read,
      wait,
      warn,
      signal: new AbortController().signal,
      pollIntervalMs: 5_000
    })).resolves.toEqual(capacity);
    expect(wait).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("stops waiting when the worker is shutting down", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    await expect(waitForDocumentResourceCapacity({
      read: async () => null,
      wait: async () => controller.abort(reason),
      warn: () => undefined,
      signal: controller.signal,
      pollIntervalMs: 5_000
    })).rejects.toBe(reason);
  });
});
