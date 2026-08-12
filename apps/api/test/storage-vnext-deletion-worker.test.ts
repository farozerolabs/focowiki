import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type WorkerFactory = (input: ReturnType<typeof fixture>) => {
  runBatch(input: { leaseExpiresAt: string }): Promise<readonly {
    workPublicId: string;
    outcome: "completed" | "retry" | "failed";
    reasonCode: string | null;
  }[]>;
};

type PurgeAttempt = {
  status: "completed" | "blocked" | "retry";
  receipts: Array<{
    target: { resourceKind: string };
    status: "completed" | "blocked" | "retry";
    reasonCode: string | null;
    checkpoint: Record<string, boolean | number | string | null>;
  }>;
};

let factory: WorkerFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/deletion-worker.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextDeletionWorker?: WorkerFactory;
    };
  factory = loaded.createStorageVnextDeletionWorker;
});

describe("storage vNext deletion worker", () => {
  it("persists progress before continuing a bounded cleanup page without retry cost", async () => {
    const current = fixture();
    current.purge.runAttempt.mockResolvedValueOnce({
      status: "retry",
      receipts: [{
        target: { resourceKind: "catalog_scope" },
        status: "retry",
        reasonCode: "DELETION_SCOPE_PAGE_REMAINING",
        checkpoint: { cursor: "source-a" }
      }]
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toEqual([{
      workPublicId: "operation-delete-worker",
      outcome: "retry",
      reasonCode: "DELETION_SCOPE_PAGE_REMAINING"
    }]);
    expect(current.workflow.saveCheckpoint).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      checkpoint: expect.objectContaining({
        targetKind: "source_file",
        targetPublicId: "source-worker",
        cursor: "source-a"
      })
    });
    expect(current.workflow.saveCheckpoint).toHaveBeenCalledBefore(
      current.workflow.releaseForContinuation
    );
    expect(current.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      nextAttemptAt: "2026-08-01T07:00:00.000Z"
    });
    expect(current.retryDelayMilliseconds).not.toHaveBeenCalled();
    expect(current.workflow.releaseForRetry).not.toHaveBeenCalled();
  });

  it("continues a bounded search-task page without consuming failure attempts", async () => {
    const current = fixture();
    current.purge.runAttempt.mockResolvedValueOnce({
      status: "retry",
      receipts: [{
        target: { resourceKind: "unified_search_scope" },
        status: "retry",
        reasonCode: "DELETION_SEARCH_TASK_PAGE_REMAINING",
        checkpoint: { taskFrom: 70 }
      }]
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toEqual([{
      workPublicId: "operation-delete-worker",
      outcome: "retry",
      reasonCode: "DELETION_SEARCH_TASK_PAGE_REMAINING"
    }]);
    expect(current.workflow.saveCheckpoint).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      checkpoint: expect.objectContaining({ taskFrom: 70 })
    });
    expect(current.workflow.releaseForContinuation).toHaveBeenCalledOnce();
    expect(current.workflow.releaseForRetry).not.toHaveBeenCalled();
  });

  it("continues semantic work draining without consuming failure attempts", async () => {
    const current = fixture({ attempt: 3 });
    current.purge.runAttempt.mockResolvedValueOnce({
      status: "retry",
      receipts: [{
        target: { resourceKind: "semantic_scope" },
        status: "retry",
        reasonCode: "DELETION_SEMANTIC_WORK_DRAINING",
        checkpoint: { semanticCursor: null }
      }]
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toMatchObject([{
      outcome: "retry",
      reasonCode: "DELETION_SEMANTIC_WORK_DRAINING"
    }]);
    expect(current.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      nextAttemptAt: "2026-08-01T07:00:02.000Z"
    });
    expect(current.workflow.releaseForRetry).not.toHaveBeenCalled();
    expect(current.retryDelayMilliseconds).toHaveBeenCalledWith(3);
  });

  it("backs off provider-required continuation without consuming failure attempts", async () => {
    const current = fixture({ attempt: 3 });
    current.purge.runAttempt.mockResolvedValueOnce({
      status: "retry",
      receipts: [{
        target: { resourceKind: "unified_search_scope" },
        status: "retry",
        reasonCode: "DELETION_SEARCH_PROVIDER_REQUIRED",
        checkpoint: { requiredSearchProviderKind: "opensearch" }
      }]
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toMatchObject([{
      outcome: "retry",
      reasonCode: "DELETION_SEARCH_PROVIDER_REQUIRED"
    }]);
    expect(current.retryDelayMilliseconds).toHaveBeenCalledWith(3);
    expect(current.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      nextAttemptAt: "2026-08-01T07:00:02.000Z"
    });
    expect(current.workflow.complete).not.toHaveBeenCalled();
  });

  it("prepares and checkpoints the deletion release before physical purge", async () => {
    const current = fixture();
    current.prepare.mockResolvedValueOnce({
      releaseActivated: true,
      releaseRootPublicId: "root-after-delete"
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toMatchObject([{
      outcome: "completed"
    }]);

    expect(current.prepare).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "operation-delete-worker",
      knowledgeBaseId: "kb-delete-worker"
    }));
    expect(current.workflow.saveCheckpoint).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      checkpoint: expect.objectContaining({
        releaseActivated: true,
        releaseRootPublicId: "root-after-delete"
      })
    });
    expect(current.workflow.saveCheckpoint).toHaveBeenCalledBefore(
      current.purge.runAttempt
    );
  });

  it("writes one bounded result when source-scope purge completes", async () => {
    const current = fixture();
    current.purge.runAttempt.mockResolvedValueOnce({
      status: "completed",
      receipts: Array.from({ length: 9 }, (_, index) => ({
        target: { resourceKind: `resource-${index}` },
        status: "completed",
        reasonCode: null,
        checkpoint: {}
      }))
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toEqual([{
      workPublicId: "operation-delete-worker",
      outcome: "completed",
      reasonCode: null
    }]);
    expect(current.workflow.complete).toHaveBeenCalledOnce();
    expect(current.workflow.complete).toHaveBeenCalledWith({
      publicId: "operation-delete-worker",
      owner: "deletion-worker-a",
      result: expect.objectContaining({
        publicId: "operation-delete-worker",
        state: "completed",
        resultCode: "DELETION_COMPLETED",
        safeMessage: null,
        summary: {
          targetKind: "source_file",
          targetPublicId: "source-worker",
          cleanupReceiptCount: 9
        }
      })
    });
  });

  it("enqueues the released deletion event after purge completion", async () => {
    const current = fixture();
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toMatchObject([{ outcome: "completed" }]);
    expect(current.webhooks.dispatch).toHaveBeenCalledWith({
      eventId: "event-hard-delete-operation-delete-worker",
      eventType: "file.deleted",
      payload: {
        knowledgeBaseId: "kb-delete-worker",
        sourceFileId: "source-worker"
      },
      createdAt: "2026-08-01T07:00:00.000Z"
    });
  });

  it("converges exhausted retries to one safe failure without restoring visibility", async () => {
    const current = fixture({ attempt: 3 });
    current.purge.runAttempt.mockRejectedValueOnce(
      Object.assign(new Error("raw provider credentials and endpoint"), {
        code: "23505",
        constraint_name: "release_event_summaries_candidate_outcome_key"
      })
    );
    const worker = createWorker(current);

    const result = await worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    });

    expect(result).toEqual([{
      workPublicId: "operation-delete-worker",
      outcome: "failed",
      reasonCode: "DELETION_RETRY_EXHAUSTED",
      errorClass: "Error",
      errorCode: "23505",
      errorConstraint: "release_event_summaries_candidate_outcome_key"
    }]);
    expect(current.workflow.releaseForRetry).not.toHaveBeenCalled();
    expect(current.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        state: "failed",
        resultCode: "DELETION_RETRY_EXHAUSTED",
        safeMessage: null
      })
    }));
    expect(JSON.stringify(current.workflow.complete.mock.calls)).not.toContain(
      "raw provider credentials"
    );
    expect(JSON.stringify(result)).not.toContain("raw provider credentials");
  });

  it("reports the internal attempt failure without exposing it in the result", async () => {
    const current = fixture();
    const failure = Object.assign(new Error("internal publication context"), {
      code: "publication_failed"
    });
    current.prepare.mockRejectedValueOnce(failure);
    const worker = createWorker(current);

    const result = await worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    });

    expect(current.onAttemptError).toHaveBeenCalledWith({
      work: expect.objectContaining({ publicId: "operation-delete-worker" }),
      error: failure
    });
    expect(JSON.stringify(result)).not.toContain("internal publication context");
  });

  it("keeps deletion convergence when the attempt error observer fails", async () => {
    const current = fixture();
    current.prepare.mockRejectedValueOnce(new Error("preparation failed"));
    current.onAttemptError.mockImplementationOnce(() => {
      throw new Error("observer failed");
    });
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toEqual([{
      workPublicId: "operation-delete-worker",
      outcome: "retry",
      reasonCode: "DELETION_ATTEMPT_FAILED",
      errorClass: "Error",
      errorCode: "unexpected_error"
    }]);
    expect(current.workflow.releaseForRetry).toHaveBeenCalledOnce();
    expect(current.workflow.complete).not.toHaveBeenCalled();
  });

  it("claims only deletion work and does not multiply completed replays", async () => {
    const current = fixture();
    const worker = createWorker(current);
    await worker.runBatch({ leaseExpiresAt: "2026-08-01T07:05:00.000Z" });
    current.workflow.claim.mockResolvedValueOnce([]);
    await worker.runBatch({ leaseExpiresAt: "2026-08-01T07:10:00.000Z" });

    expect(current.workflow.claim).toHaveBeenNthCalledWith(1, {
      kinds: ["deletion"],
      owner: "deletion-worker-a",
      limit: 2,
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    });
    expect(current.workflow.complete).toHaveBeenCalledOnce();
  });

  it("does not recreate a result row after whole-knowledge-base purge removes its scope", async () => {
    const current = fixture();
    current.workflow.claim.mockResolvedValueOnce([{
      ...current.work,
      checkpoint: {
        targetKind: "knowledge_base",
        targetPublicId: "kb-delete-worker",
        normalizedPath: null,
        activeSearchProviderKind: "meilisearch",
        activeSearchProviderIndexUid: "unified-worker-active",
        candidateSearchProviderKind: null,
        candidateSearchProviderIndexUid: null,
        cursor: null
      }
    }]);
    const worker = createWorker(current);

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-01T07:05:00.000Z"
    })).resolves.toEqual([{
      workPublicId: "operation-delete-worker",
      outcome: "completed",
      reasonCode: null
    }]);
    expect(current.workflow.complete).not.toHaveBeenCalled();
  });
});

