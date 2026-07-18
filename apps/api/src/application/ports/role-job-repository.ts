import type { RoleJobKind, RoleJobRecord } from "../../domain/role-job.js";
import type { WorkerRole } from "../../domain/generation.js";
import type { SerializableJson } from "./source-dispatch-repository.js";

export type RoleJobQueueSummary = {
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  deadLetterCount: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeSeconds: number | null;
};

export type RoleJobRepository = {
  getQueueSummary: (input: {
    role: WorkerRole;
    knowledgeBaseId: string;
    now: string;
  }) => Promise<RoleJobQueueSummary>;
  enqueue: (input: {
    id: string;
    role: WorkerRole;
    kind: RoleJobKind;
    knowledgeBaseId: string;
    sourceFileId: string | null;
    sourceRevisionId: string | null;
    generationId: string | null;
    payload: SerializableJson;
    settingsSnapshot: SerializableJson;
    runAfter: string;
    maxAttempts: number;
    createdAt: string;
  }) => Promise<RoleJobRecord>;
  cancelSourceJobsForDeletionIntent: (input: {
    knowledgeBaseId: string;
    deletionIntentId: string;
    cancelledAt: string;
    code: string;
    message: string;
  }) => Promise<number>;
  cancelKnowledgeBaseJobs: (input: {
    knowledgeBaseId: string;
    excludeJobIds: string[];
    cancelledAt: string;
    code: string;
    message: string;
  }) => Promise<number>;
  claim: (input: {
    role: WorkerRole;
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }) => Promise<RoleJobRecord[]>;
  heartbeat: (input: {
    role: WorkerRole;
    workerId: string;
    jobIds: string[];
    now: string;
  }) => Promise<void>;
  complete: (input: {
    jobId: string;
    workerId: string;
    completedAt: string;
  }) => Promise<void>;
  retry: (input: {
    jobId: string;
    workerId: string;
    code: string;
    message: string;
    failedAt: string;
    runAfter: string;
  }) => Promise<void>;
  reschedule: (input: {
    jobId: string;
    workerId: string;
    runAfter: string;
    rescheduledAt: string;
  }) => Promise<void>;
  fail: (input: {
    jobId: string;
    workerId: string;
    code: string;
    message: string;
    failedAt: string;
  }) => Promise<void>;
  release: (input: {
    jobIds: string[];
    workerId: string;
    releasedAt: string;
  }) => Promise<void>;
  removeHeartbeat: (input: { workerId: string }) => Promise<void>;
};
