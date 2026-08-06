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

  it("rejects aggregate resource demand before persistence", () => {
    expect(validateCandidate).toBeTypeOf("function");
    if (!validateCandidate) return;
    const input = candidate({ search: { maxInFlightTasks: 9 } });
    expect(validateCandidate(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "searchCapacity" }),
      expect.objectContaining({ field: "memoryCapacity" })
    ]));
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
      expect.objectContaining({ field: "publication.generationRetentionDays" }),
      expect.objectContaining({ field: "maintenance.migrationBackfillConcurrency" })
    ]));
  });
});

function candidate(overrides: Record<string, unknown> = {}) {
  const value = merge({
    worker: {
      sourceFileConcurrency: 1,
      sourceObjectReadConcurrency: 1,
      hardDeleteConcurrency: 1,
      completedJobRetentionDays: 7
    },
    publication: {
      roleConcurrency: 1,
      generatedObjectWriteConcurrency: 1
    },
    graph: {},
    maintenance: {
      knowledgeBaseMaintenanceConcurrency: 1,
      scanBatchSize: 500,
      deletionBatchSize: 100,
      quarantineGracePeriodSeconds: 86_400,
      maxAttempts: 5,
      retryDelayMs: 30_000,
      projectionRepairConcurrency: 4,
      projectionRepairDatabaseBatchSize: 2_000,
      projectionRepairObjectWriteConcurrency: 8,
      lexicalRebuildConcurrency: 4,
      lexicalRebuildSourceReadConcurrency: 2,
      lexicalRebuildMaxInFlightSourceBytes: 67_108_864
    },
    search: {
      maxInFlightTasks: 3,
      indexBatchDocumentCount: 500,
      indexBatchCompressedBytes: 65_536,
      taskPollIntervalMs: 500,
      taskTimeoutMs: 600_000,
      cleanupBatchSize: 1_000,
      stagingRetentionHours: 24
    },
    activeModel: { suggestionConcurrency: 1 }
  }, overrides);
  return {
    value,
    capacity: {
      databaseConnections: 4,
      searchTasks: 3,
      objectStoreRequests: 11,
      memoryBytes: 67_305_472,
      cpuConcurrency: 9
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
