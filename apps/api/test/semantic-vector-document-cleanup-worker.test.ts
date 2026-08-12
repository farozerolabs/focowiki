import { describe, expect, it, vi } from "vitest";
import { createSemanticVectorDocumentCleanupWorker } from
  "../src/semantic/application/vector-document-cleanup-worker.js";

describe("semantic vector document cleanup worker", () => {
  it("completes cleanup when the provider index is already absent", async () => {
    const actions = [cleanupAction("vector-absent")];
    const complete = vi.fn(async () => true);
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const worker = createSemanticVectorDocumentCleanupWorker({
      actions: {
        claim: vi.fn(async () => actions),
        complete,
        releaseForRetry: vi.fn(async () => undefined)
      },
      provider: {
        kind: "opensearch",
        vector: {
          getIndexDefinition: vi.fn(async () => null),
          deleteDocuments,
          getOperation: vi.fn()
        }
      },
      indexPrefix: "focowiki",
      maxPollAttempts: 10,
      pollIntervalMs: 1,
      retryDelayMs: 100
    });

    await expect(worker.runBatch({
      owner: "cleanup-worker",
      limit: 100,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 });
    expect(deleteDocuments).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("completes a failed deletion task when the provider index disappeared", async () => {
    const actions = [cleanupAction("vector-disappeared")];
    const complete = vi.fn(async () => true);
    const releaseForRetry = vi.fn(async () => undefined);
    const getIndexDefinition = vi.fn()
      .mockResolvedValueOnce(vectorDefinition())
      .mockResolvedValueOnce(null);
    const worker = createSemanticVectorDocumentCleanupWorker({
      actions: {
        claim: vi.fn(async () => actions),
        complete,
        releaseForRetry
      },
      provider: {
        kind: "opensearch",
        vector: {
          getIndexDefinition,
          deleteDocuments: vi.fn(async () => ({
            state: "pending" as const,
            operationRef: "delete-disappeared"
          })),
          getOperation: vi.fn(async () => ({
            state: "failed" as const,
            errorCode: "SEARCH_ENGINE_REQUEST_FAILED" as const
          }))
        }
      },
      indexPrefix: "focowiki",
      maxPollAttempts: 10,
      pollIntervalMs: 1,
      retryDelayMs: 100
    });

    await expect(worker.runBatch({
      owner: "cleanup-worker",
      limit: 100,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 });
    expect(getIndexDefinition).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(releaseForRetry).not.toHaveBeenCalled();
  });

  it("groups owned actions into one bounded provider deletion", async () => {
    const actions = [cleanupAction("vector-a"), cleanupAction("vector-b")];
    const claim = vi.fn(async () => actions);
    const complete = vi.fn(async () => true);
    const releaseForRetry = vi.fn(async () => undefined);
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const worker = createSemanticVectorDocumentCleanupWorker({
      actions: { claim, complete, releaseForRetry },
      provider: {
        kind: "opensearch",
        vector: {
          getIndexDefinition: vi.fn(async () => vectorDefinition()),
          deleteDocuments,
          getOperation: vi.fn()
        }
      },
      indexPrefix: "focowiki",
      maxPollAttempts: 10,
      pollIntervalMs: 1,
      retryDelayMs: 100
    });

    await expect(worker.runBatch({
      owner: "cleanup-worker",
      limit: 100,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 2, completed: 2, retried: 0 });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      selector: {
        domain: "semantic_vector_document_cleanup",
        plane: "search",
        resourceKind: "semantic_vector_document",
        searchProviderKind: "opensearch"
      }
    }));
    expect(deleteDocuments).toHaveBeenCalledOnce();
    expect(deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-cleanup",
      semanticGenerationPublicId: "semantic-cleanup",
      documentIds: ["vector-a", "vector-b"]
    }));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(releaseForRetry).not.toHaveBeenCalled();
  });

  it("deduplicates provider document IDs while completing every cleanup action", async () => {
    const actions = [cleanupAction("vector-first"), cleanupAction("vector-second")]
      .map((action) => ({
        ...action,
        checkpoint: {
          ...action.checkpoint,
          providerDocumentId: "vector-shared"
        }
      }));
    const complete = vi.fn(async () => true);
    const deleteDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const worker = createSemanticVectorDocumentCleanupWorker({
      actions: {
        claim: vi.fn(async () => actions),
        complete,
        releaseForRetry: vi.fn(async () => undefined)
      },
      provider: {
        kind: "opensearch",
        vector: {
          getIndexDefinition: vi.fn(async () => vectorDefinition()),
          deleteDocuments,
          getOperation: vi.fn()
        }
      },
      indexPrefix: "focowiki",
      maxPollAttempts: 10,
      pollIntervalMs: 1,
      retryDelayMs: 100
    });

    await expect(worker.runBatch({
      owner: "cleanup-worker",
      limit: 100,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 2, completed: 2, retried: 0 });
    expect(deleteDocuments).toHaveBeenCalledWith(expect.objectContaining({
      documentIds: ["vector-shared"]
    }));
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("durably retries every action when provider deletion fails", async () => {
    const actions = [cleanupAction("vector-retry")];
    const releaseForRetry = vi.fn(async () => undefined);
    const worker = createSemanticVectorDocumentCleanupWorker({
      actions: {
        claim: vi.fn(async () => actions),
        complete: vi.fn(async () => true),
        releaseForRetry
      },
      provider: {
        kind: "opensearch",
        vector: {
          getIndexDefinition: vi.fn(async () => vectorDefinition()),
          deleteDocuments: vi.fn(async () => {
            throw new Error("provider unavailable");
          }),
          getOperation: vi.fn()
        }
      },
      indexPrefix: "focowiki",
      maxPollAttempts: 10,
      pollIntervalMs: 1,
      retryDelayMs: 100,
      now: () => new Date("2027-08-08T00:00:00.000Z")
    });

    await expect(worker.runBatch({
      owner: "cleanup-worker",
      limit: 100,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 0, retried: 1 });
    expect(releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "action-vector-retry",
      owner: "cleanup-worker",
      notBefore: "2027-08-08T00:00:00.100Z",
      safeErrorCode: "SEMANTIC_VECTOR_DOCUMENT_CLEANUP_FAILED"
    }));
  });

  it("bounds a configured cleanup page to the repository claim limit", async () => {
    const claim = vi.fn(async () => []);
    const worker = createSemanticVectorDocumentCleanupWorker({
      actions: {
        claim,
        complete: vi.fn(async () => true),
        releaseForRetry: vi.fn(async () => undefined)
      },
      provider: {
        kind: "opensearch",
        vector: {
          getIndexDefinition: vi.fn(async () => vectorDefinition()),
          deleteDocuments: vi.fn(),
          getOperation: vi.fn()
        }
      },
      indexPrefix: "focowiki",
      maxPollAttempts: 10,
      pollIntervalMs: 1,
      retryDelayMs: 100
    });

    await expect(worker.runBatch({
      owner: "cleanup-worker",
      limit: 1_000,
      leaseExpiresAt: "2027-08-08T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 0, completed: 0, retried: 0 });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });
});

function vectorDefinition() {
  return {
    schemaVersion: "focowiki-semantic-vector-v1",
    dimension: 3,
    similarity: "cosine" as const,
    families: ["content", "entity", "relationship", "community"] as const,
    mappingFingerprintSha256: "7".repeat(64)
  };
}

function cleanupAction(documentId: string) {
  return {
    publicId: `action-${documentId}`,
    operationPublicId: "operation-cleanup",
    knowledgeBaseId: "kb-cleanup",
    domain: "semantic_vector_document_cleanup",
    searchProviderKind: "opensearch" as const,
    target: {
      publicId: documentId,
      resourceKind: "semantic_vector_document",
      plane: "search" as const,
      required: true,
      sequence: 20
    },
    state: "running" as const,
    attempt: 1,
    leaseOwner: "cleanup-worker",
    leaseExpiresAt: "2027-08-08T00:01:00.000Z",
    safeErrorCode: null,
    notBefore: "2027-08-08T00:00:00.000Z",
    checkpoint: {
      semanticGenerationPublicId: "semantic-cleanup",
      mappingFingerprintSha256: "7".repeat(64)
    },
    idempotency: {
      key: `idempotency-${documentId}`,
      requestHash: "8".repeat(64)
    }
  };
}
