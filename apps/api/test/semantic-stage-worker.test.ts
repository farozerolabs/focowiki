import { describe, expect, it, vi } from "vitest";
import type {
  SemanticStageRepositoryPort,
  SemanticStageWorkClaim
} from "../src/semantic/application/stage-ports.js";
import { createSemanticStageWorker, stageBudgets } from
  "../src/semantic/application/stage-worker.js";
import type { SemanticStageKind } from
  "../src/semantic/application/stage-orchestration.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../src/semantic/domain/contracts.js";

describe("semantic stage worker", () => {
  it("checks ownership around bounded work and records reusable checkpoints", async () => {
    const events: string[] = [];
    const repository = repositoryStub({
      isOwned: async () => { events.push("owned"); return true; },
      saveCheckpoint: async ({ checkpoint }) => {
        events.push(`checkpoint:${checkpoint.reusedArtifactCount}`);
        return true;
      },
      finish: async ({ outcome }) => { events.push(`finish:${outcome}`); return true; }
    });
    const worker = createSemanticStageWorker({
      repository,
      budgets: {
        acquire: async (kind) => { events.push(`acquire:${kind}`); return () => events.push(`release:${kind}`); }
      },
      handlers: handlers({
        extraction: async () => {
          events.push("handler");
          return { checkpoint: { artifactPublicId: "extract-artifact-1" }, reusedArtifactCount: 1 };
        }
      }),
      clock: () => "2027-08-08T00:00:00.000Z"
    });
    await expect(worker.runClaim(claim("extraction"))).resolves.toEqual({
      outcome: "completed", reusedArtifactCount: 1
    });
    expect(events).toEqual([
      "owned", "handler", "owned", "checkpoint:1", "finish:completed"
    ]);
  });

  it("retries crashes, rejects stale late output, and does not consume unrelated budgets", async () => {
    const finish = vi.fn(async () => true);
    const repository = repositoryStub({ finish });
    const acquired: string[] = [];
    const worker = createSemanticStageWorker({
      repository,
      budgets: { acquire: async (kind) => { acquired.push(kind); return () => undefined; } },
      handlers: handlers({
        reconciliation: async () => { throw new Error("database unavailable"); }
      }),
      clock: () => "2027-08-08T00:00:00.000Z",
      retryDelayMs: 500
    });
    await expect(worker.runClaim(claim("reconciliation")))
      .rejects.toThrow("database unavailable");
    expect(acquired).toEqual(["database_mutation"]);
    expect(finish).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "retry", safeCode: "semantic_stage_dependency_failed",
      nextAttemptAt: "2027-08-08T00:00:00.500Z"
    }));

    let checks = 0;
    const staleFinish = vi.fn(async () => true);
    const stale = createSemanticStageWorker({
      repository: repositoryStub({
        isOwned: async () => ++checks === 1,
        finish: staleFinish
      }),
      budgets: { acquire: async () => () => undefined },
      handlers: handlers(),
      clock: () => "2027-08-08T00:00:00.000Z"
    });
    await expect(stale.runClaim(claim("vector"))).resolves.toEqual({
      outcome: "superseded", reusedArtifactCount: 0
    });
    expect(staleFinish).not.toHaveBeenCalled();
  });

  it("preserves an owned semantic safe code for terminal stage failures", async () => {
    const finish = vi.fn(async () => true);
    const failure = Object.assign(
      new Error("Private model response must not escape"),
      { code: "semantic_prompt_contract_mismatch", retryable: false }
    );
    const worker = createSemanticStageWorker({
      repository: repositoryStub({ finish }),
      budgets: { acquire: async () => () => undefined },
      handlers: handlers({
        extraction: async () => { throw failure; }
      }),
      clock: () => "2027-08-08T00:00:00.000Z"
    });

    await expect(worker.runClaim(claim("extraction"))).rejects.toBe(failure);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      safeCode: "semantic_prompt_contract_mismatch"
    }));
  });

  it("terminates stale-contract downstream work before budgets or handlers", async () => {
    const finish = vi.fn(async () => true);
    const acquire = vi.fn(async () => () => undefined);
    const embedding = vi.fn(async () => ({ checkpoint: {}, reusedArtifactCount: 0 }));
    const worker = createSemanticStageWorker({
      repository: repositoryStub({ finish }),
      budgets: { acquire },
      handlers: handlers({ embedding }),
      clock: () => "2027-08-08T00:00:00.000Z"
    });

    await expect(worker.runClaim({
      ...claim("embedding"),
      extractionContractVersion: "full-per-chunk-v1"
    })).rejects.toMatchObject({
      code: "semantic_contract_maintenance_required",
      retryable: false
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(embedding).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      safeCode: "semantic_contract_maintenance_required"
    }));
  });

  it("maps every stage to explicit independent resource budgets", () => {
    expect(stageBudgets("embedding")).toEqual([]);
    expect(stageBudgets("extraction")).toEqual([]);
    expect(stageBudgets("community")).toEqual(["database_mutation"]);
    expect(stageBudgets("publication")).toEqual(["database_mutation"]);
    expect(stageBudgets("cleanup")).toEqual([
      "s3_write", "database_mutation", "search_write"
    ]);
  });

  it("reports bounded per-stage service time and outcome", async () => {
    const onSettled = vi.fn();
    const times = [100, 137];
    const worker = createSemanticStageWorker({
      repository: repositoryStub(),
      budgets: { acquire: async () => () => undefined },
      handlers: handlers(),
      nowMilliseconds: () => times.shift()!,
      onSettled
    });

    await worker.runClaim(claim("embedding"));

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith({
      stageKind: "embedding",
      outcome: "completed",
      durationMs: 37
    });
  });

  it("aborts bounded work when lease renewal loses ownership", async () => {
    const finish = vi.fn(async () => false);
    const worker = createSemanticStageWorker({
      repository: repositoryStub({
        renew: async () => false,
        finish
      }),
      budgets: { acquire: async () => () => undefined },
      handlers: handlers({
        extraction: async (_claim, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
      }),
      clock: () => "2027-08-08T00:00:00.000Z",
      lease: { durationMs: 10_000, renewalIntervalMs: 1 }
    });
    await expect(worker.runClaim(claim("extraction")))
      .rejects.toThrow("Semantic stage lease was lost");
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "retry",
      safeCode: "semantic_stage_dependency_failed"
    }));
  });

  it("returns interrupted role work to retry instead of cancelling durable stages", async () => {
    const controller = new AbortController();
    const finish = vi.fn(async () => true);
    const worker = createSemanticStageWorker({
      repository: repositoryStub({ finish }),
      budgets: { acquire: async () => () => undefined },
      handlers: handlers({
        extraction: async (_claim, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort(new DOMException("Worker stopping", "AbortError"));
        })
      }),
      clock: () => "2027-08-08T00:00:00.000Z",
      retryDelayMs: 500
    });

    await expect(worker.runClaim(claim("extraction"), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "retry",
      safeCode: "semantic_stage_dependency_failed",
      nextAttemptAt: "2027-08-08T00:00:00.500Z"
    }));
  });
});

