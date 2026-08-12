import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextPublicationWorker
} from "../src/storage-vnext/publication/worker.js";
import type { StorageVnextReleaseWritePort } from
  "../src/storage-vnext/release/ports.js";
import type { StorageVnextLiveWork } from
  "../src/storage-vnext/workflow/ports.js";

describe("storage vNext publication worker", () => {
  it("checkpoints a validated candidate before one atomic activation", async () => {
    const fixture = createFixture();
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      terminal: 0
    });

    expect(fixture.processor.publish).toHaveBeenCalledWith({
      knowledgeBaseId: fixture.work.knowledgeBaseId,
      candidatePublicId: fixture.candidate.publicId,
      operationPublicId: fixture.work.publicId,
      signal: expect.any(AbortSignal)
    });
    expect(fixture.workflow.saveCheckpoint).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      checkpoint: {
        phase: "candidate_ready",
        candidatePublicId: fixture.candidate.publicId,
        expectedActiveRootPublicId: null,
        expectedActiveRevision: 0,
        searchProjectionPublicId: "search-publication"
      }
    });
    expect(fixture.releases.activateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: fixture.work.knowledgeBaseId,
      candidatePublicId: fixture.candidate.publicId,
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      searchProjectionPublicId: "search-publication",
      rollbackExpiresAt: null,
      eventPublicId: expect.stringMatching(/^release-event-[0-9a-f]{64}$/u)
    }));
    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        kind: "publication",
        state: "completed",
        resultCode: "PUBLICATION_COMPLETED",
        summary: {
          candidatePublicId: fixture.candidate.publicId,
          releaseRootPublicId: "root-publication",
          searchProjectionPublicId: "search-publication"
        }
      })
    }));
  });

  it("enqueues the released activation event after durable activation", async () => {
    const fixture = createFixture();
    const dispatch = vi.fn(async () => undefined);
    const worker = createWorker(fixture, undefined, undefined, { dispatch });

    await expect(worker.runOnce(runRequest())).resolves.toMatchObject({ completed: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      eventId: "event-generation-activated-root-publication",
      eventType: "generation.activated",
      payload: {
        knowledgeBaseId: fixture.work.knowledgeBaseId,
        generationId: "root-publication"
      },
      createdAt: "2026-08-02T00:00:00.000Z"
    });
  });

  it("resumes activation from the durable candidate-ready checkpoint", async () => {
    const fixture = createFixture();
    fixture.work.checkpoint = {
      phase: "candidate_ready",
      candidatePublicId: fixture.candidate.publicId,
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      searchProjectionPublicId: "search-publication"
    };
    fixture.releases.getLiveCandidate.mockResolvedValueOnce(null);
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest())).resolves.toMatchObject({ completed: 1 });
    expect(fixture.processor.publish).not.toHaveBeenCalled();
    expect(fixture.releases.activateCandidate).toHaveBeenCalledOnce();
  });

  it("prepares and activates mutation work without overwriting its terminal hook", async () => {
    const fixture = createFixture();
    fixture.work.kind = "mutation";
    fixture.work.checkpoint = {
      version: 1,
      kind: "source_file_move",
      targetKind: "source_file",
      targetPublicId: "source-mutation",
      expectedResourceRevision: 3,
      currentLogicalPath: "Current.md",
      candidateLogicalPath: "Moved.md"
    };
    const mutations = {
      prepare: vi.fn(async () => ({
        checkpoint: {
          ...fixture.work.checkpoint,
          phase: "planning",
          candidatePublicId: fixture.candidate.publicId
        }
      }))
    };
    const worker = createWorker(fixture, undefined, mutations);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      terminal: 0
    });

    expect(fixture.workflow.claim).toHaveBeenCalledWith(expect.objectContaining({
      kinds: ["publication", "mutation"]
    }));
    expect(mutations.prepare).toHaveBeenCalledWith({
      work: fixture.work
    });
    expect(fixture.workflow.saveCheckpoint).toHaveBeenLastCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      checkpoint: expect.objectContaining({
        version: 1,
        kind: "source_file_move",
        targetPublicId: "source-mutation",
        phase: "candidate_ready",
        candidatePublicId: fixture.candidate.publicId,
        searchProjectionPublicId: "search-publication"
      })
    });
    expect(fixture.workflow.complete).not.toHaveBeenCalled();
  });

  it("waits for mutation semantic stages before publishing the search candidate", async () => {
    const fixture = createFixture();
    fixture.work.kind = "mutation";
    fixture.work.checkpoint = {
      version: 1,
      kind: "source_replace",
      targetKind: "source_file",
      targetPublicId: "source-mutation",
      expectedResourceRevision: 3
    };
    const mutations = {
      prepare: vi.fn(async () => ({
        checkpoint: {
          ...fixture.work.checkpoint,
          phase: "planning",
          candidatePublicId: fixture.candidate.publicId,
          semanticState: "ready"
        }
      })),
      ensureSemanticStages: vi.fn(async () => undefined),
      inspectSemanticStages: vi.fn(async () => ({ state: "pending" as const }))
    };
    const worker = createWorker(fixture, undefined, mutations);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });

    expect(fixture.workflow.saveCheckpoint).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      checkpoint: expect.objectContaining({
        phase: "planning",
        candidatePublicId: fixture.candidate.publicId,
        semanticState: "ready"
      })
    });
    expect(fixture.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z"
    });
    expect(mutations.ensureSemanticStages).toHaveBeenCalledWith({
      work: expect.objectContaining({
        checkpoint: expect.objectContaining({ semanticState: "ready" })
      })
    });
    expect(mutations.ensureSemanticStages.mock.invocationCallOrder[0])
      .toBeLessThan(mutations.inspectSemanticStages.mock.invocationCallOrder[0]!);
    expect(fixture.processor.publish).not.toHaveBeenCalled();
    expect(fixture.releases.activateCandidate).not.toHaveBeenCalled();
  });

  it("waits for current semantic publication stages before building a release", async () => {
    const fixture = createFixture();
    const readiness = {
      inspect: vi.fn(async () => ({ state: "pending" as const }))
    };
    const worker = createWorker(fixture, undefined, undefined, undefined, readiness);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });

    expect(readiness.inspect).toHaveBeenCalledWith({
      knowledgeBaseId: fixture.work.knowledgeBaseId
    });
    expect(fixture.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z"
    });
    expect(fixture.processor.publish).not.toHaveBeenCalled();
    expect(fixture.releases.activateCandidate).not.toHaveBeenCalled();
  });

  it("waits for current semantic source stages before a mutation owner builds a release", async () => {
    const fixture = createFixture();
    fixture.work.kind = "mutation";
    fixture.work.checkpoint = {
      version: 1,
      kind: "knowledge_base_metadata",
      targetKind: "knowledge_base",
      targetPublicId: fixture.work.knowledgeBaseId,
      expectedResourceRevision: 1
    };
    const mutations = {
      prepare: vi.fn(async () => ({
        checkpoint: {
          ...fixture.work.checkpoint,
          phase: "planning",
          candidatePublicId: fixture.candidate.publicId
        }
      }))
    };
    const readiness = {
      inspect: vi.fn(async () => ({ state: "pending" as const }))
    };
    const worker = createWorker(
      fixture,
      undefined,
      mutations,
      undefined,
      readiness
    );

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });

    expect(readiness.inspect).toHaveBeenCalledWith({
      knowledgeBaseId: fixture.work.knowledgeBaseId
    });
    expect(fixture.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z"
    });
    expect(fixture.processor.publish).not.toHaveBeenCalled();
    expect(fixture.releases.activateCandidate).not.toHaveBeenCalled();
  });

  it("continues without freezing a candidate when late readiness becomes pending", async () => {
    const fixture = createFixture();
    const readiness = {
      inspect: vi.fn()
        .mockResolvedValueOnce({ state: "ready" as const })
        .mockResolvedValueOnce({ state: "pending" as const })
    };
    fixture.processor.publish.mockImplementationOnce((async (request: {
      beforeValidate?: () => Promise<{ state: "ready" } | { state: "pending" }>;
    }) => {
      if (!request.beforeValidate) throw new Error("Late readiness is missing");
      return request.beforeValidate();
    }) as never);
    const worker = createWorker(
      fixture,
      undefined,
      undefined,
      undefined,
      readiness
    );

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });

    expect(readiness.inspect).toHaveBeenCalledTimes(2);
    expect(fixture.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z"
    });
    expect(fixture.workflow.releaseForRetry).not.toHaveBeenCalled();
    expect(fixture.workflow.saveCheckpoint).not.toHaveBeenCalled();
    expect(fixture.releases.activateCandidate).not.toHaveBeenCalled();
  });

  it("waits for an uncommitted coalesced candidate without recording a failure", async () => {
    const fixture = createFixture();
    fixture.releases.getLiveCandidate.mockResolvedValueOnce(null);
    const onFailure = vi.fn();
    const worker = createWorker(fixture, onFailure);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });

    expect(fixture.workflow.releaseForContinuation).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z"
    });
    expect(fixture.workflow.releaseForRetry).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("supersedes a coalescing loser when another live candidate owns the scope", async () => {
    const fixture = createFixture();
    fixture.releases.getLiveCandidate.mockResolvedValueOnce({
      ...fixture.candidate,
      publicId: "candidate-winner",
      operationPublicId: "publication-operation-winner"
    });
    const onFailure = vi.fn();
    const worker = createWorker(fixture, onFailure);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 0,
      terminal: 1
    });

    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        state: "superseded",
        resultCode: "PUBLICATION_SUPERSEDED",
        correlationPublicId: "candidate-winner"
      })
    }));
    expect(fixture.workflow.releaseForRetry).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("releases a failed attempt for retry without terminating the candidate", async () => {
    const fixture = createFixture();
    fixture.processor.publish.mockRejectedValueOnce(new Error("provider payload"));
    const onFailure = vi.fn();
    const worker = createWorker(fixture, onFailure);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });
    expect(fixture.workflow.releaseForRetry).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z",
      reasonCode: "PUBLICATION_FAILED"
    });
    expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith({
      operationPublicId: fixture.work.publicId,
      knowledgeBaseId: fixture.work.knowledgeBaseId,
      attempt: 1,
      code: "PUBLICATION_FAILED",
      error: expect.objectContaining({ message: "provider payload" })
    });
  });

  it("renews the durable lease while a publication attempt is still running", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture();
      let finishPublication!: (value: { searchProjectionPublicId: string }) => void;
      fixture.processor.publish.mockImplementationOnce(() => new Promise((resolve) => {
        finishPublication = resolve;
      }));
      const worker = createWorker(fixture);
      const outcome = worker.runOnce(runRequest());
      await vi.advanceTimersByTimeAsync(15_000);

      expect(fixture.workflow.renew).toHaveBeenCalledWith({
        publicId: fixture.work.publicId,
        owner: "publication-worker-one",
        leaseExpiresAt: "2026-08-02T00:05:00.000Z"
      });
      finishPublication({ searchProjectionPublicId: "search-publication" });
      await expect(outcome).resolves.toMatchObject({ completed: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not terminate a candidate after heartbeat ownership is lost", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture();
      fixture.work.attempt = 3;
      fixture.workflow.renew.mockResolvedValueOnce(false);
      fixture.processor.publish.mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) => new Promise<{
          searchProjectionPublicId: string;
        }>((_resolve, reject) => signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        ))
      );
      const worker = createWorker(fixture);
      const outcome = worker.runOnce(runRequest());
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(outcome).resolves.toEqual({
        claimed: 1,
        completed: 0,
        retried: 0,
        terminal: 1
      });
      expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
      expect(fixture.workflow.complete).not.toHaveBeenCalled();
      expect(fixture.workflow.releaseForRetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the role alive when concurrent terminal convergence owns the retry transition", async () => {
    const fixture = createFixture();
    fixture.processor.publish.mockRejectedValueOnce(new Error("provider payload"));
    fixture.workflow.releaseForRetry.mockRejectedValueOnce(Object.assign(
      new Error("Work lease was already released"),
      { code: "lease_lost" }
    ));
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 0,
      terminal: 1
    });
    expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
    expect(fixture.workflow.complete).not.toHaveBeenCalled();
  });

  it("releases a rollback-pending activation for retry without crashing the role", async () => {
    const fixture = createFixture();
    fixture.releases.activateCandidate.mockResolvedValueOnce({
      outcome: "rollback_pending" as const,
      rollbackRootPublicId: "rollback-root-publication",
      expiresAt: "2026-08-03T00:00:00.000Z"
    });
    const onFailure = vi.fn();
    const worker = createWorker(fixture, onFailure);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });
    expect(fixture.workflow.releaseForRetry).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "publication-worker-one",
      nextAttemptAt: "2026-08-02T00:01:00.000Z",
      reasonCode: "PUBLICATION_ROLLBACK_PENDING"
    });
    expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      operationPublicId: fixture.work.publicId,
      knowledgeBaseId: fixture.work.knowledgeBaseId,
      attempt: 1,
      code: "PUBLICATION_ROLLBACK_PENDING"
    }));
  });

  it("terminalizes the candidate after retry exhaustion without persisting provider details", async () => {
    const fixture = createFixture();
    fixture.work.attempt = 3;
    fixture.processor.publish.mockRejectedValueOnce(new Error("private provider payload"));
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest())).resolves.toMatchObject({ terminal: 1 });
    expect(fixture.releases.terminateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      reasonCode: "PUBLICATION_FAILED",
      safeMessage: null
    }));
    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        state: "failed",
        resultCode: "PUBLICATION_FAILED",
        safeMessage: null,
        summary: expect.not.objectContaining({ error: expect.anything() })
      })
    }));
  });

  it("preserves a deferred public mutation failure code at terminal convergence", async () => {
    const fixture = createFixture();
    fixture.work.kind = "mutation";
    fixture.work.attempt = 3;
    fixture.work.checkpoint = {
      version: 1,
      kind: "source_file_move",
      targetKind: "source_file",
      targetPublicId: "source-mutation",
      expectedResourceRevision: 3,
      terminalFailureCode: "RESOURCE_PATH_CONFLICT"
    };
    const failure = Object.assign(new Error("Missing destination parent"), {
      code: "RESOURCE_PATH_CONFLICT"
    });
    const mutations = {
      prepare: vi.fn(async () => Promise.reject(failure)),
      terminate: vi.fn(async () => undefined)
    };
    const worker = createWorker(fixture, undefined, mutations);

    await expect(worker.runOnce(runRequest())).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 0,
      terminal: 1
    });
    expect(mutations.terminate).toHaveBeenCalledWith(expect.objectContaining({
      work: fixture.work,
      outcome: "failed",
      resultCode: "RESOURCE_PATH_CONFLICT"
    }));
  });
});

