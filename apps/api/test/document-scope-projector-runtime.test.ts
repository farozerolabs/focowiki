import { describe, expect, it, vi } from "vitest";
import { createDocumentScopeProjectorRuntime } from
  "../src/document-indexing/application/document-scope-projector-runtime.js";

describe("document scope projector runtime", () => {
  it("hot-applies the concurrency limit for subsequent claims", () => {
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      maximumConcurrency: 1,
      scopes: {
        async claim() { return []; },
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      },
      async commit() { return completedCommit(["job-concurrent"]); },
      async persist() {},
      async render() {
        return {
          outputFingerprintSha256: "f".repeat(64),
          storageRequests: {
            put: 0, head: 0, verification: 0, attemptedBytes: 0,
            retries: 0, latencyMilliseconds: 0
          }
        };
      },
      async finalize() { return 0; },
      now: () => "2026-08-20T00:00:00.000Z",
      wait: async () => undefined,
      classifyError: () => ({ code: "UNEXPECTED", retryable: false })
    });

    expect(runtime.maximumConcurrency()).toBe(1);
    runtime.updateMaximumConcurrency(8);
    expect(runtime.maximumConcurrency()).toBe(8);
  });

  it("renders a fixed scope sequence and acknowledges every covered contributor", async () => {
    const calls: string[] = [];
    const commit = vi.fn(async () => completedCommit(["job-1", "job-2"]));
    const persist = vi.fn(async () => { calls.push("persist"); });
    const finalize = vi.fn(async () => 2);
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      scopes: {
        async claim() {
          return [{
            publicId: "scope-1",
            knowledgeBaseId: "kb-1",
            kind: "_index" as const,
            key: "term:han",
            requiredSequence: 11,
            renderedSequence: 11
          }];
        },
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      },
      commit,
      persist,
      async render(scope) {
        calls.push("render");
        expect(scope.renderedSequence).toBe(11);
        return {
          outputFingerprintSha256: "e".repeat(64),
          storageRequests: {
            put: 2,
            head: 1,
            verification: 1,
            attemptedBytes: 512,
            retries: 0,
            latencyMilliseconds: 25.5
          }
        };
      },
      finalize,
      now: () => "2026-08-17T10:00:00.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", retryable: false };
      }
    });

    await expect(runtime.runOne(new AbortController().signal)).resolves.toBe(true);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "scope-1",
      renderedSequence: 11,
      outputFingerprintSha256: "e".repeat(64),
      storageRequests: {
        put: 2,
        head: 1,
        verification: 1,
        attemptedBytes: 512,
        retries: 0,
        latencyMilliseconds: 25.5
      }
    }));
    expect(calls).toEqual(["render", "persist"]);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: "scope-1" }),
      expect.objectContaining({ outputFingerprintSha256: "e".repeat(64) }),
      expect.any(AbortSignal)
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(runtime.activeCount()).toBe(0);
  });

  it("records a bounded retry without acknowledging a failed render", async () => {
    const commit = vi.fn(async () => completedCommit());
    const fail = vi.fn(async () => "waiting" as const);
    const onFailure = vi.fn();
    const renderFailure = new Error("temporary storage failure");
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      scopes: {
        async claim() {
          return [{
            publicId: "scope-2",
            knowledgeBaseId: "kb-1",
            kind: "source" as const,
            key: "source-1",
            requiredSequence: 12,
            renderedSequence: 12
          }];
        },
        fail,
        async recoverExpired() { return 0; }
      },
      commit,
      async persist() {},
      async render() { throw renderFailure; },
      async finalize() { return 0; },
      now: () => "2026-08-17T10:00:00.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "SCOPE_STORAGE_UNAVAILABLE", retryable: true };
      },
      onFailure,
      retryDelayMs: () => 2_000
    });

    await expect(runtime.runOne(new AbortController().signal)).resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "SCOPE_STORAGE_UNAVAILABLE",
      retryable: true,
      nextEligibleAt: "2026-08-17T10:00:02.000Z"
    }));
    expect(commit).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ publicId: "scope-2" }),
      error: renderFailure,
      errorCode: "SCOPE_STORAGE_UNAVAILABLE",
      retryable: true
    }));
  });

  it("drains every contributor in bounded completion pages", async () => {
    const documentJobPublicIds = Array.from(
      { length: 300 },
      (_, index) => `job-page-${index}`
    );
    const finalize = vi.fn(async (request: {
      documentJobPublicIds?: readonly string[];
    }) => request.documentJobPublicIds?.[0] === "job-page-0"
      ? finalize.mock.calls.length < 4 ? 64 : 8
      : 44);
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      scopes: {
        async claim() { return [scopeClaim("scope-paged", 1)]; },
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      },
      async commit() { return completedCommit(documentJobPublicIds); },
      async persist() {},
      async render() {
        return {
          outputFingerprintSha256: "f".repeat(64),
          storageRequests: zeroStorageRequests()
        };
      },
      finalize,
      now: () => "2026-08-17T10:00:00.000Z",
      wait: async () => undefined,
      classifyError: () => ({ code: "UNEXPECTED", retryable: false })
    });

    await expect(runtime.runOne(new AbortController().signal)).resolves.toBe(true);
    expect(finalize).toHaveBeenCalledTimes(5);
    expect(finalize.mock.calls.map(([request]) =>
      request.documentJobPublicIds?.length)).toEqual([256, 256, 256, 256, 44]);
  });

  it("retries after immutable output is written but candidate persistence fails",
    async () => {
      const commit = vi.fn(async () => completedCommit());
      const fail = vi.fn(async () => "waiting" as const);
      const persist = vi.fn(async () => {
        throw new Error("candidate persistence unavailable");
      });
      const runtime = createDocumentScopeProjectorRuntime({
        workerId: "scope-worker",
        leaseDurationMs: 30_000,
        scopes: {
          async claim() {
            return [scopeClaim("scope-after-write", 13)];
          },
          fail,
          async recoverExpired() { return 0; }
        },
        commit,
        persist,
        async render() {
          return {
            outputFingerprintSha256: "a".repeat(64),
            storageRequests: {
              ...zeroStorageRequests(),
              put: 1,
              attemptedBytes: 256
            }
          };
        },
        async finalize() { return 0; },
        now: () => "2026-08-17T10:00:00.000Z",
        wait: async () => undefined,
        classifyError() {
          return { code: "SCOPE_CANDIDATE_PERSIST_FAILED", retryable: true };
        },
        retryDelayMs: () => 2_000
      });

      await expect(runtime.runOne(new AbortController().signal))
        .resolves.toBe(true);
      expect(persist).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(expect.objectContaining({
        publicId: "scope-after-write",
        errorCode: "SCOPE_CANDIDATE_PERSIST_FAILED",
        retryable: true,
        nextEligibleAt: "2026-08-17T10:00:02.000Z"
      }));
    });

  it("retries when receipt commit fails after candidate persistence", async () => {
    const fail = vi.fn(async () => "waiting" as const);
    const persist = vi.fn(async () => undefined);
    const commit = vi.fn(async () => {
      throw new Error("receipt transaction unavailable");
    });
    const finalize = vi.fn(async () => 0);
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      scopes: {
        async claim() {
          return [scopeClaim("scope-before-receipt", 14)];
        },
        fail,
        async recoverExpired() { return 0; }
      },
      commit,
      persist,
      async render() {
        return {
          outputFingerprintSha256: "b".repeat(64),
          storageRequests: zeroStorageRequests()
        };
      },
      finalize,
      now: () => "2026-08-17T10:00:00.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "SCOPE_RECEIPT_COMMIT_FAILED", retryable: true };
      }
    });

    await expect(runtime.runOne(new AbortController().signal))
      .resolves.toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "scope-before-receipt",
      errorCode: "SCOPE_RECEIPT_COMMIT_FAILED",
      retryable: true
    }));
  });

  it("finalizes covered contributors even when no scope needs rendering", async () => {
    const controller = new AbortController();
    const finalize = vi.fn(async () => 1);
    const wait = vi.fn(async () => { controller.abort(); });
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      scopes: {
        async claim() { return []; },
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      },
      async commit() { return completedCommit(); },
      async persist() {},
      async render() {
        throw new Error("no scope should render");
      },
      finalize,
      now: () => "2026-08-17T10:00:00.000Z",
      wait,
      classifyError() {
        return { code: "UNEXPECTED", retryable: false };
      }
    });

    await runtime.run(controller.signal);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("renders disjoint scopes concurrently without sharing their receipts", async () => {
    const controller = new AbortController();
    const queued = ["scope-a", "scope-b"];
    const gate = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      maximumConcurrency: 2,
      scopes: {
        async claim() {
          const publicId = queued.shift();
          return publicId ? [{
            publicId,
            knowledgeBaseId: "kb-1",
            kind: "directory" as const,
            key: `pages/${publicId}`,
            requiredSequence: 1,
            renderedSequence: 1
          }] : [];
        },
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      },
      async commit() { return completedCommit(["job-concurrent"]); },
      async persist() {},
      async render() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (maximumActive === 2) gate.resolve();
        await gate.promise;
        active -= 1;
        return {
          outputFingerprintSha256: "f".repeat(64),
          storageRequests: zeroStorageRequests()
        };
      },
      async finalize() {
        if (queued.length === 0 && active === 0) controller.abort();
        return 1;
      },
      now: () => "2026-08-17T10:00:00.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", retryable: false };
      }
    });

    await runtime.run(controller.signal);
    expect(maximumActive).toBe(2);
  });

  it("claims every free projector slot in one bounded database request", async () => {
    const controller = new AbortController();
    let claimed = false;
    let finalized = 0;
    const claim = vi.fn(async ({ limit }: { limit: number }) => {
      if (claimed) return [];
      claimed = true;
      expect(limit).toBe(4);
      return Array.from({ length: limit }, (_, index) =>
        scopeClaim(`scope-batch-${index}`, index + 1));
    });
    const runtime = createDocumentScopeProjectorRuntime({
      workerId: "scope-worker",
      leaseDurationMs: 30_000,
      maximumConcurrency: 4,
      scopes: {
        claim,
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      },
      async commit() { return completedCommit(["job-batch"]); },
      async persist() {},
      async render() {
        return {
          outputFingerprintSha256: "f".repeat(64),
          storageRequests: zeroStorageRequests()
        };
      },
      async finalize() {
        finalized += 1;
        if (finalized === 4) controller.abort();
        return 1;
      },
      now: () => "2026-08-17T10:00:00.000Z",
      wait: async () => undefined,
      classifyError: () => ({ code: "UNEXPECTED", retryable: false })
    });

    await runtime.run(controller.signal);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function completedCommit(documentJobPublicIds: readonly string[] = []) {
  return {
    state: "completed" as const,
    readyDocumentJobPublicIds: documentJobPublicIds
  };
}

function zeroStorageRequests() {
  return {
    put: 0,
    head: 0,
    verification: 0,
    attemptedBytes: 0,
    retries: 0,
    latencyMilliseconds: 0
  };
}

function scopeClaim(publicId: string, renderedSequence: number) {
  return {
    publicId,
    knowledgeBaseId: "kb-1",
    kind: "_index" as const,
    key: "term:han",
    requiredSequence: renderedSequence,
    renderedSequence
  };
}
