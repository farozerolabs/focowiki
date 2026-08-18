import { describe, expect, it, vi } from "vitest";
import { createDocumentResourceDeletionWorker } from
  "../src/document-indexing/application/document-resource-deletion-worker.js";

describe("document resource deletion worker", () => {
  it("checkpoints one bounded page and releases the action for continuation", async () => {
    const actions = actionPorts({
      processResult: {
        done: false,
        processedSourceCount: 2,
        checkpoint: {
          phase: "deactivate",
          cursor: "source-file-2",
          affectedSourceCount: 4
        }
      }
    });
    const worker = createDocumentResourceDeletionWorker(actions.input);

    await expect(worker.runBatch(batch())).resolves.toMatchObject({
      claimed: 1,
      processedSourceCount: 2,
      continued: 1,
      completed: 0
    });
    expect(actions.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "cleanup-delete",
      notBefore: "2026-08-14T13:00:00.000Z",
      safeErrorCode: "DOCUMENT_DELETION_PAGE_REMAINING",
      checkpoint: expect.objectContaining({ cursor: "source-file-2" })
    }));
    expect(actions.complete).not.toHaveBeenCalled();
  });

  it("completes only after the processor reports durable convergence", async () => {
    const actions = actionPorts({
      processResult: {
        done: true,
        processedSourceCount: 0,
        checkpoint: {
          phase: "completed",
          cursor: null,
          affectedSourceCount: 1
        }
      }
    });
    const worker = createDocumentResourceDeletionWorker(actions.input);

    await expect(worker.runBatch(batch())).resolves.toMatchObject({
      completed: 1,
      continued: 0
    });
    expect(actions.complete).toHaveBeenCalledWith({
      publicId: "cleanup-delete",
      owner: "worker-1",
      completedAt: "2026-08-14T13:00:00.000Z"
    });
  });

  it("recovers an expired lease before claiming work", async () => {
    const actions = actionPorts({ processResult: null, claimed: [] });
    const worker = createDocumentResourceDeletionWorker(actions.input);

    await expect(worker.runBatch(batch())).resolves.toMatchObject({ claimed: 0 });
    expect(actions.recoverStale).toHaveBeenCalledBefore(actions.claim);
  });

  it("reconciles generated projections before external cleanup and purge", async () => {
    const actions = actionPorts({
      phase: "reconcile_projection",
      processResult: {
        done: false,
        processedSourceCount: 1,
        checkpoint: {
          phase: "await_external",
          cursor: null,
          affectedSourceCount: 1
        }
      }
    });
    const worker = createDocumentResourceDeletionWorker(actions.input);

    await expect(worker.runBatch(batch())).resolves.toMatchObject({
      claimed: 1,
      processedSourceCount: 1,
      continued: 1
    });
    expect(actions.reconcile).toHaveBeenCalledOnce();
    expect(actions.processPage).not.toHaveBeenCalled();
  });
});

function actionPorts(input: {
  processResult: {
    done: boolean;
    processedSourceCount: number;
    checkpoint: {
      phase: "deactivate" | "reconcile_projection" | "await_external" | "purge" | "completed";
      cursor: string | null;
      affectedSourceCount: number;
    };
  } | null;
  claimed?: [];
  phase?: "deactivate" | "reconcile_projection";
}) {
  const action = {
    publicId: "cleanup-delete",
    operationPublicId: "operation-delete",
    knowledgeBaseId: "knowledge-base-1",
    targetKind: "source_directory" as const,
    targetPublicId: "directory-1",
    attempt: 1,
    maximumAttempts: 20,
    checkpoint: {
      phase: input.phase ?? "deactivate",
      cursor: null,
      affectedSourceCount: 4
    }
  };
  const recoverStale = vi.fn().mockResolvedValue(0);
  const claim = vi.fn().mockResolvedValue(input.claimed ?? [action]);
  const processPage = vi.fn().mockImplementation(async () => {
    if (!input.processResult) throw new Error("unexpected processing");
    return input.processResult;
  });
  const reconcile = vi.fn().mockImplementation(async () => {
    if (!input.processResult) throw new Error("unexpected reconciliation");
    return input.processResult;
  });
  const releaseForRetry = vi.fn().mockResolvedValue(true);
  const complete = vi.fn().mockResolvedValue(true);
  const fail = vi.fn().mockResolvedValue(true);
  return {
    recoverStale,
    claim,
    releaseForRetry,
    complete,
    processPage,
    reconcile,
    input: {
      actions: { recoverStale, claim, releaseForRetry, complete, fail },
      processor: { processPage },
      projections: { reconcile }
    }
  };
}

function batch() {
  return {
    owner: "worker-1",
    limit: 2,
    pageSize: 2,
    now: "2026-08-14T13:00:00.000Z",
    leaseExpiresAt: "2026-08-14T13:01:00.000Z",
    retryDelayMilliseconds: 10,
    signal: new AbortController().signal
  };
}
