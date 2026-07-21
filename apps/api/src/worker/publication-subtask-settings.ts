import type { RoleWorkerSettings } from "./role-runtime.js";

const SUBTASK_PREFETCH_WAVES = 4;

export function resolvePublicationSubtaskWorkerSettings(input: {
  generationClaimBatchSize: number;
  projectionPartitionConcurrency: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  heartbeatIntervalMs: number;
  retryDelayMs: number;
}): RoleWorkerSettings {
  const concurrency = input.projectionPartitionConcurrency;
  return {
    claimBatchSize: Math.max(
      input.generationClaimBatchSize,
      concurrency * SUBTASK_PREFETCH_WAVES
    ),
    concurrency,
    pollIntervalMs: input.pollIntervalMs,
    lockTtlSeconds: input.lockTtlSeconds,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    retryDelayMs: input.retryDelayMs
  };
}
