import { describe, expect, it, vi } from "vitest";
import type { ProjectionCompactionJob } from "../src/application/ports/projection-compaction-repository.js";
import { runProjectionCompactionSlice } from "../src/maintenance/projection-compaction.js";
import { createProcessResourceBudgets } from "../src/runtime/resource-budget.js";

describe("projection compaction", () => {
  it("materializes bounded pages and atomically replaces one active lineage", async () => {
    const job = createJob();
    const activate = vi.fn().mockResolvedValue("completed");
    const listActiveRecords = vi.fn(async ({ afterRecordId }) => {
      if (afterRecordId === null) {
        return [
          { recordId: "a", payload: { id: "a" } },
          { recordId: "b", payload: { id: "b" } }
        ];
      }
      if (afterRecordId === "b") return [{ recordId: "c", payload: { id: "c" } }];
      return [];
    });
    let writeIndex = 0;
    const result = await runProjectionCompactionSlice({
      repository: {
        discoverCandidates: vi.fn().mockResolvedValue(1),
        claim: vi.fn().mockResolvedValue([job]),
        listActiveRecords,
        heartbeat: vi.fn().mockResolvedValue(true),
        activateCompactedSegments: activate,
        fail: vi.fn()
      },
      immutableObjects: {
        write: vi.fn(async ({ body }) => {
          writeIndex += 1;
          return {
            checksumSha256: String(writeIndex).padStart(64, "0"),
            formatVersion: 2,
            objectKey: `objects/${writeIndex}`,
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength(String(body)),
            createdAt: "2026-07-20T00:00:00.000Z",
            verifiedAt: "2026-07-20T00:00:00.000Z",
            reused: false
          };
        })
      },
      budget: budgets().compaction,
      workerId: "maintenance-worker",
      concurrency: 1,
      partitionScanLimit: 100,
      recordPageSize: 2,
      maxAttempts: 5,
      retryDelayMs: 1_000,
      lockTtlSeconds: 60,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(result).toEqual({
      discovered: 1,
      claimed: 1,
      completed: 1,
      superseded: 0,
      failed: 0
    });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      job,
      segments: [
        expect.objectContaining({ segmentKind: "compacted", entryCount: 2 }),
        expect.objectContaining({ segmentKind: "compacted", entryCount: 1 })
      ]
    }));
  });

  it("requeues a failed compaction without exposing the error body", async () => {
    const fail = vi.fn().mockResolvedValue("pending");
    const result = await runProjectionCompactionSlice({
      repository: {
        discoverCandidates: vi.fn().mockResolvedValue(0),
        claim: vi.fn().mockResolvedValue([createJob()]),
        listActiveRecords: vi.fn().mockRejectedValue(new Error("secret object error")),
        heartbeat: vi.fn(),
        activateCompactedSegments: vi.fn(),
        fail
      },
      immutableObjects: { write: vi.fn() },
      budget: budgets().compaction,
      workerId: "maintenance-worker",
      concurrency: 1,
      partitionScanLimit: 100,
      recordPageSize: 100,
      maxAttempts: 5,
      retryDelayMs: 1_000,
      lockTtlSeconds: 60,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(result.failed).toBe(1);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      code: "PROJECTION_COMPACTION_FAILED"
    }));
    expect(JSON.stringify(fail.mock.calls)).not.toContain("secret object error");
  });
});

function createJob(): ProjectionCompactionJob {
  return {
    id: "projection-compaction-1",
    knowledgeBaseId: "kb-1",
    projectionKind: "search",
    logicalPartition: "search/v1/0001",
    activeGenerationId: "generation-1",
    expectedSegmentIds: ["segment-base", "segment-delta"],
    reasonCodes: ["depth"],
    attemptCount: 1,
    maxAttempts: 5,
    leaseToken: "lease-1"
  };
}

function budgets() {
  return createProcessResourceBudgets({
    model: 1,
    sourceObjectRead: 1,
    generatedObjectWrite: 1,
    graphQuery: 1,
    databaseMutation: 1,
    directory: 1,
    projectionPartition: 1,
    generationAssembly: 1,
    migrationBackfill: 1,
    compaction: 1
  });
}
