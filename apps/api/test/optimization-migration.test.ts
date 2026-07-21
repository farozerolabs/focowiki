import { describe, expect, it } from "vitest";
import type {
  LegacyProjectionSegment,
  OptimizationMigrationClaim,
  OptimizationMigrationRepository,
  OptimizationMigrationSource,
  ReferencedMigrationObject
} from "../src/application/ports/optimization-migration-repository.js";
import { runOptimizationMigrationSlice } from "../src/maintenance/optimization-migration.js";

describe("optimization migration", () => {
  it("backfills one bounded source page and advances only after the page is durable", async () => {
    const repository = createFakeRepository({ phase: "source_terms" });
    repository.sources = [
      source("source-file-a", "revision-a", "objects/a.md"),
      source("source-file-b", "revision-b", "objects/b.md")
    ];
    const documents: string[] = [];

    const result = await runOptimizationMigrationSlice({
      repository,
      storage: {
        async getObjectText(key) {
          return `# ${key}\n\nShared body evidence.`;
        }
      },
      graph: {
        async upsertGraphTermDocument(input) {
          documents.push(input.document.sourceFileId);
        }
      },
      workerId: "migration-worker-a",
      leaseToken: "lease-a",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:01:00.000Z",
      batchSize: 2,
      sourceReadConcurrency: 2
    });

    expect(result).toMatchObject({ phase: "source_terms", processed: 2 });
    expect(documents.sort()).toEqual(["source-file-a", "source-file-b"]);
    expect(repository.sourceHighWater).toBe("source-file-b");
    expect(repository.activeGenerationChanged).toBe(false);
  });

  it("reuses legacy shards, validates referenced objects, and cuts over after parity", async () => {
    const repository = createFakeRepository({ phase: "projection_segments" });
    repository.legacyProjections = [{
      shardId: "projection-shard-a",
      knowledgeBaseId: "kb-migration",
      generationId: "generation-active",
      projectionKind: "search",
      logicalPartition: "search/v2/0001",
      formatVersion: 2,
      checksumSha256: "a".repeat(64),
      objectKey: "generated/search-a.json",
      logicalPath: "_index/search/search-a.json",
      entryCount: 12,
      encodedBytes: 2048
    }];

    const projection = await runSlice(repository);
    expect(projection).toMatchObject({ phase: "projection_segments", processed: 1 });
    expect(repository.registeredShardIds).toEqual(["projection-shard-a"]);

    repository.claim.phase = "object_validation";
    repository.referencedObjects = [{
      identity: "projection_shard\u001fsearch/v2/0001",
      checksumSha256: "a".repeat(64),
      formatVersion: 2,
      objectKey: "generated/search-a.json",
      objectPresent: true
    }];
    expect(await runSlice(repository)).toMatchObject({ phase: "object_validation", processed: 1 });

    repository.claim.phase = "verifying";
    const verification = await runSlice(repository);
    expect(verification).toMatchObject({ phase: "verifying", completed: true });
    expect(repository.statsReconciled).toBe(true);
    expect(repository.activeGenerationChanged).toBe(true);
  });

  it("records a safe failure and preserves active reads when a source object is missing", async () => {
    const repository = createFakeRepository({ phase: "source_terms" });
    repository.sources = [source("source-file-a", "revision-a", "objects/missing.md")];

    const result = await runOptimizationMigrationSlice({
      repository,
      storage: { async getObjectText() { return null; } },
      graph: { async upsertGraphTermDocument() {} },
      workerId: "migration-worker-a",
      leaseToken: "lease-a",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:01:00.000Z",
      batchSize: 10,
      sourceReadConcurrency: 2
    });

    expect(result).toMatchObject({ failed: true, errorCode: "MIGRATION_SOURCE_OBJECT_MISSING" });
    expect(repository.failureCode).toBe("MIGRATION_SOURCE_OBJECT_MISSING");
    expect(repository.sourceHighWater).toBeNull();
    expect(repository.activeGenerationChanged).toBe(false);
  });

  it("rebases a changed active generation without consuming the failure budget", async () => {
    const repository = createFakeRepository({ phase: "verifying" });
    repository.activeGenerationDrifted = true;

    const result = await runSlice(repository);

    expect(result).toMatchObject({
      phase: "verifying",
      completed: false,
      failed: false,
      errorCode: null
    });
    expect(repository.rebaseCount).toBe(1);
    expect(repository.statsReconciled).toBe(false);
    expect(repository.activeGenerationChanged).toBe(false);
    expect(repository.failureCode).toBeNull();
  });

  it("rebases a generation that changes after parity verification", async () => {
    const repository = createFakeRepository({ phase: "verifying" });
    repository.activationResult = "rebased";

    const result = await runSlice(repository);

    expect(result).toMatchObject({
      phase: "verifying",
      completed: false,
      failed: false,
      errorCode: null
    });
    expect(repository.statsReconciled).toBe(true);
    expect(repository.activeGenerationChanged).toBe(false);
    expect(repository.failureCode).toBeNull();
  });

  it("reports unexpected internal failures to the runtime logger while keeping stored errors safe", async () => {
    const repository = createFakeRepository({ phase: "verifying" });
    repository.rebaseIfActiveGenerationChanged = async () => {
      throw new Error("database transaction failed");
    };
    const failures: Array<{ error: unknown; knowledgeBaseId: string; phase: string }> = [];

    const result = await runOptimizationMigrationSlice({
      repository,
      storage: { async getObjectText() { return "# Existing source"; } },
      graph: { async upsertGraphTermDocument() {} },
      workerId: "migration-worker-a",
      leaseToken: "lease-a",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:01:00.000Z",
      batchSize: 10,
      sourceReadConcurrency: 2,
      onUnexpectedError(error, context) {
        failures.push({ error, ...context });
      }
    });

    expect(result).toMatchObject({ failed: true, errorCode: "MIGRATION_SLICE_FAILED" });
    expect(repository.failureCode).toBe("MIGRATION_SLICE_FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      knowledgeBaseId: "kb-migration",
      phase: "verifying"
    });
    expect((failures[0]?.error as Error).message).toBe("database transaction failed");
  });
});

