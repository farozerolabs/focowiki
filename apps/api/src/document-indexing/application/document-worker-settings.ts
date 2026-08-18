import type { WorkerRuntimeConfig } from "../../config.js";
import type { RuntimeWorkerPublicSettings } from
  "../../runtime-settings/types.js";

export function deriveDocumentWorkerRuntimeSettings(input: {
  deployment: Required<WorkerRuntimeConfig>;
  stored: RuntimeWorkerPublicSettings | null;
}): Required<WorkerRuntimeConfig> {
  const documentConcurrency = input.stored?.sourceFileConcurrency
    ?? input.deployment.sourceFileConcurrency;
  return {
    ...input.deployment,
    sourceFileConcurrency: documentConcurrency,
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
