import type { WorkerRuntimeConfig } from "../../config.js";
import { DEFAULT_WORKER_S3_CONCURRENCY } from
  "../../runtime-settings/types.js";
import type { RuntimeWorkerPublicSettings } from
  "../../runtime-settings/types.js";

export type ResolvedDocumentWorkerRuntimeSettings = Required<WorkerRuntimeConfig> & {
  sourceObjectReadConcurrency: number;
};

export function deriveDocumentWorkerRuntimeSettings(input: {
  deployment: Required<WorkerRuntimeConfig>;
  stored: RuntimeWorkerPublicSettings | null;
}): ResolvedDocumentWorkerRuntimeSettings {
  const documentConcurrency = input.stored?.sourceFileConcurrency
    ?? input.deployment.sourceFileConcurrency;
  return {
    ...input.deployment,
    sourceFileConcurrency: documentConcurrency,
    sourceObjectReadConcurrency: input.stored?.s3Concurrency
      ?? DEFAULT_WORKER_S3_CONCURRENCY,
    claimBatchSize: Math.min(1_000, Math.max(
      documentConcurrency,
      documentConcurrency * 2
    )),
    pollIntervalMs: input.deployment.pollIntervalMs,
    lockTtlSeconds: input.deployment.lockTtlSeconds,
    heartbeatIntervalMs: input.deployment.heartbeatIntervalMs,
    jobMaxAttempts: input.stored?.jobMaxAttempts
      ?? input.deployment.jobMaxAttempts,
    jobRetryDelayMs: input.stored?.jobRetryDelayMs
      ?? input.deployment.jobRetryDelayMs,
    completedJobRetentionDays: input.stored?.completedJobRetentionDays
      ?? input.deployment.completedJobRetentionDays
  };
}
