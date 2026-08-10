import { describe, expect, it, vi } from "vitest";
import { createSemanticStageRoleRuntime } from
  "../src/semantic/application/stage-role-runtime.js";
import type { SemanticStageRepositoryPort } from
  "../src/semantic/application/stage-ports.js";

describe("semantic stage role runtime", () => {
  it("recovers expired leases and runs a bounded fair claim batch", async () => {
    const abort = new AbortController();
    const claims = [claim("kb-a"), claim("kb-b")];
    const repository = repositoryStub({
      recoverExpired: vi.fn(async () => 1),
      claim: vi.fn(async () => claims)
    });
    const runClaim = vi.fn(async () => {
      if (runClaim.mock.calls.length === claims.length) abort.abort();
      return { outcome: "completed" as const, reusedArtifactCount: 0 };
    });
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: { runClaim },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 2,
        pollIntervalMs: 10,
        leaseDurationMs: 60_000,
        recoveryBatchSize: 10
      }
    });

    await runtime.run(abort.signal);
    expect(repository.recoverExpired).toHaveBeenCalledWith({
      expiredBefore: "2027-08-08T00:00:00.000Z",
      nextAttemptAt: "2027-08-08T00:00:00.000Z",
      limit: 10
    });
    expect(repository.claim).toHaveBeenCalledWith(expect.objectContaining({
      owner: "semantic-worker-a",
      limit: 2,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    }));
    expect(runClaim).toHaveBeenCalledTimes(2);
  });

  it("reports one failed claim and continues settling the batch", async () => {
    const abort = new AbortController();
    const onFailure = vi.fn();
    const repository = repositoryStub({ claim: vi.fn(async () => [
      claim("kb-a"), claim("kb-b")
    ]) });
    let calls = 0;
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: {
        async runClaim() {
          calls += 1;
          if (calls === 1) throw new Error("dependency unavailable");
          abort.abort();
          return { outcome: "completed" as const, reusedArtifactCount: 0 };
        }
      },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 2, pollIntervalMs: 10,
        leaseDurationMs: 60_000, recoveryBatchSize: 10
      },
      onFailure
    });

    await runtime.run(abort.signal);
    expect(calls).toBe(2);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("refills a completed knowledge-base slot without waiting for a long peer", async () => {
    const abort = new AbortController();
    let releaseLongClaim!: () => void;
    const longClaim = new Promise<void>((resolve) => {
      releaseLongClaim = resolve;
    });
    const fallbackRelease = setTimeout(releaseLongClaim, 50);
    fallbackRelease.unref?.();
    const claimRequests: Array<{
      limit: number;
      excludedKnowledgeBaseIds?: readonly string[];
    }> = [];
    let claimRound = 0;
    const repository = repositoryStub({
      claim: vi.fn(async (request) => {
        claimRequests.push(request);
        claimRound += 1;
        if (claimRound === 1) {
          return [claim("kb-a", "first"), claim("kb-b", "long")];
        }
        if (claimRound === 2) return [claim("kb-a", "second")];
        return [];
      })
    });
    const started: string[] = [];
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: {
        async runClaim(work) {
          started.push(work.publicId);
          if (work.publicId === "stage-kb-b-long") {
            await longClaim;
          }
          if (work.publicId === "stage-kb-a-second") {
            releaseLongClaim();
            abort.abort();
          }
          return { outcome: "completed" as const, reusedArtifactCount: 0 };
        }
      },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 2, pollIntervalMs: 10,
        leaseDurationMs: 60_000, recoveryBatchSize: 10
      }
    });

    await runtime.run(abort.signal);
    clearTimeout(fallbackRelease);
    expect(started).toEqual([
      "stage-kb-a-first", "stage-kb-b-long", "stage-kb-a-second"
    ]);
    expect(claimRequests[1]).toMatchObject({
      limit: 1,
      excludedKnowledgeBaseIds: []
    });
  });

  it("uses a second bounded slot for an independent extraction in one knowledge base", async () => {
    const abort = new AbortController();
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fallbackAbort = setTimeout(() => {
      releaseFirst();
      abort.abort();
    }, 100);
    fallbackAbort.unref?.();
    let claimRound = 0;
    const repository = repositoryStub({
      claim: vi.fn(async (request) => {
        claimRound += 1;
        if (claimRound === 1) return [claim("kb-a", "first", "extraction")];
        if (claimRound === 2 && !request.excludedKnowledgeBaseIds?.includes("kb-a")) {
          return [claim("kb-a", "second", "extraction")];
        }
        return [];
      })
    });
    const started: string[] = [];
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: {
        async runClaim(work) {
          started.push(work.publicId);
          if (work.publicId === "stage-kb-a-first") await firstRunning;
          if (work.publicId === "stage-kb-a-second") {
            releaseFirst();
            abort.abort();
          }
          return { outcome: "completed" as const, reusedArtifactCount: 0 };
        }
      },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 2, pollIntervalMs: 10,
        leaseDurationMs: 60_000, recoveryBatchSize: 10
      }
    });

    await runtime.run(abort.signal);
    clearTimeout(fallbackAbort);
    expect(started).toEqual(["stage-kb-a-first", "stage-kb-a-second"]);
  });

  it("uses bounded same-wave slots for independent reconciliation work", async () => {
    const abort = new AbortController();
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fallbackAbort = setTimeout(() => {
      releaseFirst();
      abort.abort();
    }, 100);
    fallbackAbort.unref?.();
    let claimRound = 0;
    const repository = repositoryStub({
      claim: vi.fn(async (request) => {
        claimRound += 1;
        if (claimRound === 1) return [claim("kb-a", "first", "reconciliation")];
        if (claimRound === 2 && !request.excludedKnowledgeBaseIds?.includes("kb-a")) {
          return [claim("kb-a", "second", "reconciliation")];
        }
        return [];
      })
    });
    const started: string[] = [];
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: {
        async runClaim(work) {
          started.push(work.publicId);
          if (work.publicId === "stage-kb-a-first") await firstRunning;
          if (work.publicId === "stage-kb-a-second") {
            releaseFirst();
            abort.abort();
          }
          return { outcome: "completed" as const, reusedArtifactCount: 0 };
        }
      },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 2, pollIntervalMs: 10,
        leaseDurationMs: 60_000, recoveryBatchSize: 10
      }
    });

    await runtime.run(abort.signal);
    clearTimeout(fallbackAbort);
    expect(started).toEqual(["stage-kb-a-first", "stage-kb-a-second"]);
  });

  it("uses bounded same-knowledge-base slots for compatible embedding work", async () => {
    const abort = new AbortController();
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fallbackAbort = setTimeout(() => {
      releaseFirst();
      abort.abort();
    }, 100);
    fallbackAbort.unref?.();
    let claimRound = 0;
    const repository = repositoryStub({
      claim: vi.fn(async (request) => {
        claimRound += 1;
        if (claimRound === 1) return [claim("kb-a", "first", "embedding")];
        if (claimRound === 2 && !request.excludedKnowledgeBaseIds?.includes("kb-a")) {
          return [claim("kb-a", "second", "embedding")];
        }
        return [];
      })
    });
    const started: string[] = [];
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: {
        async runClaim(work) {
          started.push(work.publicId);
          if (work.publicId === "stage-kb-a-first") await firstRunning;
          if (work.publicId === "stage-kb-a-second") {
            releaseFirst();
            abort.abort();
          }
          return { outcome: "completed" as const, reusedArtifactCount: 0 };
        }
      },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 2, pollIntervalMs: 10,
        leaseDurationMs: 60_000, recoveryBatchSize: 10
      }
    });

    await runtime.run(abort.signal);
    clearTimeout(fallbackAbort);
    expect(started).toEqual(["stage-kb-a-first", "stage-kb-a-second"]);
  });

  it("uses the configured same-knowledge-base extraction bound instead of a fixed two-slot wave", async () => {
    const abort = new AbortController();
    let releaseWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseWaiting = resolve;
    });
    const fallbackRelease = setTimeout(releaseWaiting, 100);
    fallbackRelease.unref?.();
    let claimRound = 0;
    const requestedBounds: number[] = [];
    const repository = repositoryStub({
      claim: vi.fn(async (request) => {
        requestedBounds.push(request.maximumParallelStagesPerKnowledgeBase ?? 0);
        claimRound += 1;
        if (claimRound === 1) return [claim("kb-a", "first", "extraction")];
        if (claimRound === 2 && !request.excludedKnowledgeBaseIds?.includes("kb-a")) {
          return [claim("kb-a", "second", "extraction")];
        }
        if (claimRound === 3 && !request.excludedKnowledgeBaseIds?.includes("kb-a")) {
          return [claim("kb-a", "third", "extraction")];
        }
        return [];
      })
    });
    const started: string[] = [];
    const runtime = createSemanticStageRoleRuntime({
      owner: "semantic-worker-a",
      repository,
      worker: {
        async runClaim(work) {
          started.push(work.publicId);
          if (work.publicId !== "stage-kb-a-third") await waiting;
          if (work.publicId === "stage-kb-a-third") {
            releaseWaiting();
            abort.abort();
          }
          return { outcome: "completed" as const, reusedArtifactCount: 0 };
        }
      },
      clock: () => "2027-08-08T00:00:00.000Z",
      settings: {
        claimLimit: 3,
        maximumParallelStagesPerKnowledgeBase: 3,
        pollIntervalMs: 10,
        leaseDurationMs: 60_000, recoveryBatchSize: 10
      }
    });

    await runtime.run(abort.signal);
    clearTimeout(fallbackRelease);
    expect(started).toEqual([
      "stage-kb-a-first", "stage-kb-a-second", "stage-kb-a-third"
    ]);
    expect(requestedBounds).toEqual([3, 3, 3]);
  });
});

