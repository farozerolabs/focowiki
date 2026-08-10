import { describe, expect, it, vi } from "vitest";
import type { StorageVnextCandidateDelta } from
  "../src/storage-vnext/release/ports.js";
import { createStorageVnextSemanticPublicationHandoff } from
  "../src/storage-vnext/release/semantic-handoff.js";

describe("semantic publication overlap with maintenance", () => {
  it("rebases bounded CRUD facts into the existing maintenance release candidate", async () => {
    const addCandidateFacts = vi.fn(async () => maintenanceCandidate());
    const createCandidate = vi.fn();
    const getActiveRoot = vi.fn();
    const enqueue = vi.fn();
    const handoff = createStorageVnextSemanticPublicationHandoff({
      catalog: {
        getSourceFile: vi.fn(async () => ({
          publicId: "file-updated",
          knowledgeBaseId: "kb-1",
          directoryPublicId: null,
          logicalPath: "guides/updated.md",
          normalizedPath: "guides/updated.md",
          title: "Updated",
          metadata: {},
          currentRevisionPublicId: "revision-updated",
          status: "ready" as const,
          safeErrorCode: null,
          safeErrorMessage: null,
          revision: 2,
          visibility: "current" as const
        }))
      },
      releases: {
        getActiveRoot,
        getLiveCandidate: vi.fn(async () => maintenanceCandidate()),
        createCandidate,
        addCandidateFacts
      },
      workflow: { enqueue, rescheduleQueued: vi.fn(async () => false) },
      resultRetentionMilliseconds: 86_400_000
    });

    await expect(handoff.apply({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "file-updated",
      operationPublicId: "operation-crud-update",
      closure: {
        knowledgeBaseId: "kb-1",
        sourceFilePublicIds: ["file-updated"],
        sourceRevisionPublicIds: ["revision-updated"],
        entityPublicIds: ["entity-updated"],
        relationshipPublicIds: ["relationship-updated"],
        evidencePublicIds: ["evidence-updated"],
        reverseReferencePublicIds: ["reverse-updated"],
        vectorOwnerPublicIds: ["entity-updated"],
        dirtyPartitionKeys: ["partition-updated"],
        affectedFileNeighborPublicIds: ["file-neighbor"],
        generatedLogicalPaths: ["guides/updated.md"],
        graphShardPublicIds: ["graph-shard-updated"],
        searchShardPublicIds: ["search-shard-updated"]
      },
      settingsRevisionPublicId: "settings-1",
      publicationDelayMilliseconds: 0,
      completedAt: "2026-08-08T00:00:00.000Z"
    })).resolves.toEqual({ candidatePublicId: "maintenance-candidate" });

    expect(addCandidateFacts).toHaveBeenCalledOnce();
    expect(addCandidateFacts).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "maintenance-candidate",
      changedFacts: expect.arrayContaining([
        expect.objectContaining({
          kind: "semantic_entity",
          publicId: "entity-updated"
        }),
        expect.objectContaining({
          kind: "semantic_vector",
          publicId: "entity-updated"
        })
      ]),
      dependencies: expect.arrayContaining([
        expect.objectContaining({ kind: "semantic" }),
        expect.objectContaining({ kind: "vector" }),
        expect.objectContaining({ kind: "community" })
      ])
    }));
    expect(createCandidate).not.toHaveBeenCalled();
    expect(getActiveRoot).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("moves queued publication to the quiet edge without crossing maximum visibility", async () => {
    const candidate = {
      ...maintenanceCandidate(),
      operationPublicId: "operation-publication",
      createdAt: "2026-08-08T00:00:00.000Z"
    };
    const rescheduleQueued = vi.fn(async () => true);
    const handoff = createStorageVnextSemanticPublicationHandoff({
      catalog: {
        getSourceFile: vi.fn(async () => ({
          publicId: "file-updated",
          knowledgeBaseId: "kb-1",
          logicalPath: "guides/updated.md",
          currentRevisionPublicId: "revision-updated",
          status: "ready" as const,
          visibility: "current" as const
        } as any))
      },
      releases: {
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(async () => candidate),
        createCandidate: vi.fn(),
        addCandidateFacts: vi.fn(async () => candidate)
      },
      workflow: { enqueue: vi.fn(), rescheduleQueued },
      resultRetentionMilliseconds: 86_400_000
    });
    const request = {
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "file-updated",
      operationPublicId: "operation-crud-update",
      closure: {
        knowledgeBaseId: "kb-1",
        sourceFilePublicIds: ["file-updated"],
        sourceRevisionPublicIds: ["revision-updated"],
        entityPublicIds: [], relationshipPublicIds: [], evidencePublicIds: [],
        reverseReferencePublicIds: [], vectorOwnerPublicIds: [],
        dirtyPartitionKeys: [], affectedFileNeighborPublicIds: [],
        generatedLogicalPaths: [], graphShardPublicIds: [], searchShardPublicIds: []
      },
      settingsRevisionPublicId: "settings-1",
      publicationDelayMilliseconds: 300_000,
      publicationMaximumDelayMilliseconds: 900_000,
      completedAt: "2026-08-08T00:01:00.000Z"
    };

    await handoff.apply(request);
    await handoff.apply({
      ...request,
      completedAt: "2026-08-08T00:14:00.000Z"
    });

    expect(rescheduleQueued).toHaveBeenNthCalledWith(1, {
      publicId: "operation-publication",
      nextAttemptAt: "2026-08-08T00:06:00.000Z"
    });
    expect(rescheduleQueued).toHaveBeenNthCalledWith(2, {
      publicId: "operation-publication",
      nextAttemptAt: "2026-08-08T00:15:00.000Z"
    });
  });

  it("uses one target-contract publication identity during concurrent first handoff", async () => {
    let liveCandidate: StorageVnextCandidateDelta | null = null;
    const enqueuedOperationIds: string[] = [];
    const enqueuedCandidateIds: string[] = [];
    const handoff = createStorageVnextSemanticPublicationHandoff({
      catalog: {
        getSourceFile: vi.fn(async ({ publicId }: { publicId: string }) => ({
          publicId,
          knowledgeBaseId: "kb-1",
          logicalPath: `${publicId}.md`,
          currentRevisionPublicId: `revision-${publicId}`,
          status: "ready" as const,
          visibility: "current" as const
        } as any))
      },
      releases: {
        getActiveRoot: vi.fn(async () => null),
        getLiveCandidate: vi.fn(async () => liveCandidate),
        createCandidate: vi.fn(async (candidate: any) => {
          if (!liveCandidate) {
            const created: StorageVnextCandidateDelta = {
              ...maintenanceCandidate(),
              publicId: candidate.publicId,
              operationPublicId: candidate.operationPublicId,
              candidateRootPublicId: candidate.candidateRootPublicId,
              expectedActiveRootPublicId: null,
              expectedActiveRevision: 0
            };
            liveCandidate = created;
            return created;
          }
          if (liveCandidate.publicId === candidate.publicId) return liveCandidate;
          throw Object.assign(new Error("Live candidate exists"), {
            code: "live_candidate_exists"
          });
        }),
        addCandidateFacts: vi.fn(async () => liveCandidate!)
      },
      workflow: {
        enqueue: vi.fn(async (work: any) => {
          enqueuedOperationIds.push(work.publicId);
          enqueuedCandidateIds.push(String(work.checkpoint.candidatePublicId));
          await Promise.resolve();
          return { type: "live" as const, work };
        }),
        rescheduleQueued: vi.fn(async () => true)
      },
      resultRetentionMilliseconds: 86_400_000
    });
    const request = (sourceFilePublicId: string, operationPublicId: string) => ({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId,
      operationPublicId,
      closure: {
        knowledgeBaseId: "kb-1",
        sourceFilePublicIds: [sourceFilePublicId],
        sourceRevisionPublicIds: [`revision-${sourceFilePublicId}`],
        entityPublicIds: [], relationshipPublicIds: [], evidencePublicIds: [],
        reverseReferencePublicIds: [], vectorOwnerPublicIds: [],
        dirtyPartitionKeys: [], affectedFileNeighborPublicIds: [],
        generatedLogicalPaths: [], graphShardPublicIds: [], searchShardPublicIds: []
      },
      settingsRevisionPublicId: "settings-target-1",
      publicationDelayMilliseconds: 30_000,
      publicationMaximumDelayMilliseconds: 300_000,
      completedAt: "2026-08-08T00:00:00.000Z"
    });

    await Promise.all([
      handoff.apply(request("file-a", "operation-source-a")),
      handoff.apply(request("file-b", "operation-source-b"))
    ]);

    expect(new Set(enqueuedOperationIds)).toHaveLength(1);
    expect(new Set(enqueuedCandidateIds)).toHaveLength(1);
  });
});

function maintenanceCandidate(): StorageVnextCandidateDelta {
  return {
    publicId: "maintenance-candidate",
    knowledgeBaseId: "kb-1",
    operationPublicId: "operation-maintenance",
    candidateRootPublicId: "maintenance-root",
    expectedActiveRootPublicId: "active-root",
    expectedActiveRevision: 4,
    state: "building" as const,
    factRevision: 1,
    changedFactCount: 0,
    affectedDependencyCount: 0,
    manifestChecksum: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z"
  };
}
