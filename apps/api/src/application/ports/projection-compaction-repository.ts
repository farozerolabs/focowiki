import type { SerializableJson } from "./source-dispatch-repository.js";
import type { ProjectionSegment } from "./projection-segment-repository.js";
import type { ProjectionCompactionLimits } from "../../maintenance/projection-compaction-policy.js";

export type ProjectionCompactionJob = {
  id: string;
  knowledgeBaseId: string;
  projectionKind: string;
  logicalPartition: string;
  activeGenerationId: string;
  expectedSegmentIds: string[];
  reasonCodes: string[];
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string;
};

export type ProjectionCompactionRecord = {
  recordId: string;
  payload: SerializableJson;
};

export type ProjectionCompactionRepository = {
  discoverCandidates(input: {
    limits: ProjectionCompactionLimits;
    partitionLimit: number;
    maxAttempts: number;
    discoveredAt: string;
  }): Promise<number>;
  claim(input: {
    workerId: string;
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ProjectionCompactionJob[]>;
  listActiveRecords(input: {
    job: ProjectionCompactionJob;
    afterRecordId: string | null;
    limit: number;
  }): Promise<ProjectionCompactionRecord[]>;
  heartbeat(input: {
    job: ProjectionCompactionJob;
    heartbeatAt: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  activateCompactedSegments(input: {
    job: ProjectionCompactionJob;
    segments: ProjectionSegment[];
    completedAt: string;
  }): Promise<"completed" | "superseded">;
  fail(input: {
    job: ProjectionCompactionJob;
    code: string;
    failedAt: string;
    retryAt: string;
  }): Promise<"pending" | "failed">;
};