function createWorker(
  fixture: ReturnType<typeof createFixture>,
  onFailure?: (failure: {
    operationPublicId: string;
    knowledgeBaseId: string;
    attempt: number;
    code: string;
    error: unknown;
  }) => void,
  mutations?: {
    prepare(input: {
      work: StorageVnextLiveWork;
      signal?: AbortSignal;
    }): Promise<{ checkpoint: StorageVnextLiveWork["checkpoint"] }>;
    inspectSemanticStages?(input: {
      work: StorageVnextLiveWork;
    }): Promise<
      | { state: "ready" }
      | { state: "pending" }
      | { state: "failed"; safeCode: string }
    >;
    ensureSemanticStages?(input: {
      work: StorageVnextLiveWork;
    }): Promise<void>;
    terminate?(input: {
      work: StorageVnextLiveWork;
      outcome: "failed" | "timed_out";
      resultCode: string;
      completedAt: string;
      resultExpiresAt: string;
    }): Promise<void>;
  },
  webhooks?: { dispatch(event: Record<string, unknown>): Promise<void> },
  readiness?: {
    inspect(input: { knowledgeBaseId: string }): Promise<
      | { state: "ready" }
      | { state: "pending" }
    >;
  }
) {
  return createStorageVnextPublicationWorker({
    workflow: fixture.workflow,
    releases: fixture.releases,
    processor: fixture.processor,
    limits: {
      maximumConcurrency: 1,
      maximumAttempts: 3,
      attemptDeadlineMilliseconds: 30_000,
      heartbeatIntervalMilliseconds: 15_000,
      leaseTtlMilliseconds: 300_000,
      retryDelayMilliseconds: 60_000,
      resultRetentionMilliseconds: 604_800_000,
      rollbackRetentionMilliseconds: 86_400_000
    },
    clock: () => "2026-08-02T00:00:00.000Z",
    ...(readiness ? { readiness } : {}),
    ...(mutations ? { mutations } : {}),
    ...(onFailure ? { onFailure } : {}),
    ...(webhooks ? { webhooks } : {})
  });
}

