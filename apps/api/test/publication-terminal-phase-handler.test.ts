import { describe, expect, it, vi } from "vitest";
import { createPublicationTerminalPhaseHandlers } from "../src/worker/publication-terminal-phase-handler.js";
import type { PublicationSubtask } from "../src/application/ports/publication-subtask-repository.js";

describe("publication terminal phase handlers", () => {
  it("finalizes objects before validation and activates one generation idempotently", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const markGenerationState = vi.fn().mockResolvedValue(true);
    const validateChangedClosure = vi.fn().mockResolvedValue([]);
    const activateGeneration = vi.fn().mockResolvedValue(true);
    const stageUpsert = vi.fn().mockResolvedValue(undefined);
    const state = vi.fn()
      .mockResolvedValueOnce({ state: "building", predecessorGenerationId: null })
      .mockResolvedValueOnce({ state: "validating", predecessorGenerationId: null });
    const handlers = createPublicationTerminalPhaseHandlers({
      generations: {
        markGenerationState,
        activateGeneration
      },
      state: { getActivationContext: state },
      validation: { validateChangedClosure },
      references: {
        findStagedByRef: vi.fn().mockResolvedValue(rootReference()),
        findActiveByRef: vi.fn(),
        stageUpsert
      },
      immutableObjects: {
        write: vi.fn().mockResolvedValue({
          checksumSha256: "b".repeat(64),
          formatVersion: 1,
          objectKey: "immutable/generation-manifest",
          contentType: "application/json; charset=utf-8",
          sizeBytes: 100,
          createdAt: "2026-07-20T00:00:00.000Z",
          verifiedAt: "2026-07-20T00:00:00.000Z",
          reused: false
        })
      },
      finalizers: [{ finalize }],
      validationIssueLimit: 20,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    const task = terminalTask();

    await handlers.object(task);
    await handlers.validation({ ...task, taskKind: "validation" });
    await handlers.activation({ ...task, taskKind: "activation" });

    expect(finalize).toHaveBeenCalledOnce();
    expect(markGenerationState).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: "building",
      state: "validating"
    }));
    expect(validateChangedClosure).toHaveBeenCalledOnce();
    expect(activateGeneration).toHaveBeenCalledWith(expect.objectContaining({
      expectedPredecessorGenerationId: null
    }));
    expect(stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      refKind: "generation_manifest"
    }));
  });

  it("treats an already active generation as a completed activation retry", async () => {
    const activateGeneration = vi.fn();
    const handlers = createPublicationTerminalPhaseHandlers({
      generations: { markGenerationState: vi.fn(), activateGeneration },
      state: {
        getActivationContext: vi.fn().mockResolvedValue({
          state: "active",
          predecessorGenerationId: "generation-before"
        })
      },
      validation: { validateChangedClosure: vi.fn() },
      references: referenceRepository(),
      immutableObjects: { write: vi.fn() },
      finalizers: [],
      validationIssueLimit: 20
    });

    await expect(handlers.activation({ ...terminalTask(), taskKind: "activation" }))
      .resolves.toBeUndefined();
    expect(activateGeneration).not.toHaveBeenCalled();
  });

  it("returns candidate consistency failures as safe retryable publication failures", async () => {
    const handlers = createPublicationTerminalPhaseHandlers({
      generations: {
        markGenerationState: vi.fn().mockResolvedValue(true),
        activateGeneration: vi.fn()
      },
      state: {
        getActivationContext: vi.fn().mockResolvedValue({
          state: "building",
          predecessorGenerationId: "generation-active"
        })
      },
      validation: {
        validateChangedClosure: vi.fn().mockResolvedValue([{
          code: "GRAPH_SUMMARY_MISMATCH",
          message: "The candidate graph summary is incomplete.",
          reference: "generation-1"
        }])
      },
      references: referenceRepository(),
      immutableObjects: { write: vi.fn() },
      finalizers: [],
      validationIssueLimit: 20
    });

    await expect(handlers.validation({ ...terminalTask(), taskKind: "validation" }))
      .rejects.toMatchObject({
        code: "GENERATION_VALIDATION_FAILED",
        retryable: true,
        message: "GRAPH_SUMMARY_MISMATCH:generation-1"
      });
  });
});

function terminalTask(): PublicationSubtask {
  return {
    id: "publication-subtask-object",
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    taskKind: "object",
    projectionKind: "",
    physicalPartition: "workflow",
    settingsSnapshot: {},
    attemptCount: 1,
    maxAttempts: 5,
    processedCount: 0,
    totalCount: 1,
    leaseOwner: "worker-1",
    leaseToken: "lease-1"
  };
}

function rootReference() {
  return {
    checksumSha256: "a".repeat(64),
    objectKey: "immutable/root",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 100
  };
}

function referenceRepository() {
  return {
    findStagedByRef: vi.fn(),
    findActiveByRef: vi.fn(),
    stageUpsert: vi.fn()
  };
}
