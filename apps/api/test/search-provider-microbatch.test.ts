import { describe, expect, it } from "vitest";
import { createSearchProviderMicrobatch } from
  "../src/document-indexing/application/search-provider-microbatch.js";

describe("search provider microbatch", () => {
  it("coalesces independent document writes and visibility refreshes", async () => {
    const writes: string[][] = [];
    let refreshes = 0;
    const provider = {
      kind: "opensearch" as const,
      write: {
        async writeDocuments(input: { documents: readonly { id: string }[] }) {
          writes.push(input.documents.map((document) => document.id));
          return { state: "completed" as const };
        },
        async refreshIndex() { refreshes += 1; }
      }
    };
    const batch = createSearchProviderMicrobatch({
      provider: provider as never,
      windowMs: 25,
      maximumDocuments: 100,
      maximumBytes: 1_000_000,
      async awaitReceipt() {}
    });
    const signal = new AbortController().signal;
    const first = batch.writeAcknowledged({
      indexUid: "index-a", documents: [{ id: "a" }], signal
    });
    const second = batch.writeAcknowledged({
      indexUid: "index-a", documents: [{ id: "b" }], signal
    });
    await batch.flush();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(writes).toEqual([["a", "b"]]);

    const visibleA = batch.makeVisible({ indexUid: "index-a", signal });
    const visibleB = batch.makeVisible({ indexUid: "index-a", signal });
    await batch.flush();
    await Promise.all([visibleA, visibleB]);
    expect(refreshes).toBe(1);
  });

  it("isolates a poison document while acknowledging unaffected work", async () => {
    const provider = {
      kind: "opensearch" as const,
      write: {
        async writeDocuments(input: { documents: readonly { id: string }[] }) {
          if (input.documents.some((document) => document.id === "poison")) {
            throw new Error("poison");
          }
          return { state: "completed" as const };
        },
        async refreshIndex() {}
      }
    };
    const batch = createSearchProviderMicrobatch({
      provider: provider as never,
      windowMs: 25,
      maximumDocuments: 100,
      maximumBytes: 1_000_000,
      async awaitReceipt() {}
    });
    const signal = new AbortController().signal;
    const healthy = batch.writeAcknowledged({
      indexUid: "index-a", documents: [{ id: "healthy" }], signal
    });
    const poison = batch.writeAcknowledged({
      indexUid: "index-a", documents: [{ id: "poison" }], signal
    });
    await batch.flush();
    await expect(healthy).resolves.toMatchObject({ documentIds: ["healthy"] });
    await expect(poison).rejects.toThrow("poison");
  });

  it("rejects every waiter when duplicate IDs carry conflicting documents", async () => {
    const provider = {
      kind: "opensearch" as const,
      write: {
        async writeDocuments() { return { state: "completed" as const }; },
        async refreshIndex() {}
      }
    };
    const batch = createSearchProviderMicrobatch({
      provider: provider as never,
      windowMs: 25,
      maximumDocuments: 100,
      maximumBytes: 1_000_000,
      async awaitReceipt() {}
    });
    const signal = new AbortController().signal;
    const first = batch.writeAcknowledged({
      indexUid: "index-a",
      documents: [{ id: "same", title: "first" } as never],
      signal
    });
    const second = batch.writeAcknowledged({
      indexUid: "index-a",
      documents: [{ id: "same", title: "second" } as never],
      signal
    });
    await batch.flush();
    const settled = Promise.allSettled([first, second]);
    await expect(Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))
    ])).resolves.not.toBe("timeout");
    await expect(settled).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" })
    ]);
  });
});
