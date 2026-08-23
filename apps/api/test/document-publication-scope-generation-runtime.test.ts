import { describe, expect, it, vi } from "vitest";
import { createDocumentPublicationScopeGenerationExecutor } from
  "../src/document-indexing/application/document-publication-scope-generation-runtime.js";
import { documentLeaseGeneration } from
  "../src/document-indexing/domain/document-publication-identifiers.js";

describe("document publication scope generation executor", () => {
  it("renders exclusively from the frozen immutable snapshot", async () => {
    const persistOutput = vi.fn(async () => undefined);
    const render = vi.fn(async (snapshot: { members: readonly unknown[] }) => {
      expect(snapshot.members).toEqual([{
        kind: "source_revision", publicId: "revision-1",
        version: "7", order: 0, sourceFilePublicId: "file-1"
      }]);
      return {
        outputFingerprintSha256: "f".repeat(64),
        validationEvidence: {},
        pages: [],
        navigationMutations: [],
        verifiedReservations: []
      };
    });
    const executor = createDocumentPublicationScopeGenerationExecutor({
      snapshots: {
        readScope: vi.fn(async () => ({
          publicId: "scope-generation-1",
          publicationGenerationPublicId: "generation-1",
          knowledgeBaseId: "kb-1",
          scopeIdentity: "source:file-1",
          scopeKind: "source",
          scopeKey: "file-1",
          scopeGeneration: 4,
          targetFactEpoch: 7,
          inputSnapshotFingerprintSha256: "a".repeat(64),
          rendererContractVersion: "portable-okf-v2",
          deterministicChangedAt: "2026-08-21T12:00:00.000Z",
          baseGenerationPublicId: null,
          members: [{
            kind: "source_revision", publicId: "revision-1",
            version: "7", order: 0, sourceFilePublicId: "file-1"
          }],
          basePages: []
        }))
      },
      outputs: { persistOutput },
      render
    });
    await executor.execute({
      claim: {
        publicId: "scope-generation-1",
        leaseGeneration: documentLeaseGeneration(3)
      },
      workerId: "worker-1",
      checkedAt: "2026-08-21T12:00:01.000Z",
      signal: new AbortController().signal
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(persistOutput).toHaveBeenCalledWith(expect.objectContaining({
      scopeGenerationPublicId: "scope-generation-1",
      leaseGeneration: 3
    }));
  });

  it("fences a late scope generation after durable heartbeat loss", async () => {
    const persistOutput = vi.fn();
    const heartbeat = vi.fn().mockResolvedValue(false);
    const executor = createDocumentPublicationScopeGenerationExecutor({
      snapshots: {
        readScope: vi.fn(async () => ({
          publicId: "scope-generation-lost",
          publicationGenerationPublicId: "generation-1",
          knowledgeBaseId: "kb-1",
          scopeIdentity: "source:file-1",
          scopeKind: "source",
          scopeKey: "file-1",
          scopeGeneration: 5,
          targetFactEpoch: 8,
          inputSnapshotFingerprintSha256: "a".repeat(64),
          rendererContractVersion: "portable-okf-v2",
          deterministicChangedAt: "2026-08-21T12:00:00.000Z",
          baseGenerationPublicId: null,
          members: [],
          basePages: []
        }))
      },
      leases: { heartbeat },
      heartbeatIntervalMs: 10,
      leaseDurationMs: 100,
      outputs: { persistOutput },
      render: vi.fn(async () => ({
        outputFingerprintSha256: "f".repeat(64),
        validationEvidence: {}, pages: [], navigationMutations: [],
        verifiedReservations: []
      }))
    });
    await expect(executor.execute({
      claim: {
        publicId: "scope-generation-lost",
        leaseGeneration: documentLeaseGeneration(4)
      },
      workerId: "worker-1",
      checkedAt: "2026-08-21T12:00:01.000Z",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "scope_generation_lease_lost" });
    expect(persistOutput).not.toHaveBeenCalled();
  });

  it("aborts a scope that exceeds its whole-execution deadline", async () => {
    const persistOutput = vi.fn();
    const stage = vi.fn();
    const executor = createDocumentPublicationScopeGenerationExecutor({
      snapshots: {
        readScope: vi.fn(async () => ({
          publicId: "scope-generation-timeout",
          publicationGenerationPublicId: "generation-1",
          knowledgeBaseId: "kb-1",
          scopeIdentity: "source:file-1",
          scopeKind: "source",
          scopeKey: "file-1",
          scopeGeneration: 6,
          targetFactEpoch: 9,
          inputSnapshotFingerprintSha256: "a".repeat(64),
          rendererContractVersion: "portable-okf-v2",
          deterministicChangedAt: "2026-08-21T12:00:00.000Z",
          baseGenerationPublicId: null,
          members: [],
          basePages: []
        }))
      },
      outputs: { persistOutput },
      maximumExecutionMs: 20,
      onStage: stage,
      render: vi.fn(async () => await new Promise<never>(() => undefined))
    });

    await expect(executor.execute({
      claim: {
        publicId: "scope-generation-timeout",
        leaseGeneration: documentLeaseGeneration(5)
      },
      workerId: "worker-1",
      checkedAt: "2026-08-21T12:00:01.000Z",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "scope_generation_deadline_exceeded" });
    expect(persistOutput).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      stage: "snapshot_load",
      outcome: "completed"
    }));
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      stage: "render",
      outcome: "failed",
      errorCode: "scope_generation_deadline_exceeded"
    }));
  });
});
