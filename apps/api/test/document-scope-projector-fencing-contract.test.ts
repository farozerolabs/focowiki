import { describe, expect, it, vi } from "vitest";
import { createDocumentScopeProjectorRuntime } from
  "../src/document-indexing/application/document-scope-projector-runtime.js";

const ZERO_STORAGE = {
  put: 0,
  head: 0,
  verification: 0,
  attemptedBytes: 0,
  retries: 0,
  latencyMilliseconds: 0
};

describe("document scope projector fencing contract", () => {
  it("renews a durable lease while a scope render is in progress", async () => {
    const heartbeat = vi.fn(async () => true);
    const runtime = runtimeFor({
      scopes: ({
        async claim() { return [claim("scope-heartbeat", 1)]; },
        heartbeat,
        async fail() { return "error" as const; },
        async recoverExpired() { return 0; }
      }) as never
    });

    await runtime.runOne(new AbortController().signal);

    expect(heartbeat).toHaveBeenCalled();
  });

  it("does not persist a late render after its durable lease expired", async () => {
    let now = "2026-08-21T09:00:00.000Z";
    const persist = vi.fn(async () => undefined);
    const runtime = runtimeFor({
      now: () => now,
      persist,
      scopes: ({
        async claim() {
          return [{
            ...claim("scope-expired", 4),
            leaseGeneration: 4,
            leaseExpiresAt: "2026-08-21T09:00:30.000Z"
          }];
        },
        async heartbeat() { return false; },
        async fail() { return null; },
        async recoverExpired() { return 0; }
      }) as never,
      async render() {
        now = "2026-08-21T09:00:31.000Z";
        return rendered();
      }
    });

    await runtime.runOne(new AbortController().signal);

    expect(persist).not.toHaveBeenCalled();
  });

  it("fences the first replica after a second lease generation is claimed", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let activeGeneration = 1;
    const persistedBy: string[] = [];
    const first = runtimeFor({
      workerId: "worker-a",
      scopes: scopePort(claim("scope-shared", 1, 1), () =>
        activeGeneration === 1),
      async render() {
        markFirstStarted();
        await firstGate;
        return rendered("a");
      },
      async persist() { persistedBy.push("worker-a"); }
    });
    const second = runtimeFor({
      workerId: "worker-b",
      scopes: scopePort(claim("scope-shared", 1, 2), () =>
        activeGeneration === 2),
      async render() { return rendered("b"); },
      async persist() { persistedBy.push("worker-b"); }
    });

    const staleExecution = first.runOne(new AbortController().signal);
    await firstStarted;
    activeGeneration = 2;
    await second.runOne(new AbortController().signal);
    releaseFirst();
    await staleExecution;

    expect(persistedBy).toEqual(["worker-b"]);
  });
});

function runtimeFor(overrides: Record<string, unknown>) {
  return createDocumentScopeProjectorRuntime({
    workerId: "worker-1",
    leaseDurationMs: 30_000,
    scopes: scopePort(claim("scope-default", 1, 1)),
    async commit() {
      return { state: "completed" as const, readyDocumentJobPublicIds: [] };
    },
    async render() { return rendered(); },
    async persist() {},
    async finalize() { return 0; },
    now: () => "2026-08-21T09:00:00.000Z",
    wait: async () => undefined,
    classifyError: () => ({ code: "LEASE_LOST", retryable: true }),
    ...overrides
  } as never);
}

function scopePort(
  scope: ReturnType<typeof claim>,
  ownsLease: () => boolean = () => true
) {
  let claimed = false;
  return ({
    async claim() {
      if (claimed) return [];
      claimed = true;
      return [scope];
    },
    async heartbeat() { return ownsLease(); },
    async fail() { return null; },
    async recoverExpired() { return 0; }
  }) as never;
}

function claim(publicId: string, renderedSequence: number, leaseGeneration = 1) {
  return {
    publicId,
    knowledgeBaseId: "kb-1",
    kind: "root" as const,
    key: "index",
    requiredSequence: renderedSequence,
    renderedSequence,
    leaseGeneration,
    leaseExpiresAt: "2026-08-21T09:00:30.000Z"
  };
}

function rendered(seed = "f") {
  return {
    outputFingerprintSha256: seed.repeat(64),
    storageRequests: ZERO_STORAGE
  };
}
