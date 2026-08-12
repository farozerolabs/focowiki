import { describe, expect, it, vi } from "vitest";
import { createStorageVnextProviderIndexCleanupWorker } from
  "../src/storage-vnext/search/provider-index-cleanup-worker.js";

describe("storage vNext provider index cleanup worker", () => {
  it("bounds runtime cleanup batches to the repository claim limit", async () => {
    const actions = {
      claim: vi.fn(async () => []),
      complete: vi.fn(async () => true),
      releaseForRetry: vi.fn()
    };
    const worker = createStorageVnextProviderIndexCleanupWorker({
      actions,
      provider: {
        kind: "meilisearch",
        admin: {} as never,
        operations: {} as never
      },
      maxPollAttempts: 3,
      pollIntervalMs: 0,
      retryDelayMs: 1_000
    });

    await expect(worker.runBatch({
      owner: "provider-index-cleanup-worker",
      limit: 1_000,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toEqual({ claimed: 0, completed: 0, retried: 0 });

    expect(actions.claim).toHaveBeenCalledWith(expect.objectContaining({
      limit: 100
    }));
  });

  it("claims and deletes only exact indexes owned by the selected provider", async () => {
    const action = cleanupAction();
    const actions = {
      claim: vi.fn(async (input: { selector?: { domain?: string } }) =>
        input.selector?.domain === "provider_adoption" ? [action] : []),
      complete: vi.fn(async () => true),
      releaseForRetry: vi.fn()
    };
    const deleteIndex = vi.fn(async () => ({
      state: "pending" as const,
      operationRef: "opensearch-delete-retired"
    }));
    const getOperation = vi.fn(async () => ({ state: "completed" as const }));
    const worker = createStorageVnextProviderIndexCleanupWorker({
      actions,
      provider: {
        kind: "opensearch",
        admin: { deleteIndex } as never,
        operations: { getOperation } as never
      },
      maxPollAttempts: 3,
      pollIntervalMs: 0,
      retryDelayMs: 1_000
    });

    await expect(worker.runBatch({
      owner: "provider-index-cleanup-worker",
      limit: 10,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 });

    expect(actions.claim).toHaveBeenCalledWith(expect.objectContaining({
      selector: {
        domain: "provider_adoption",
        plane: "search",
        resourceKind: "search_index",
        searchProviderKind: "opensearch"
      }
    }));
    expect(deleteIndex).toHaveBeenCalledWith({
      indexUid: "focowiki_opensearch_retired"
    });
    expect(getOperation).toHaveBeenCalledWith({
      operationRef: "opensearch-delete-retired"
    });
    expect(actions.complete).toHaveBeenCalledWith({
      publicId: "cleanup-provider-index",
      owner: "provider-index-cleanup-worker"
    });
  });

  it("prioritizes release-retirement cleanup without accepting another provider", async () => {
    const action = {
      ...cleanupAction(),
      publicId: "cleanup-retired-release-index",
      domain: "search_projection_retirement",
      target: {
        ...cleanupAction().target,
        publicId: "focowiki_opensearch_retired_release"
      },
      checkpoint: {
        providerIndexUid: "focowiki_opensearch_retired_release"
      }
    };
    const actions = {
      claim: vi.fn(async (input: { selector?: { domain?: string } }) =>
        input.selector?.domain === "search_projection_retirement" ? [action] : []),
      complete: vi.fn(async () => true),
      releaseForRetry: vi.fn()
    };
    const deleteIndex = vi.fn(async () => ({ state: "completed" as const }));
    const worker = createStorageVnextProviderIndexCleanupWorker({
      actions,
      provider: {
        kind: "opensearch",
        admin: { deleteIndex } as never,
        operations: {} as never
      },
      maxPollAttempts: 3,
      pollIntervalMs: 0,
      retryDelayMs: 1_000
    });

    await expect(worker.runBatch({
      owner: "provider-index-cleanup-worker",
      limit: 10,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 });

    expect(actions.claim).toHaveBeenNthCalledWith(1, expect.objectContaining({
      selector: {
        domain: "search_projection_retirement",
        plane: "search",
        resourceKind: "search_index",
        searchProviderKind: "opensearch"
      }
    }));
    expect(deleteIndex).toHaveBeenCalledWith({
      indexUid: "focowiki_opensearch_retired_release"
    });
  });
});

function cleanupAction() {
  return {
    publicId: "cleanup-provider-index",
    operationPublicId: "maintenance-provider-adoption",
    knowledgeBaseId: "kb-provider-adoption",
    domain: "provider_adoption",
    searchProviderKind: "opensearch" as const,
    target: {
      publicId: "focowiki_opensearch_retired",
      resourceKind: "search_index",
      plane: "search" as const,
      required: false,
      sequence: 0
    },
    state: "running" as const,
    attempt: 1,
    leaseOwner: "provider-index-cleanup-worker",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    safeErrorCode: null,
    notBefore: new Date(Date.now() - 1_000).toISOString(),
    checkpoint: { providerIndexUid: "focowiki_opensearch_retired" },
    idempotency: { key: "cleanup-provider-index", requestHash: "a".repeat(64) }
  };
}
