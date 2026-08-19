import { describe, expect, it, vi } from "vitest";
import { createDocumentFixedDagRuntime } from
  "../src/document-indexing/application/document-fixed-dag-runtime.js";
import { createDocumentFixedDagScheduler } from
  "../src/document-indexing/application/document-fixed-dag-scheduler.js";
import { createDocumentResourceLanes } from
  "../src/document-indexing/application/document-resource-lanes.js";
import type { ClaimedDocumentArtifactWork } from
  "../src/document-indexing/application/document-work-port.js";

const work: ClaimedDocumentArtifactWork = {
  publicId: "work-1",
  knowledgeBaseId: "kb-1",
  documentJobPublicId: "job-1",
  sourceFilePublicId: "source-file-1",
  sourceRevisionPublicId: "source-revision-1",
  kind: "first_layer",
  resourceLane: "generation_model",
  inputFingerprintSha256: "a".repeat(64),
  attemptCount: 1,
  maximumAttempts: 3,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-08-15T00:01:00.000Z",
  startedAt: "2026-08-15T00:00:00.000Z"
};

describe("fixed document DAG runtime", () => {
  it("runs knowledge projection preparations concurrently at lane capacity", async () => {
    const queued = ["work-projection-1", "work-projection-2"];
    const lanes = createDocumentResourceLanes({
      capacities: {
        postgres_s3: 2,
        generation_model: 1,
        graphrag_adapter: 1,
        embedding: 2,
        search_transport: 2,
        projection: 2,
        activation: 2,
        cleanup: 1
      },
      maximumWaitersPerLane: 8
    });
    const scheduler = createDocumentFixedDagScheduler({
      work: {
        async claim({ kind, resourceLane }) {
          const publicId = queued.shift();
          return publicId ? [{
            ...work,
            publicId,
            documentJobPublicId: `job-${publicId}`,
            sourceFilePublicId: `source-${publicId}`,
            sourceRevisionPublicId: `revision-${publicId}`,
            kind,
            resourceLane
          }] : [];
        }
      },
      lanes
    });
    let activeProjectionCount = 0;
    let maximumActiveProjectionCount = 0;
    const release = deferred<void>();
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler,
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        async fail() { return "error"; },
        async recoverExpired() { return 0; }
      },
      handlers: {
        async knowledge_projection() {
          activeProjectionCount += 1;
          maximumActiveProjectionCount = Math.max(
            maximumActiveProjectionCount,
            activeProjectionCount
          );
          await release.promise;
          activeProjectionCount -= 1;
          return {
            key: "closure",
            outputFingerprintSha256: "b".repeat(64),
            value: {},
            serviceEndedAt: "2026-08-15T00:00:01.000Z"
          };
        }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", safeMessage: null, retryable: false };
      }
    });

    const first = runtime.runOne(
      "knowledge_projection",
      new AbortController().signal
    );
    const second = runtime.runOne(
      "knowledge_projection",
      new AbortController().signal
    );
    await eventually(() => expect(maximumActiveProjectionCount).toBe(2));
    expect(lanes.snapshot()).toMatchObject({
      projection: { active: 2 },
      activation: { active: 0 }
    });
    release.resolve();
    await Promise.all([first, second]);
  });

  it("scans fixed work kinds without occupying the whole database pool", async () => {
    const controller = new AbortController();
    let concurrentClaims = 0;
    let maximumConcurrentClaims = 0;
    let claimCount = 0;
    const noWorkHandler = async () => ({
      key: "source",
      outputFingerprintSha256: "b".repeat(64),
      value: {},
      serviceEndedAt: "2026-08-15T00:00:01.000Z"
    });
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() {
          concurrentClaims += 1;
          maximumConcurrentClaims = Math.max(
            maximumConcurrentClaims,
            concurrentClaims
          );
          await Promise.resolve();
          concurrentClaims -= 1;
          claimCount += 1;
          if (claimCount === 8) controller.abort();
          return null;
        },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        async fail() { return "error"; },
        async recoverExpired() { return 0; }
      },
      handlers: {
        prepare: noWorkHandler,
        first_layer: noWorkHandler,
        content_projection: noWorkHandler,
        graphrag: noWorkHandler,
        relation_reconcile: noWorkHandler,
        knowledge_projection: noWorkHandler,
        activate: noWorkHandler,
        cleanup: noWorkHandler
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", safeMessage: null, retryable: false };
      }
    });

    await runtime.run(controller.signal);

    expect(maximumConcurrentClaims).toBe(1);
  });

  it("rotates claim priority so a shared resource lane cannot starve", async () => {
    const controller = new AbortController();
    const claimedKinds: string[] = [];
    const noWorkHandler = async () => ({
      key: "source",
      outputFingerprintSha256: "b".repeat(64),
      value: {},
      serviceEndedAt: "2026-08-15T00:00:01.000Z"
    });
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne(request) {
          claimedKinds.push(request.kind);
          if (claimedKinds.length === 16) controller.abort();
          return null;
        },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        async fail() { return "error"; },
        async recoverExpired() { return 0; }
      },
      handlers: {
        prepare: noWorkHandler,
        first_layer: noWorkHandler,
        content_projection: noWorkHandler,
        graphrag: noWorkHandler,
        relation_reconcile: noWorkHandler,
        knowledge_projection: noWorkHandler,
        activate: noWorkHandler,
        cleanup: noWorkHandler
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", safeMessage: null, retryable: false };
      }
    });

    await runtime.run(controller.signal);

    expect(claimedKinds.slice(0, 8)).toEqual([
      "prepare", "first_layer", "content_projection", "graphrag",
      "relation_reconcile", "activate", "knowledge_projection", "cleanup"
    ]);
    expect(claimedKinds.slice(8, 16)).toEqual([
      "first_layer", "content_projection", "graphrag", "relation_reconcile",
      "activate", "knowledge_projection", "cleanup", "prepare"
    ]);
  });

  it("drains activation before admitting another knowledge projection", async () => {
    const controller = new AbortController();
    const claimedKinds: string[] = [];
    const noWorkHandler = async () => ({
      key: "source",
      outputFingerprintSha256: "b".repeat(64),
      value: {},
      serviceEndedAt: "2026-08-15T00:00:01.000Z"
    });
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne(request) {
          claimedKinds.push(request.kind);
          if (claimedKinds.length === 8) controller.abort();
          return null;
        },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        async fail() { return "error"; },
        async recoverExpired() { return 0; }
      },
      handlers: {
        prepare: noWorkHandler,
        first_layer: noWorkHandler,
        content_projection: noWorkHandler,
        graphrag: noWorkHandler,
        relation_reconcile: noWorkHandler,
        knowledge_projection: noWorkHandler,
        activate: noWorkHandler,
        cleanup: noWorkHandler
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", safeMessage: null, retryable: false };
      }
    });

    await runtime.run(controller.signal);

    expect(claimedKinds.indexOf("activate"))
      .toBeLessThan(claimedKinds.indexOf("knowledge_projection"));
  });

  it("heartbeats, commits the domain receipt, and releases capacity", async () => {
    const release = vi.fn();
    const complete = vi.fn(async () => true);
    const heartbeat = vi.fn(async () => true);
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() { return work; },
        release
      },
      work: {
        complete,
        heartbeat,
        async fail() { return "error"; },
        async recoverExpired() { return 0; }
      },
      handlers: {
        async first_layer({ claimed }) {
          return {
            key: "mandatory",
            outputFingerprintSha256: "b".repeat(64),
            value: { model: "generation-model" },
            serviceEndedAt: claimed.startedAt
          };
        }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", safeMessage: null, retryable: false };
      }
    });

    await expect(runtime.runOne("first_layer", new AbortController().signal))
      .resolves.toBe(true);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "work-1",
      receipt: expect.objectContaining({
        kind: "first_layer",
        key: "mandatory",
        inputFingerprintSha256: "a".repeat(64),
        outputFingerprintSha256: "b".repeat(64)
      })
    }));
    expect(release).toHaveBeenCalledWith("work-1", "success");
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("ends projection execution after a durable waiting transition", async () => {
    const release = vi.fn();
    const complete = vi.fn(async () => true);
    const onWorkEvent = vi.fn();
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() {
          return { ...work, kind: "knowledge_projection", resourceLane: "projection" };
        },
        release
      },
      work: {
        complete,
        async heartbeat() { return true; },
        async fail() { return "error"; },
        async recoverExpired() { return 0; }
      },
      handlers: {
        async knowledge_projection({ releasePrimaryLane }) {
          releasePrimaryLane();
          return {
            key: "projection-scopes",
            outputFingerprintSha256: "c".repeat(64),
            value: { scopeCount: 3 },
            serviceEndedAt: "2026-08-15T00:00:01.000Z",
            committedByHandler: true,
            disposition: "waiting_on_projection" as const
          };
        }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return { code: "UNEXPECTED", safeMessage: null, retryable: false };
      },
      onWorkEvent
    });

    await expect(runtime.runOne(
      "knowledge_projection",
      new AbortController().signal
    )).resolves.toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(onWorkEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "waiting_on_projection"
    }));
    expect(runtime.activeCount()).toBe(0);
  });

  it("isolates a poison item and releases the lane after recording failure", async () => {
    const release = vi.fn();
    const fail = vi.fn(async () => "error" as const);
    const onWorkEvent = vi.fn();
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() { return work; },
        release
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        fail,
        async recoverExpired() { return 0; }
      },
      handlers: {
        async first_layer() {
          throw Object.assign(new Error("provider rejected request"), {
            constraint_name: "generated_page_heads_path_key",
            resourcePath: "_graph/by-file/guides/index.md",
            targetPath: "pages/孤立/无关系.md"
          });
        }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return {
          code: "GENERATION_REQUEST_REJECTED",
          safeMessage: "The generation provider rejected the request.",
          retryable: false
        };
      },
      onWorkEvent
    });

    await expect(runtime.runOne("first_layer", new AbortController().signal))
      .resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "work-1",
      errorCode: "GENERATION_REQUEST_REJECTED",
      retryable: false,
      nextEligibleAt: null
    }));
    expect(release).toHaveBeenCalledWith("work-1", "failure");
    expect(onWorkEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "failed",
      errorConstraint: "generated_page_heads_path_key",
      errorResource: "_graph/by-file/guides/index.md",
      errorTarget: "pages/%E5%AD%A4%E7%AB%8B/%E6%97%A0%E5%85%B3%E7%B3%BB.md"
    }));
  });

  it("keeps manual retry available after automatic attempts are exhausted", async () => {
    const fail = vi.fn(async () => "error" as const);
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() { return { ...work, attemptCount: 3 }; },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        fail,
        async recoverExpired() { return 0; }
      },
      handlers: {
        async first_layer() { throw new Error("temporary provider failure"); }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return {
          code: "GENERATION_PROVIDER_UNAVAILABLE",
          safeMessage: null,
          retryable: true
        };
      },
      retryDelayMs: () => 2_000
    });

    await expect(runtime.runOne("first_layer", new AbortController().signal))
      .resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      retryable: true,
      nextEligibleAt: null
    }));
  });

  it("keeps manual retry without scheduling a permanent provider failure", async () => {
    const fail = vi.fn(async () => "error" as const);
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() { return work; },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        fail,
        async recoverExpired() { return 0; }
      },
      handlers: {
        async first_layer() { throw new Error("permanent provider failure"); }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return {
          code: "semantic_generation_request_rejected",
          safeMessage: null,
          retryable: true,
          automaticRetry: false
        };
      },
      retryDelayMs: () => 2_000
    });

    await expect(runtime.runOne("first_layer", new AbortController().signal))
      .resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      retryable: true,
      nextEligibleAt: null
    }));
  });

  it("defers generation capacity saturation without consuming a failure", async () => {
    const fail = vi.fn(async () => "error" as const);
    const defer = vi.fn(async () => true);
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() { return work; },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        fail,
        defer,
        async recoverExpired() { return 0; }
      },
      handlers: {
        async first_layer() {
          throw Object.assign(new Error("Generation capacity is saturated"), {
            code: "GENERATION_WAITER_LIMIT_EXCEEDED"
          });
        }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return {
          code: "GENERATION_WAITER_LIMIT_EXCEEDED",
          safeMessage: null,
          retryable: true
        };
      }
    });

    await expect(runtime.runOne("first_layer", new AbortController().signal))
      .resolves.toBe(true);
    expect(defer).toHaveBeenCalledWith({
      publicId: "work-1",
      workerId: "worker-1",
      now: "2026-08-15T00:00:01.000Z",
      nextEligibleAt: "2026-08-15T00:00:01.250Z"
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it("defers an activation rebase without returning to knowledge projection", async () => {
    const fail = vi.fn(async () => "error" as const);
    const defer = vi.fn(async () => true);
    const runtime = createDocumentFixedDagRuntime({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      scheduler: {
        async claimOne() {
          return { ...work, kind: "activate", resourceLane: "activation" };
        },
        release() {}
      },
      work: {
        async complete() { return true; },
        async heartbeat() { return true; },
        fail,
        defer,
        async recoverExpired() { return 0; }
      },
      handlers: {
        async activate() {
          throw Object.assign(new Error("Activation owner snapshot changed"), {
            code: "document_activation_rebase_required"
          });
        }
      },
      now: () => "2026-08-15T00:00:01.000Z",
      wait: async () => undefined,
      classifyError() {
        return {
          code: "document_activation_rebase_required",
          safeMessage: null,
          retryable: true
        };
      }
    });

    await expect(runtime.runOne("activate", new AbortController().signal))
      .resolves.toBe(true);
    expect(defer).toHaveBeenCalledWith({
      publicId: "work-1",
      workerId: "worker-1",
      now: "2026-08-15T00:00:01.000Z",
      nextEligibleAt: "2026-08-15T00:00:01.250Z"
    });
    expect(fail).not.toHaveBeenCalled();
  });

});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}
