import type { FileGraphRepository } from "../db/admin-repositories.js";
import { buildGraphTermDocument } from "../graph/graph-term-document.js";
import type {
  OptimizationMigrationClaim,
  OptimizationMigrationRepository
} from "../application/ports/optimization-migration-repository.js";
import { mapWithConcurrency } from "../runtime/bounded.js";
import type { StorageAdapter } from "../storage/s3.js";

export type OptimizationMigrationSliceResult = {
  knowledgeBaseId: string | null;
  phase: OptimizationMigrationClaim["phase"] | "idle";
  processed: number;
  completed: boolean;
  failed: boolean;
  errorCode: string | null;
};

export async function runOptimizationMigrationSlice(input: {
  repository: OptimizationMigrationRepository;
  storage: Pick<StorageAdapter, "getObjectText" | "headObjectMetadata">;
  graph: Pick<FileGraphRepository, "upsertGraphTermDocument">;
  workerId: string;
  leaseToken: string;
  now: string;
  leaseExpiresAt: string;
  batchSize: number;
  sourceReadConcurrency: number;
}): Promise<OptimizationMigrationSliceResult> {
  assertPositiveInteger(input.batchSize, "Migration batch size");
  assertPositiveInteger(input.sourceReadConcurrency, "Migration source read concurrency");
  const claim = await input.repository.claimNext({
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    now: input.now,
    leaseExpiresAt: input.leaseExpiresAt
  });
  if (!claim) return idleResult();

  try {
    if (claim.phase === "source_terms") return await processSourceTerms(input, claim);
    if (claim.phase === "projection_segments") return await processLegacySegments(input, claim);
    if (claim.phase === "object_validation") return await validateReferencedObjects(input, claim);
    return await verifyAndActivate(input, claim);
  } catch (error) {
    const failure = safeMigrationFailure(error);
    await input.repository.fail({
      knowledgeBaseId: claim.knowledgeBaseId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      errorCode: failure.code,
      errorMessage: failure.message,
      failedAt: input.now
    });
    return {
      knowledgeBaseId: claim.knowledgeBaseId,
      phase: claim.phase,
      processed: 0,
      completed: false,
      failed: true,
      errorCode: failure.code
    };
  }
}

async function processSourceTerms(
  input: Parameters<typeof runOptimizationMigrationSlice>[0],
  claim: OptimizationMigrationClaim
): Promise<OptimizationMigrationSliceResult> {
  const sources = await input.repository.listSourceBatch({
    knowledgeBaseId: claim.knowledgeBaseId,
    afterSourceFileId: claim.highWaterSourceFileId,
    limit: input.batchSize
  });
  if (sources.length === 0) {
    await advance(input, claim, "projection_segments");
    return success(claim, 0, false);
  }

  await mapWithConcurrency(sources, input.sourceReadConcurrency, async (source) => {
    const body = await input.storage.getObjectText(source.objectKey);
    if (body === null) {
      throw new OptimizationMigrationError(
        "MIGRATION_SOURCE_OBJECT_MISSING",
        "A referenced source object is unavailable"
      );
    }
    await input.graph.upsertGraphTermDocument({
      knowledgeBaseId: claim.knowledgeBaseId,
      document: buildGraphTermDocument({
        sourceFileId: source.sourceFileId,
        sourceRevisionId: source.sourceRevisionId,
        title: source.title,
        body,
        headings: source.headings,
        phrases: source.phrases,
        entities: source.entities,
        explicitReferences: source.explicitReferences,
        supplementalTerms: source.supplementalTerms
      })
    });
  });
  const highWater = sources.at(-1)?.sourceFileId;
  if (!highWater) throw new Error("Migration source page has no high-water identity");
  await input.repository.recordSourceProgress({
    ...owned(input, claim),
    highWaterSourceFileId: highWater,
    updatedAt: input.now
  });
  return success(claim, sources.length, false);
}

