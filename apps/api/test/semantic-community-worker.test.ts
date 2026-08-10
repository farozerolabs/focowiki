import { describe, expect, it, vi } from "vitest";
import {
  GRAPHRAG_RESPONSE_SCHEMA,
  type GraphRagAdapterResponse
} from "../src/semantic/graphrag/contracts.js";
import { createCommunityPartitionWorker } from
  "../src/semantic/application/community-worker.js";

describe("semantic community partition worker", () => {
  it("clusters and summarizes only one bounded dirty partition", async () => {
    const run = vi.fn(async (request: { requestId: string }) => ({
      schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
      requestId: request.requestId,
      ok: true,
      result: { communities: [{ communityId: "community-ab", level: 0, members: ["entity-a", "entity-b", "boundary-z"] }] }
    }) as GraphRagAdapterResponse);
    const replacePartition = vi.fn(async () => "created" as const);
    const publishLocal = vi.fn(async () => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const worker = createCommunityPartitionWorker({
      pool: { run },
      isCurrent: async () => true,
      summarize: async ({ entityPublicIds }) => `Community: ${entityPublicIds.join(", ")}`,
      replacePartition,
      publishLocal,
      checkpoint
    });
    await expect(worker.process(work())).resolves.toEqual({
      outcome: "created", outputCount: 1
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      operation: "cluster",
      edges: expect.arrayContaining([expect.objectContaining({
        sourceEntityId: "entity-a", targetEntityId: "entity-b"
      })])
    }), expect.objectContaining({ timeoutMs: 5_000 }));
    expect(replacePartition).toHaveBeenCalledWith(expect.objectContaining({
      outputs: [expect.objectContaining({
        entityPublicIds: ["entity-a", "entity-b"]
      })]
    }));
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "completed"
    }));
    expect(publishLocal).toHaveBeenCalledOnce();
  });

  it("rejects stale output before persistence", async () => {
    let checks = 0;
    const replacePartition = vi.fn();
    const checkpoint = vi.fn(async () => undefined);
    const worker = createCommunityPartitionWorker({
      pool: { run: async (request) => ({
        schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
        requestId: request.requestId,
        ok: true,
        result: { communities: [{ communityId: "community-a", level: 0, members: ["entity-a"] }] }
      }) },
      isCurrent: async () => ++checks === 1,
      summarize: async () => "Summary",
      replacePartition,
      checkpoint
    });
    await expect(worker.process(work())).resolves.toEqual({
      outcome: "superseded", outputCount: 0
    });
    expect(replacePartition).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "superseded"
    }));
  });

  it("records retry or cancellation without publishing partial output", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const worker = createCommunityPartitionWorker({
      pool: { run: async () => { throw new Error("adapter unavailable"); } },
      isCurrent: async () => true,
      summarize: async () => "Summary",
      replacePartition: async () => "updated",
      checkpoint
    });
    await expect(worker.process(work())).rejects.toThrow("adapter unavailable");
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "retry", safeCode: "community_dependency_failed"
    }));

    checkpoint.mockClear();
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(worker.process(work(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "cancelled", safeCode: "community_cancelled"
    }));
  });

  it("rejects a partial boundary-only community before report replacement", async () => {
    const replacePartition = vi.fn();
    const checkpoint = vi.fn(async () => undefined);
    const worker = createCommunityPartitionWorker({
      pool: { run: async (request) => ({
        schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
        requestId: request.requestId,
        ok: true,
        result: { communities: [
          { communityId: "community-local", level: 0, members: ["entity-a"] },
          { communityId: "community-boundary", level: 0, members: ["boundary-z"] }
        ] }
      }) },
      isCurrent: async () => true,
      summarize: async () => "Summary",
      replacePartition,
      checkpoint
    });
    await expect(worker.process(work())).rejects.toThrow("no local member");
    expect(replacePartition).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "retry"
    }));
  });

  it("changes report identity input when the bounded boundary changes", async () => {
    const checksums: string[] = [];
    const worker = createCommunityPartitionWorker({
      pool: { run: async (request) => ({
        schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
        requestId: request.requestId,
        ok: true,
        result: { communities: [{
          communityId: "community-a", level: 0, members: ["entity-a"]
        }] }
      }) },
      isCurrent: async () => true,
      summarize: async () => "Stable summary",
      replacePartition: async ({ outputs }) => {
        checksums.push(outputs[0]!.checksumSha256);
        return "updated";
      },
      checkpoint: async () => undefined
    });
    await worker.process(work());
    await worker.process({ ...work(), boundaryVersion: "boundary-v2" });
    expect(checksums[0]).not.toBe(checksums[1]);
  });

  it("rejects a corpus-sized Node payload before calling Python", async () => {
    const run = vi.fn();
    const worker = createCommunityPartitionWorker({
      pool: { run },
      isCurrent: async () => true,
      summarize: async () => "Summary",
      replacePartition: async () => "created",
      checkpoint: async () => undefined
    });
    await expect(worker.process({
      ...work(),
      entityPublicIds: Array.from({ length: 10_001 }, (_, index) => `entity-${index}`)
    })).rejects.toThrow("invalid");
    expect(run).not.toHaveBeenCalled();
  });
});

function work() {
  return {
    knowledgeBaseId: "kb-main",
    semanticGenerationPublicId: "generation-main",
    partitionPublicId: "partition-main",
    partitionKey: "entity-ab",
    inputVersion: "graph-v2",
    boundaryVersion: "boundary-v1",
    entityPublicIds: ["entity-a", "entity-b"],
    localRelationships: [{
      publicId: "relationship-ab", fromEntityPublicId: "entity-a",
      toEntityPublicId: "entity-b", weight: 1
    }],
    boundaryRelationships: [{
      publicId: "relationship-bz", fromEntityPublicId: "entity-b",
      toEntityPublicId: "boundary-z", weight: 1
    }],
    timeoutMs: 5_000
  };
}