function claim(
  knowledgeBaseId: string,
  suffix = "",
  stageKind = "reconciliation"
): any {
  return {
    publicId: `stage-${knowledgeBaseId}${suffix ? `-${suffix}` : ""}`,
    knowledgeBaseId,
    operationPublicId: `operation-${knowledgeBaseId}`,
    semanticGenerationPublicId: `generation-${knowledgeBaseId}`,
    sourceFilePublicId: `file-${knowledgeBaseId}`,
    sourceRevisionPublicId: `revision-${knowledgeBaseId}`,
    stageKind,
    partitionKey: `file-${knowledgeBaseId}`,
    extractionContractVersion: "extract-v1",
    embeddingConfigurationRevisionPublicId: "embedding-v1",
    settingsSnapshot: {}, maximumAttempts: 3, state: "running",
    attemptCount: 1, checkpoint: {}, leaseOwner: "semantic-worker-a",
    leaseExpiresAt: "2027-08-08T00:01:00.000Z",
    cancellationRequestedAt: null, revision: 1
  };
}

function repositoryStub(
  overrides: Partial<SemanticStageRepositoryPort>
): SemanticStageRepositoryPort {
  return {
    enqueue: async () => 0,
    claim: async () => [],
    isOwned: async () => true,
    renew: async () => true,
    saveCheckpoint: async () => true,
    finish: async () => true,
    requestCancellation: async () => 0,
    recoverExpired: async () => 0,
    summarizeOperation: async () => ({
      totalCount: 0, completedCount: 0, pendingCount: 0,
      failedCount: 0, cancelledCount: 0, supersededCount: 0,
      reusedArtifactCount: 0
    }),
    ...overrides
  };
}
