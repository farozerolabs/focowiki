import { describe, expect, it, vi } from "vitest";
import { createSourceResourceMutationService } from "../src/application/source-resource-mutations.js";
import type { SourceResourceRepository } from "../src/application/ports/source-resource-repository.js";
import type { ResourceOperationRecord } from "../src/domain/source-resource.js";
import { SourceResourceError } from "../src/domain/source-resource.js";

describe("source resource mutations", () => {
  it("captures the final graph closure after the source is marked for deletion", async () => {
    const events: string[] = [];
    const acceptSourceFileDeletion = vi.fn(async () => {
      events.push("source_deleted");
      return {
        operation: {
          ...operation(),
          kind: "source_file_delete" as const
        },
        replayed: false,
        deletionIntentId: "deletion-intent-test",
        sourceFileId: "source-test",
        sourceMutation: {
          sourceFileId: "source-test",
          sourceRevisionId: "source-revision-test",
          kind: "source_deleted" as const,
          previousPath: "source.md",
          path: null,
          resourceRevision: 1
        }
      };
    });
    const getMutationClosures = vi.fn(async () => {
      events.push("closure_captured");
      return new Map([[
        "source-test",
        {
          neighborSourceFileIds: ["source-neighbor"],
          edgeIds: ["source-edge-test"]
        }
      ]]);
    });
    const commitMutation = vi.fn(async () => ({
      generationId: null,
      changeFactId: "change-test",
      impactCount: 0,
      replayed: false
    }));
    const enqueue = vi.fn(async () => ({ id: "role-job-test" }));
    const cancelSourceJobsForDeletionIntent = vi.fn(async () => 0);
    const service = createSourceResourceMutationService({
      repository: {
        acceptSourceFileDeletion
      } as unknown as SourceResourceRepository,
      roleJobs: {
        enqueue,
        cancelSourceJobsForDeletionIntent
      } as never,
      generations: { commitMutation },
      graph: { getMutationClosures },
      impactPlanner: {
        searchShardCount: 16,
        linkShardCount: 16,
        manifestShardCount: 16,
        treeShardCount: 16,
        graphNodeShardCount: 16,
        graphEdgeShardCount: 16
      },
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      storage: {
        sourceRevisionKey: () => "unused",
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined)
      },
      runtime: {
        clock: { now: () => new Date("2026-07-15T00:00:00.000Z") },
        ids: { create: (prefix) => `${prefix}-test` }
      }
    });

    await service.deleteSourceFile({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-test",
      idempotencyKey: "delete-source",
      expectedResourceRevision: 1,
      maxAttempts: 3
    });

    expect(events).toEqual(["source_deleted", "closure_captured"]);
    expect(commitMutation).toHaveBeenCalledWith(expect.objectContaining({
      kind: "source_deleted",
      deletionIntentId: "deletion-intent-test"
    }));
  });

  it("uses a unique object for identical replacements so conflict cleanup cannot delete accepted content", async () => {
    const createOperation = vi.fn()
      .mockResolvedValueOnce({ operation: operation(), replayed: false })
      .mockRejectedValueOnce(new SourceResourceError("RESOURCE_REVISION_CONFLICT"));
    const put = vi.fn(async (_entry: {
      key: string;
      body: Uint8Array;
      contentType: string;
    }) => undefined);
    const remove = vi.fn(async (_key: string) => undefined);
    let sequence = 0;
    const service = createSourceResourceMutationService({
      repository: { createOperation } as unknown as SourceResourceRepository,
      roleJobs: { enqueue: vi.fn(async () => ({ id: "role-job-test" })) } as never,
      generations: { commitMutation: vi.fn(async () => ({
        generationId: "generation-test",
        changeFactId: "change-test",
        impactCount: 1,
        replayed: false
      })) },
      impactPlanner: {
        searchShardCount: 16,
        linkShardCount: 16,
        manifestShardCount: 16,
        treeShardCount: 16,
        graphNodeShardCount: 16,
        graphEdgeShardCount: 16
      },
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      storage: {
        sourceRevisionKey: (_knowledgeBaseId, _sourceFileId, revision) => `revisions/${revision}.md`,
        put,
        delete: remove
      },
      runtime: {
        clock: { now: () => new Date("2026-07-15T00:00:00.000Z") },
        ids: { create: (prefix) => `${prefix}-${++sequence}` }
      }
    });
    const request = {
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-test",
      expectedResourceRevision: 1,
      bytes: new TextEncoder().encode("# Identical Markdown\n"),
      maxAttempts: 3
    };

    await expect(service.replaceSourceContent({
      ...request,
      idempotencyKey: "accepted-replacement"
    })).resolves.toMatchObject({ replayed: false });
    await expect(service.replaceSourceContent({
      ...request,
      idempotencyKey: "stale-replacement"
    })).rejects.toMatchObject({ code: "RESOURCE_REVISION_CONFLICT" });

    const storedKeys = put.mock.calls.map(([entry]) => entry.key);
    expect(storedKeys).toHaveLength(2);
    expect(storedKeys[0]).not.toBe(storedKeys[1]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(storedKeys[1]);
    expect(remove).not.toHaveBeenCalledWith(storedKeys[0]);
  });

  it("replays an identical replacement without retaining its duplicate storage object", async () => {
    let acceptedInput: Parameters<SourceResourceRepository["createOperation"]>[0] | null = null;
    const createOperation = vi.fn(async (
      input: Parameters<SourceResourceRepository["createOperation"]>[0]
    ) => {
      if (!acceptedInput) {
        acceptedInput = input;
        return { operation: operation(), replayed: false };
      }
      if (
        input.idempotencyKey !== acceptedInput.idempotencyKey
        || input.requestFingerprint !== acceptedInput.requestFingerprint
      ) {
        throw new SourceResourceError("IDEMPOTENCY_CONFLICT");
      }
      return { operation: operation(), replayed: true };
    });
    const put = vi.fn(async (_entry: {
      key: string;
      body: Uint8Array;
      contentType: string;
    }) => undefined);
    const remove = vi.fn(async () => undefined);
    let sequence = 0;
    const service = createSourceResourceMutationService({
      repository: { createOperation } as unknown as SourceResourceRepository,
      roleJobs: {
        enqueue: vi.fn(async () => ({ id: "role-job-test" }))
      } as never,
      generations: {
        commitMutation: vi.fn(async () => ({
          generationId: "generation-test",
          changeFactId: "change-test",
          impactCount: 1,
          replayed: false
        }))
      },
      impactPlanner: {
        searchShardCount: 16,
        linkShardCount: 16,
        manifestShardCount: 16,
        treeShardCount: 16,
        graphNodeShardCount: 16,
        graphEdgeShardCount: 16
      },
      publicationSettingsSnapshot: {
        publication: { mode: "batch", batchSize: 50, intervalSeconds: 30 }
      },
      storage: {
        sourceRevisionKey: (_knowledgeBaseId, _sourceFileId, revision) =>
          `revisions/${revision}.md`,
        put,
        delete: remove
      },
      runtime: {
        clock: { now: () => new Date("2026-07-15T00:00:00.000Z") },
        ids: { create: (prefix) => `${prefix}-${++sequence}` }
      }
    });
    const request = {
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-test",
      expectedResourceRevision: 1,
      idempotencyKey: "stable-replacement",
      bytes: new TextEncoder().encode("# Stable Markdown\n"),
      maxAttempts: 3
    };

    await expect(service.replaceSourceContent(request)).resolves.toMatchObject({
      replayed: false
    });
    await expect(service.replaceSourceContent(request)).resolves.toMatchObject({
      replayed: true
    });

    expect(createOperation).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    const storedKeys = put.mock.calls.map(([entry]) => entry.key);
    expect(remove).toHaveBeenCalledWith(storedKeys[1]);
    expect(remove).not.toHaveBeenCalledWith(storedKeys[0]);
  });
});

function operation(): ResourceOperationRecord {
  return {
    id: "resource-operation-test",
    knowledgeBaseId: "kb-test",
    kind: "source_file_replace",
    state: "accepted",
    expectedResourceRevision: 1,
    candidateCatalogGeneration: 1,
    result: null,
    errorCode: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    completedAt: null
  };
}
