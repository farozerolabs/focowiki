import { describe, expect, it, vi } from "vitest";
import { createDocumentPublicationScopeRuntime } from
  "../src/document-indexing/application/document-publication-scope-runtime.js";
import { documentLeaseGeneration } from
  "../src/document-indexing/domain/document-publication-identifiers.js";

describe("document publication scope runtime", () => {
  it("refills a released scope slot without waiting for sibling completion",
    async () => {
      const claims = ["scope-1", "scope-2", "scope-3"];
      const releases = new Map<string, () => void>();
      const started: string[] = [];
      const runtime = createDocumentPublicationScopeRuntime({
        workerId: "worker-1",
        leaseDurationMs: 1_000,
        maximumConcurrency: 2,
        repository: {
          claim: vi.fn(async ({ limit }: { limit: number }) =>
            claims.splice(0, limit).map((publicId) => ({
              publicId,
              leaseGeneration: documentLeaseGeneration(1)
            }))),
          fail: vi.fn(),
          recoverExpired: vi.fn(async () => 0)
        },
        execute: vi.fn(async ({ claim }: { claim: { publicId: string } }) => {
          started.push(claim.publicId);
          await new Promise<void>((resolve) => releases.set(claim.publicId, resolve));
        }),
        now: () => "2026-08-21T15:00:00.000Z",
        wait: async () => undefined,
        classifyError: () => ({ code: "unknown", recoveryAction: "terminal" })
      });
      const controller = new AbortController();
      const running = runtime.run(controller.signal);
      await vi.waitFor(() => expect(started).toEqual(["scope-1", "scope-2"]));
      releases.get("scope-1")!();
      await vi.waitFor(() => expect(started).toEqual([
        "scope-1", "scope-2", "scope-3"
      ]));
      controller.abort();
      releases.get("scope-2")!();
      releases.get("scope-3")!();
      await running;
    });

  it.each([
    ["projection_scope_page_conflict", "quarantine"],
    ["publication_generation_stale_base", "recompute_scope"],
    ["scope_generation_lease_lost", "inspect_or_reclaim"],
    ["provider_unavailable", "retry_provider"]
  ] as const)("persists the %s recovery action without a retryable fallback",
    async (code, recoveryAction) => {
      const failRequests: Record<string, unknown>[] = [];
      const fail = vi.fn(async (request: Record<string, unknown>) => {
        failRequests.push(request);
        return "waiting" as const;
      });
      const runtime = createDocumentPublicationScopeRuntime({
        workerId: "worker-recovery",
        leaseDurationMs: 1_000,
        maximumConcurrency: 1,
        repository: {
          claim: vi.fn()
            .mockResolvedValueOnce([{
              publicId: "scope-recovery",
              leaseGeneration: documentLeaseGeneration(3)
            }])
            .mockResolvedValue([]),
          fail,
          recoverExpired: vi.fn(async () => 0)
        },
        execute: vi.fn(async () => {
          throw Object.assign(new Error(code), { code });
        }),
        now: () => "2026-08-21T15:00:00.000Z",
        wait: async (_milliseconds, signal) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          void signal;
        },
        classifyError: () => ({ code, recoveryAction })
      });
      const controller = new AbortController();
      const running = runtime.run(controller.signal);
      await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
      controller.abort();
      await running;

      expect(fail).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: code,
        recoveryAction
      }));
      expect(failRequests[0]).not.toHaveProperty("retryable");
    });

  it("reduces claim pressure after database resource exhaustion", async () => {
    const claimLimits: number[] = [];
    let claimRound = 0;
    const runtime = createDocumentPublicationScopeRuntime({
      workerId: "worker-resource-pressure",
      leaseDurationMs: 1_000,
      maximumConcurrency: 8,
      repository: {
        claim: vi.fn(async ({ limit }: { limit: number }) => {
          claimLimits.push(limit);
          claimRound += 1;
          if (claimRound === 1) return Array.from({ length: limit }, (_, index) => ({
            publicId: `scope-pressure-${index}`,
            leaseGeneration: documentLeaseGeneration(1)
          }));
          return [];
        }),
        fail: vi.fn(async () => "waiting" as const),
        recoverExpired: vi.fn(async () => 0)
      },
      execute: vi.fn(async () => {
        throw Object.assign(new Error("database resource exhausted"), {
          code: "53100"
        });
      }),
      now: () => "2026-08-23T10:00:00.000Z",
      wait: async (_milliseconds, signal) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        void signal;
      },
      classifyError: () => ({
        code: "53100",
        recoveryAction: "retry_infrastructure"
      })
    });
    const controller = new AbortController();
    const running = runtime.run(controller.signal);
    await vi.waitFor(() => expect(claimLimits.length).toBeGreaterThan(1));
    controller.abort();
    await running;

    expect(claimLimits[0]).toBe(8);
    expect(claimLimits.at(-1)).toBe(1);
  });
});