function claim(stageKind: SemanticStageKind): SemanticStageWorkClaim {
  return {
    publicId: `work-${stageKind}`,
    knowledgeBaseId: "kb-main",
    operationPublicId: "operation-main",
    semanticGenerationPublicId: "generation-main",
    sourceFilePublicId: "file-main",
    sourceRevisionPublicId: "revision-main",
    stageKind,
    partitionKey: "file-main",
    extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION,
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    settingsSnapshot: {
      generationModelRevisionPublicId: "model-v1",
      promptContractVersion: SEMANTIC_PROMPT_CONTRACT_VERSION
    },
    maximumAttempts: 3,
    state: "running",
    attemptCount: 1,
    checkpoint: {},
    leaseOwner: "worker-1",
    leaseExpiresAt: "2027-08-08T00:01:00.000Z",
    cancellationRequestedAt: null,
    revision: 1
  };
}

function repositoryStub(
  overrides: Partial<SemanticStageRepositoryPort> = {}
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

function handlers(overrides: Partial<Record<SemanticStageKind, (
  claim: SemanticStageWorkClaim,
  signal?: AbortSignal
) => Promise<{ checkpoint: Record<string, string | number | boolean | null>; reusedArtifactCount: number }>>> = {}) {
  const base = async () => ({ checkpoint: {}, reusedArtifactCount: 0 });
  return Object.fromEntries([
    "extraction", "embedding", "reconciliation", "community",
    "vector", "publication", "validation", "cleanup"
  ].map((kind) => [kind, overrides[kind as SemanticStageKind] ?? base])) as
    Record<SemanticStageKind, typeof base>;
}