async function processLegacySegments(
  input: Parameters<typeof runOptimizationMigrationSlice>[0],
  claim: OptimizationMigrationClaim
): Promise<OptimizationMigrationSliceResult> {
  const items = await input.repository.listLegacyProjectionBatch({
    knowledgeBaseId: claim.knowledgeBaseId,
    generationId: claim.priorActiveGenerationId,
    afterProjectionRecordId: claim.highWaterProjectionRecordId,
    limit: input.batchSize
  });
  if (items.length === 0) {
    await advance(input, claim, "object_validation");
    return success(claim, 0, false);
  }
  await input.repository.registerLegacyBaseSegments({
    ...owned(input, claim),
    items,
    updatedAt: input.now
  });
  const highWater = items.at(-1)?.shardId;
  if (!highWater) throw new Error("Legacy projection page has no high-water identity");
  await input.repository.recordProjectionProgress({
    ...owned(input, claim),
    highWaterProjectionRecordId: highWater,
    updatedAt: input.now
  });
  return success(claim, items.length, false);
}

async function validateReferencedObjects(
  input: Parameters<typeof runOptimizationMigrationSlice>[0],
  claim: OptimizationMigrationClaim
): Promise<OptimizationMigrationSliceResult> {
  const objects = await input.repository.listReferencedObjectBatch({
    knowledgeBaseId: claim.knowledgeBaseId,
    afterObjectIdentity: claim.highWaterObjectIdentity,
    limit: input.batchSize
  });
  if (objects.length === 0) {
    await advance(input, claim, "verifying");
    return success(claim, 0, false);
  }
  if (objects.some((object) => !object.objectPresent)) {
    throw new OptimizationMigrationError(
      "MIGRATION_REFERENCED_OBJECT_MISSING",
      "A database-referenced generated object is unavailable"
    );
  }
  if (input.storage.headObjectMetadata) {
    const observations = await mapWithConcurrency(
      objects,
      input.sourceReadConcurrency,
      async (object) => input.storage.headObjectMetadata?.(object.objectKey) ?? null
    );
    if (observations.some((observation) => observation === null)) {
      throw new OptimizationMigrationError(
        "MIGRATION_STORAGE_OBJECT_MISSING",
        "A database-referenced generated object is missing from storage"
      );
    }
  }
  const highWater = objects.at(-1)?.identity;
  if (!highWater) throw new Error("Migration object page has no high-water identity");
  await input.repository.recordObjectProgress({
    ...owned(input, claim),
    highWaterObjectIdentity: highWater,
    updatedAt: input.now
  });
  return success(claim, objects.length, false);
}

async function verifyAndActivate(
  input: Parameters<typeof runOptimizationMigrationSlice>[0],
  claim: OptimizationMigrationClaim
): Promise<OptimizationMigrationSliceResult> {
  await input.repository.reconcileStats({ ...owned(input, claim), updatedAt: input.now });
  const parity = await input.repository.verifyParity(owned(input, claim));
  if (!parity.passed) {
    throw new OptimizationMigrationError(
      "MIGRATION_PARITY_FAILED",
      "Optimized projection parity validation failed"
    );
  }
  await input.repository.activate({
    ...owned(input, claim),
    parityEvidence: parity.evidence,
    activatedAt: input.now
  });
  return { ...success(claim, 0, true), completed: true };
}

async function advance(
  input: Parameters<typeof runOptimizationMigrationSlice>[0],
  claim: OptimizationMigrationClaim,
  phase: OptimizationMigrationClaim["phase"]
): Promise<void> {
  await input.repository.advancePhase({
    ...owned(input, claim),
    phase,
    updatedAt: input.now
  });
}

function owned(
  input: Pick<Parameters<typeof runOptimizationMigrationSlice>[0], "workerId" | "leaseToken">,
  claim: OptimizationMigrationClaim
) {
  return {
    knowledgeBaseId: claim.knowledgeBaseId,
    workerId: input.workerId,
    leaseToken: input.leaseToken
  };
}

function success(
  claim: OptimizationMigrationClaim,
  processed: number,
  completed: boolean
): OptimizationMigrationSliceResult {
  return {
    knowledgeBaseId: claim.knowledgeBaseId,
    phase: claim.phase,
    processed,
    completed,
    failed: false,
    errorCode: null
  };
}

function idleResult(): OptimizationMigrationSliceResult {
  return {
    knowledgeBaseId: null,
    phase: "idle",
    processed: 0,
    completed: false,
    failed: false,
    errorCode: null
  };
}

class OptimizationMigrationError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function safeMigrationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof OptimizationMigrationError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "MIGRATION_SLICE_FAILED",
    message: "Knowledge base optimization migration failed"
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