function createWorker(current: ReturnType<typeof fixture>) {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Deletion worker is unavailable");
  return factory(current);
}

function fixture(options: { attempt?: number } = {}) {
  const work = {
    publicId: "operation-delete-worker",
    knowledgeBaseId: "kb-delete-worker",
    kind: "deletion" as const,
    state: "running" as const,
    operationRevision: 1,
    settingsRevisionPublicId: "settings-delete-worker",
    attempt: options.attempt ?? 1,
    leaseOwner: "deletion-worker-a",
    leaseExpiresAt: "2026-08-01T07:05:00.000Z",
    nextAttemptAt: null,
    safeErrorCode: null,
    checkpoint: {
      targetKind: "source_file",
      targetPublicId: "source-worker",
      normalizedPath: null,
      activeSearchProviderKind: "meilisearch",
      activeSearchProviderIndexUid: "unified-worker-active",
      candidateSearchProviderKind: null,
      candidateSearchProviderIndexUid: null,
      cursor: null
    },
    idempotency: {
      key: "delete-worker-key",
      requestHash: "a".repeat(64),
      expiresAt: "2026-08-02T07:00:00.000Z"
    }
  };
  return {
    work,
    workflow: {
      claim: vi.fn(async () => [work]),
      saveCheckpoint: vi.fn(async () => undefined),
      releaseForContinuation: vi.fn(async () => undefined),
      releaseForRetry: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined)
    },
    purge: {
      runAttempt: vi.fn(async (): Promise<PurgeAttempt> => ({
        status: "completed",
        receipts: []
      }))
    },
    prepare: vi.fn(async () => ({})),
    owner: "deletion-worker-a",
    claimLimit: 2,
    maximumAttempts: 3,
    retryDelayMilliseconds: vi.fn(() => 2_000),
    clock: () => "2026-08-01T07:00:00.000Z",
    webhooks: {
      dispatch: vi.fn(async () => undefined)
    },
    onAttemptError: vi.fn()
  };
}
