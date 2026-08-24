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
          planningMode: "initial" as const,
          affectedSourceFilePublicIds: [],
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
          planningMode: "initial" as const,
          affectedSourceFilePublicIds: [],
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

  it("keeps a lease current through cooperative CPU render checkpoints",
    async () => {
      let leaseExpiresAt = Date.now() + 20;
      const heartbeat = vi.fn(async () => {
        if (Date.now() >= leaseExpiresAt) return false;
        leaseExpiresAt = Date.now() + 20;
        return true;
      });
      const persistOutput = vi.fn(async () => undefined);
      const executor = createDocumentPublicationScopeGenerationExecutor({
        snapshots: {
          readScope: vi.fn(async () => snapshot({
            publicId: "scope-generation-cooperative"
          }))
        },
        leases: { heartbeat },
        heartbeatIntervalMs: 5,
        leaseDurationMs: 20,
      outputs: { persistOutput },
        render: vi.fn(async (_snapshot, _signal, checkpoint) => {
          for (let chunk = 0; chunk < 5; chunk += 1) {
            const until = performance.now() + 8;
            while (performance.now() < until) continue;
            await checkpoint();
          }
          return emptyOutput();
        })
      } as never);

      await expect(executor.execute({
        claim: {
          publicId: "scope-generation-cooperative",
          leaseGeneration: documentLeaseGeneration(6)
        },
        workerId: "worker-1",
        checkedAt: new Date().toISOString(),
        signal: new AbortController().signal
      })).resolves.toBeUndefined();
      expect(heartbeat.mock.calls.length).toBeGreaterThan(2);
      expect(persistOutput).toHaveBeenCalledOnce();
    });

  it("rejects an unfinished snapshot from another renderer contract",
    async () => {
      const persistOutput = vi.fn(async () => undefined);
      const executor = createDocumentPublicationScopeGenerationExecutor({
        supportedRendererContractVersion: "portable-okf-v3",
        snapshots: {
          readScope: vi.fn(async () => snapshot({
            publicId: "scope-generation-old-contract",
            rendererContractVersion: "portable-okf-v2"
          }))
        },
        outputs: { persistOutput },
        render: vi.fn(async () => emptyOutput())
      } as never);

      await expect(executor.execute({
        claim: {
          publicId: "scope-generation-old-contract",
          leaseGeneration: documentLeaseGeneration(7)
        },
        workerId: "worker-1",
        checkedAt: "2026-08-24T05:20:50.000Z",
        signal: new AbortController().signal
      })).rejects.toMatchObject({
        code: "publication_renderer_contract_incompatible"
      });
      expect(persistOutput).not.toHaveBeenCalled();
    });

  it("reports structural reuse separately from actual object writes",
    async () => {
      const onPersisted = vi.fn();
      const executor = createDocumentPublicationScopeGenerationExecutor({
        snapshots: {
          readScope: vi.fn(async () => snapshot({
            publicId: "scope-generation-delta-metrics",
            basePages: [
              { normalizedPath: "_index/pages/index.json", action: "put" },
              { normalizedPath: "_index/pages/part-a.json", action: "put" }
            ]
          }))
        },
        outputs: { persistOutput: vi.fn(async () => undefined) },
        render: vi.fn(async () => ({
          ...emptyOutput(),
          pages: [{
            logicalPath: "_index/pages/index.json",
            normalizedPath: "_index/pages/index.json",
            action: "put" as const,
            entryKind: "machine_index",
            objectId: "object-router",
            checksumSha256: "e".repeat(64),
            byteCount: 200
          }],
          verifiedReservations: [{
            objectId: "object-router",
            writeAttemptPublicId: "write-router"
          }],
          storageRequests: { put: 1, attemptedBytes: 200 },
          validationEvidence: { recordsRendered: 3 }
        })),
        onPersisted
      } as never);

      await executor.execute({
        claim: {
          publicId: "scope-generation-delta-metrics",
          leaseGeneration: documentLeaseGeneration(1)
        },
        workerId: "worker-metrics",
        checkedAt: "2026-08-24T09:00:00.000Z",
        signal: new AbortController().signal
      });

      expect(onPersisted).toHaveBeenCalledWith(expect.objectContaining({
        objectPutCount: 1,
        objectReuseCount: 1,
        putByteCount: 200,
        recordsRendered: 3
      }));
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
          planningMode: "initial" as const,
          affectedSourceFilePublicIds: [],
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

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    publicId: "scope-generation-1",
    publicationGenerationPublicId: "generation-1",
    knowledgeBaseId: "kb-1",
    scopeIdentity: "source:file-1",
    scopeKind: "source",
    scopeKey: "file-1",
    scopeGeneration: 4,
    targetFactEpoch: 7,
    inputSnapshotFingerprintSha256: "a".repeat(64),
    rendererContractVersion: "portable-okf-v3",
    planningMode: "delta",
    affectedSourceFilePublicIds: ["file-1"],
    deterministicChangedAt: "2026-08-21T12:00:00.000Z",
    baseGenerationPublicId: null,
    members: [],
    basePages: [],
    ...overrides
  } as never;
}

function emptyOutput() {
  return {
    outputFingerprintSha256: "f".repeat(64),
    validationEvidence: {},
    pages: [],
    navigationMutations: [],
    verifiedReservations: []
  };
}