function createFixture() {
  const work: StorageVnextLiveWork = {
    publicId: "publication-operation-one",
    knowledgeBaseId: "kb-publication",
    kind: "publication" as const,
    searchProviderKind: null,
    state: "running" as const,
    operationRevision: 1,
    settingsRevisionPublicId: "settings-publication",
    attempt: 1,
    leaseOwner: "publication-worker-one",
    leaseExpiresAt: "2026-08-02T00:05:00.000Z",
    nextAttemptAt: null,
    safeErrorCode: null,
    checkpoint: {
      phase: "planning",
      candidatePublicId: "candidate-publication"
    },
    idempotency: {
      key: "publication-one",
      requestHash: "a".repeat(64),
      expiresAt: "2026-08-09T00:00:00.000Z"
    }
  };
  const candidate = {
    publicId: "candidate-publication",
    knowledgeBaseId: "kb-publication",
    operationPublicId: work.publicId,
    candidateRootPublicId: "candidate-root-publication",
    expectedActiveRootPublicId: null,
    expectedActiveRevision: 0,
    state: "building" as const,
    factRevision: 1,
    changedFactCount: 1,
    affectedDependencyCount: 1,
    manifestChecksum: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z"
  };
  const workflow = {
    claim: vi.fn(async () => [work]),
    renew: vi.fn(async () => true),
    saveCheckpoint: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    releaseForRetry: vi.fn(async () => undefined),
    releaseForContinuation: vi.fn(async () => undefined)
  };
  const releases = {
    getLiveCandidate: vi.fn(async () => candidate as typeof candidate | null),
    activateCandidate: vi.fn<StorageVnextReleaseWritePort["activateCandidate"]>(async () => ({
      outcome: "activated" as const,
      snapshot: {
        knowledgeBaseId: "kb-publication",
        revision: 1,
        releaseRootPublicId: "root-publication",
        searchProjectionPublicId: "search-publication",
        manifestChecksum: "b".repeat(64),
        navigationProfileVersion: 1,
        activatedByOperationPublicId: work.publicId,
        publiclyVisibleAt: "2026-08-02T00:00:00.000Z"
      },
      rollbackRootPublicId: null
    })),
    terminateCandidate: vi.fn(async () => true)
  };
  const processor = {
    publish: vi.fn<(input: { signal: AbortSignal }) => Promise<{
      searchProjectionPublicId: string;
    }>>(async () => ({ searchProjectionPublicId: "search-publication" }))
  };
  return { work, candidate, workflow, releases, processor };
}

function runRequest() {
  return {
    owner: "publication-worker-one",
    limit: 1,
    leaseExpiresAt: "2026-08-02T00:05:00.000Z"
  };
}