function source(sourceFileId: string, sourceRevisionId: string, objectKey: string) {
  return {
    sourceFileId,
    sourceRevisionId,
    objectKey,
    title: sourceFileId,
    headings: ["Overview"],
    phrases: ["shared body evidence"],
    entities: [],
    explicitReferences: [],
    supplementalTerms: ["migration"]
  };
}

async function runSlice(repository: ReturnType<typeof createFakeRepository>) {
  return runOptimizationMigrationSlice({
    repository,
    storage: { async getObjectText() { return "# Existing source"; } },
    graph: { async upsertGraphTermDocument() {} },
    workerId: "migration-worker-a",
    leaseToken: "lease-a",
    now: "2026-07-20T00:00:00.000Z",
    leaseExpiresAt: "2026-07-20T00:01:00.000Z",
    batchSize: 10,
    sourceReadConcurrency: 2
  });
}

type FakeOptimizationMigrationRepository = OptimizationMigrationRepository & {
  claim: OptimizationMigrationClaim;
  sources: OptimizationMigrationSource[];
  legacyProjections: LegacyProjectionSegment[];
  referencedObjects: ReferencedMigrationObject[];
  sourceHighWater: string | null;
  registeredShardIds: string[];
  statsReconciled: boolean;
  activeGenerationChanged: boolean;
  activeGenerationDrifted: boolean;
  activationResult: "activated" | "rebased";
  rebaseCount: number;
  failureCode: string | null;
};

function createFakeRepository(input: { phase: OptimizationMigrationClaim["phase"] }): FakeOptimizationMigrationRepository {
  const repository: FakeOptimizationMigrationRepository = {
    claim: {
      knowledgeBaseId: "kb-migration",
      state: "backfilling",
      phase: input.phase,
      highWaterSourceFileId: null,
      highWaterProjectionRecordId: null,
      highWaterObjectIdentity: null,
      priorActiveGenerationId: "generation-active",
      leaseOwner: "migration-worker-a",
      leaseToken: "lease-a"
    } satisfies OptimizationMigrationClaim,
    sources: [],
    legacyProjections: [],
    referencedObjects: [],
    sourceHighWater: null as string | null,
    registeredShardIds: [] as string[],
    statsReconciled: false,
    activeGenerationChanged: false,
    activeGenerationDrifted: false,
    activationResult: "activated",
    rebaseCount: 0,
    failureCode: null as string | null,
    async claimNext() { return this.claim; },
    async listSourceBatch() { return this.sources; },
    async recordSourceProgress(value: { highWaterSourceFileId: string }) {
      this.sourceHighWater = value.highWaterSourceFileId;
    },
    async listLegacyProjectionBatch() { return this.legacyProjections; },
    async registerLegacyBaseSegments(value: { items: Array<{ shardId: string }> }) {
      this.registeredShardIds.push(...value.items.map((item) => item.shardId));
    },
    async recordProjectionProgress() {},
    async listReferencedObjectBatch() { return this.referencedObjects; },
    async recordObjectProgress() {},
    async advancePhase(value: { phase: OptimizationMigrationClaim["phase"] }) {
      this.claim.phase = value.phase;
    },
    async rebaseIfActiveGenerationChanged() {
      if (!this.activeGenerationDrifted) return false;
      this.rebaseCount += 1;
      return true;
    },
    async reconcileStats() { this.statsReconciled = true; },
    async verifyParity() {
      return { passed: true, evidence: { mismatchCount: 0 } };
    },
    async activate() {
      if (this.activationResult === "activated") this.activeGenerationChanged = true;
      return this.activationResult;
    },
    async fail(value: { errorCode: string }) { this.failureCode = value.errorCode; }
  };
  return repository;
}
