import { describe, expect, it } from "vitest";
import type {
  IncrementalStatisticsReconciliationClaim,
  IncrementalStatisticsRepository
} from "../src/application/ports/incremental-statistics-repository.js";
import { runIncrementalStatisticsReconciliationSlice } from "../src/maintenance/incremental-statistics-reconciliation.js";

describe("incremental statistics reconciliation", () => {
  it("reconciles at most one claimed knowledge base", async () => {
    const repository = fakeRepository();
    const result = await runIncrementalStatisticsReconciliationSlice({
      repository,
      workerId: "maintenance-a",
      leaseToken: "lease-a",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:01:00.000Z",
      reconciledBefore: "2026-07-19T23:00:00.000Z"
    });
    expect(result).toEqual({ claimed: true, changed: true, failed: false });
    expect(repository.reconcileCount).toBe(1);
  });

  it("releases a claimed lease after a reconciliation failure", async () => {
    const repository = fakeRepository();
    repository.failReconciliation = true;
    const result = await runIncrementalStatisticsReconciliationSlice({
      repository,
      workerId: "maintenance-a",
      leaseToken: "lease-a",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:01:00.000Z",
      reconciledBefore: "2026-07-19T23:00:00.000Z"
    });
    expect(result).toEqual({ claimed: true, changed: false, failed: true });
    expect(repository.released).toBe(true);
  });
});

type FakeRepository = IncrementalStatisticsRepository & {
  reconcileCount: number;
  failReconciliation: boolean;
  released: boolean;
};

function fakeRepository(): FakeRepository {
  const claim: IncrementalStatisticsReconciliationClaim = {
    knowledgeBaseId: "kb-statistics",
    workerId: "maintenance-a",
    leaseToken: "lease-a"
  };
  return {
    reconcileCount: 0,
    failReconciliation: false,
    released: false,
    async claimForReconciliation() {
      return claim;
    },
    async reconcile() {
      this.reconcileCount += 1;
      if (this.failReconciliation) throw new Error("reconciliation failed");
      return { changed: true };
    },
    async release() {
      this.released = true;
    }
  };
}
