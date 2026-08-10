import { describe, expect, it, vi } from "vitest";
import { createSemanticQueryEmbeddingGateway } from
  "../src/semantic/search/query-embedding.js";

describe("semantic query embedding gateway", () => {
  it("coalesces equal projection-bound queries and reuses a bounded cache", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const gateway = createSemanticQueryEmbeddingGateway({
      embed,
      maximumConcurrency: 2,
      maximumBacklog: 2,
      maximumCacheEntries: 2,
      cacheTtlMs: 10_000
    });
    const request = query("same query");
    const [first, second] = await Promise.all([
      gateway.embed(request), gateway.embed(request)
    ]);
    expect(first).toEqual([0.1, 0.2, 0.3]);
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(embed).toHaveBeenCalledOnce();
    await gateway.embed(request);
    expect(embed).toHaveBeenCalledOnce();

    await gateway.embed(query("second query"));
    await gateway.embed(query("third query"));
    await gateway.embed(request);
    expect(embed).toHaveBeenCalledTimes(4);
  });

  it("shares the exact model contract across knowledge bases without sharing authorization", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const gateway = createSemanticQueryEmbeddingGateway({
      embed,
      maximumConcurrency: 2,
      maximumBacklog: 2,
      maximumCacheEntries: 2,
      cacheTtlMs: 10_000
    });
    await gateway.embed(query("  Same   question  "));
    await gateway.embed({
      ...query("Same question"),
      knowledgeBaseId: "kb-secondary",
      semanticGenerationPublicId: "semantic-secondary"
    });
    expect(embed).toHaveBeenCalledOnce();
    await gateway.embed({ ...query("Same question"), normalization: "none" });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("separates model revisions and rejects an overflowing bounded backlog", async () => {
    const resolvers: Array<() => void> = [];
    const gateway = createSemanticQueryEmbeddingGateway({
      embed: async () => new Promise<readonly number[]>((resolve) => {
        resolvers.push(() => resolve([1, 0, 0]));
      }),
      maximumConcurrency: 1,
      maximumBacklog: 1,
      maximumCacheEntries: 1,
      cacheTtlMs: 1_000
    });
    const active = gateway.embed(query("one"));
    const queued = gateway.embed(query("two"));
    await expect(gateway.embed(query("three"))).rejects.toMatchObject({
      code: "semantic_query_embedding_backlog_full"
    });
    resolvers.shift()!();
    await active;
    await Promise.resolve();
    resolvers.shift()!();
    await queued;
    const revision = gateway.embed({
      ...query("one"),
      embeddingConfigurationRevisionPublicId: "embedding-revision-2"
    });
    await Promise.resolve();
    resolvers.shift()!();
    await revision;
  });

  it("cancels an in-flight endpoint request at its deadline", async () => {
    const gateway = createSemanticQueryEmbeddingGateway({
      embed: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      maximumConcurrency: 1,
      maximumBacklog: 1,
      maximumCacheEntries: 1,
      cacheTtlMs: 1_000
    });
    await expect(gateway.embed({ ...query("slow"), deadlineMs: 5 }))
      .rejects.toMatchObject({ code: "semantic_query_embedding_timeout" });
  });
});

function query(value: string) {
  return {
    knowledgeBaseId: "kb-main",
    semanticGenerationPublicId: "semantic-main",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    dimension: 3,
    normalization: "l2" as const,
    query: value,
    deadlineMs: 1_000,
    signal: null
  };
}
