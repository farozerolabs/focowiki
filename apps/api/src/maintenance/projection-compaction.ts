import { createHash } from "node:crypto";
import type {
  ProjectionCompactionJob,
  ProjectionCompactionRepository
} from "../application/ports/projection-compaction-repository.js";
import type { ProjectionSegment } from "../application/ports/projection-segment-repository.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";
import type { ImmutableObjectWriteResult } from "../publication/immutable-object-writer.js";
import { renderProjectionSegment } from "../publication/projection-segment-writer.js";

export const DEFAULT_PROJECTION_COMPACTION_LIMITS = {
  maxDepth: 8,
  maxEncodedBytes: 8 * 1024 * 1024,
  maxTombstoneRatio: 0.25,
  maxReadAmplification: 8
};

export async function runProjectionCompactionSlice(input: {
  repository: ProjectionCompactionRepository;
  immutableObjects: {
    write(object: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }): Promise<ImmutableObjectWriteResult>;
  };
  budget: ResourceBudget;
  workerId: string;
  concurrency: number;
  partitionScanLimit: number;
  recordPageSize: number;
  maxAttempts: number;
  retryDelayMs: number;
  lockTtlSeconds: number;
  now?: () => Date;
}): Promise<{
  discovered: number;
  claimed: number;
  completed: number;
  superseded: number;
  failed: number;
}> {
  assertPositiveInteger(input.concurrency, "concurrency");
  assertPositiveInteger(input.partitionScanLimit, "partitionScanLimit");
  assertPositiveInteger(input.recordPageSize, "recordPageSize");
  const now = input.now ?? (() => new Date());
  const discoveredAt = now();
  const discovered = await input.repository.discoverCandidates({
    limits: DEFAULT_PROJECTION_COMPACTION_LIMITS,
    partitionLimit: input.partitionScanLimit,
    maxAttempts: input.maxAttempts,
    discoveredAt: discoveredAt.toISOString()
  });
  const claimTime = now();
  const jobs = await input.repository.claim({
    workerId: input.workerId,
    limit: input.concurrency,
    now: claimTime.toISOString(),
    leaseExpiresAt: new Date(
      claimTime.getTime() + input.lockTtlSeconds * 1_000
    ).toISOString()
  });
  const result = { discovered, claimed: jobs.length, completed: 0, superseded: 0, failed: 0 };
  await Promise.all(jobs.map((job) => input.budget.run(async () => {
    try {
      const segments = await materializeCompactedSegments(input, job, now);
      const state = await input.repository.activateCompactedSegments({
        job,
        segments,
        completedAt: now().toISOString()
      });
      result[state] += 1;
    } catch {
      input.budget.recordRetry();
      const failedAt = now();
      await input.repository.fail({
        job,
        code: "PROJECTION_COMPACTION_FAILED",
        failedAt: failedAt.toISOString(),
        retryAt: new Date(failedAt.getTime() + input.retryDelayMs).toISOString()
      });
      result.failed += 1;
    }
  })));
  return result;
}

async function materializeCompactedSegments(
  input: Parameters<typeof runProjectionCompactionSlice>[0],
  job: ProjectionCompactionJob,
  now: () => Date
): Promise<ProjectionSegment[]> {
  const segments: ProjectionSegment[] = [];
  let afterRecordId: string | null = null;
  let sequenceNumber = 0;
  while (true) {
    const page = await input.repository.listActiveRecords({
      job,
      afterRecordId,
      limit: input.recordPageSize
    });
    if (page.length === 0) break;
    const heartbeatAt = now();
    const owned = await input.repository.heartbeat({
      job,
      heartbeatAt: heartbeatAt.toISOString(),
      leaseExpiresAt: new Date(
        heartbeatAt.getTime() + input.lockTtlSeconds * 1_000
      ).toISOString()
    });
    if (!owned) throw new Error("Projection compaction lease is unavailable");
    const body = renderProjectionSegment({
      projectionKind: job.projectionKind,
      logicalPartition: job.logicalPartition,
      segmentKind: "compacted",
      sequenceNumber,
      changes: page.map((record) => ({
        recordId: record.recordId,
        record: record.payload as never
      }))
    });
    const object = await input.immutableObjects.write({
      body,
      contentType: "application/json; charset=utf-8",
      formatVersion: 2
    });
    const id = compactedSegmentId(job, sequenceNumber, object.checksumSha256);
    segments.push({
      id,
      knowledgeBaseId: job.knowledgeBaseId,
      projectionKind: job.projectionKind,
      logicalPartition: job.logicalPartition,
      segmentKind: "compacted",
      sequenceNumber,
      formatVersion: object.formatVersion,
      checksumSha256: object.checksumSha256,
      objectKey: object.objectKey,
      logicalPath: `_segments/compacted/${id}.json`,
      entryCount: page.length,
      encodedBytes: object.sizeBytes,
      firstRecordIdentity: page[0]?.recordId ?? null,
      lastRecordIdentity: page.at(-1)?.recordId ?? null,
      baseSegmentId: job.expectedSegmentIds[0] ?? null,
      lifecycleState: "active"
    });
    afterRecordId = page.at(-1)!.recordId;
    sequenceNumber += 1;
    if (page.length < input.recordPageSize) break;
  }
  return segments;
}

function compactedSegmentId(
  job: ProjectionCompactionJob,
  sequenceNumber: number,
  checksumSha256: string
): string {
  return `projection-segment-${createHash("sha256")
    .update([
      job.knowledgeBaseId,
      job.projectionKind,
      job.logicalPartition,
      "compacted",
      String(sequenceNumber),
      checksumSha256
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
