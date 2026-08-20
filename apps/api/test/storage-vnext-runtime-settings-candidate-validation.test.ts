import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type ValidationIssue = { field: string; message: string };
type CandidateValidator = (input: {
  value: unknown;
  capacity: Record<string, number>;
  backendLimits: Record<string, number>;
}) => ValidationIssue[];

let validateCandidate: CandidateValidator | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/runtime-settings/candidate-validation.ts"
  );
  const loaded = await import(
    /* @vite-ignore */ pathToFileURL(modulePath).href
  ).catch(() => ({})) as Record<string, unknown>;
  validateCandidate = loaded.validateStorageVnextRuntimeSettingsCandidate as
    CandidateValidator | undefined;
});

describe("storage vNext complete runtime settings candidate validation", () => {
  it("accepts one coherent complete candidate", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    expect(validateCandidate(candidate())).toEqual([]);
  });

  it("rejects unsafe numeric bounds", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({ search: { taskPollIntervalMs: 0 } });
    expect(validateCandidate(input)).toContainEqual(expect.objectContaining({
      field: "search.taskPollIntervalMs"
    }));
  });

  it("does not reject search concurrency against a static default capacity", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({ search: { maxInFlightTasks: 128 } });
    expect(validateCandidate(input)).toEqual([]);
  });

  it("rejects removed retention fields", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({
      worker: {
        failedJobRetentionDays: 7,
        deadLetterJobRetentionDays: 5
      }
    });
    expect(validateCandidate(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "worker.failedJobRetentionDays" }),
      expect.objectContaining({ field: "worker.deadLetterJobRetentionDays" })
    ]));
  });

  it("rejects the removed cleanup cadence setting", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({
      maintenance: { scanIntervalSeconds: 86_400 }
    });
    expect(validateCandidate(input)).toContainEqual(expect.objectContaining({
      field: "maintenance.scanIntervalSeconds"
    }));
  });

  it("rejects object fan-out above active and candidate budgets", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate();
    input.backendLimits.maximumActiveObjectsPerSourceFile = 6;
    input.backendLimits.maximumCandidateObjectRatioPermille = 201;
    expect(validateCandidate(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "maximumActiveObjectsPerSourceFile" }),
      expect.objectContaining({ field: "maximumCandidateObjectRatioPermille" })
    ]));
  });

  it("rejects unified search batches above document and compressed-byte bounds", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({
      search: {
        indexBatchDocumentCount: 10_001,
        indexBatchCompressedBytes: 33_554_433
      }
    });
    expect(validateCandidate(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "search.indexBatchDocumentCount" }),
      expect.objectContaining({ field: "search.indexBatchCompressedBytes" })
    ]));
  });

  it("rejects empty, malformed, and partial settings documents", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    for (const value of [null, {}, { worker: [] }, { search: "invalid" }]) {
      expect(validateCandidate({
        ...candidate(),
        value
      })).toContainEqual(expect.objectContaining({ field: "settings" }));
    }
  });

  it("rejects removed fields instead of reading hidden legacy defaults", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({
      worker: { generationBatchSize: 50 },
      publication: { generationRetentionDays: 7 },
      maintenance: { migrationBackfillConcurrency: 2 }
    });
    expect(validateCandidate(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "worker.generationBatchSize" }),
      expect.objectContaining({ field: "publication" }),
      expect.objectContaining({ field: "maintenance.migrationBackfillConcurrency" })
    ]));
  });
});

function candidate(overrides: Record<string, unknown> = {}) {
  const value = merge({
    worker: {
      sourceFileConcurrency: 1,
      sourceObjectReadConcurrency: 1,
      claimBatchSize: 1,
      pollIntervalMs: 500,
      lockTtlSeconds: 30_000,
      heartbeatIntervalMs: 10_000,
      jobMaxAttempts: 3,
      jobRetryDelayMs: 2_000,
      completedJobRetentionDays: 7
    },
    generated: {
      directoryIndexMaxEntries: 500,
      directoryIndexMaxBytes: 1_048_576,
      rootSummaryLimit: 100,
      okfLogMaxEntries: 1_000,
      okfLogMaxBytes: 1_048_576
    },
    graph: {
      candidateLimit: 100,
      acceptedEdgeLimit: 50,
      searchDefaultDepth: 1,
      searchMaxDepth: 2,
      searchDefaultFanout: 10,
      searchMaxFanout: 50,
      shardSize: 500,
      genericPhraseThreshold: 10
    },
    maintenance: {
      reconciliationEnabled: true,
      scanBatchSize: 500,
      maxAttempts: 5,
      retryDelayMs: 30_000,
      hardDeleteConcurrency: 1,
      hardDeleteDatabaseBatchSize: 1_000,
      hardDeleteObjectBatchSize: 1_000,
      hardDeleteMaxAttempts: 3,
      hardDeleteRetryDelayMs: 60_000,
      hardDeleteFailedRetentionDays: 30
    },
    semantic: {
      maximumChunkCharacters: 16_000,
      maximumChunks: 32,
      maximumEvidenceTargets: 64,
      graphRagAdapterTimeoutMs: 30_000,
      searchLaneCutoffMs: 1_000,
      queryEmbeddingConcurrency: 4,
      queryEmbeddingCacheEntries: 1_000
    },
    search: {
      requestTimeoutMs: 3_000,
      maxInFlightTasks: 3,
      indexBatchDocumentCount: 500,
      indexBatchCompressedBytes: 65_536,
      taskPollIntervalMs: 500,
      taskTimeoutMs: 600_000,
      cleanupBatchSize: 1_000
    },
    activeModel: { suggestionConcurrency: 1 }
  }, overrides);
  return {
    value,
    capacity: {
      databaseConnections: 4,
      objectStoreRequests: 4,
      cpuConcurrency: 4
    },
    backendLimits: {
      maximumCleanupLagSeconds: 21_600,
      maximumActiveObjectsPerSourceFile: 5,
      maximumCandidateObjectRatioPermille: 200,
      maximumInternalShardRecords: 5_000,
      maximumInternalShardBytes: 8_388_608
    }
  };
}

function merge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isRecord(result[key]) && isRecord(value)
      ? merge(result[key], value)
      : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
