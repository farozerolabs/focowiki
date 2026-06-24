import { resolveWorkerConfig, type RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { WorkerJobRepository } from "../db/worker-job-repository.js";

export class WorkerQueueBackpressureError extends Error {
  public readonly code = "QUEUE_BACKPRESSURE";
  public readonly activeJobCount: number;
  public readonly limit: number;
  public readonly knowledgeBaseActiveJobCount: number | null;
  public readonly knowledgeBaseLimit: number | null;
  public readonly oldestQueuedAgeSeconds: number | null;
  public readonly maxQueuedAgeSeconds: number | null;
  public readonly retryAfterSeconds: number;

  public constructor(input: {
    activeJobCount: number;
    limit: number;
    knowledgeBaseActiveJobCount?: number | null;
    knowledgeBaseLimit?: number | null;
    oldestQueuedAgeSeconds?: number | null;
    maxQueuedAgeSeconds?: number | null;
    retryAfterSeconds: number;
  }) {
    super("Worker queue is above the configured backpressure limit.");
    this.name = "WorkerQueueBackpressureError";
    this.activeJobCount = input.activeJobCount;
    this.limit = input.limit;
    this.knowledgeBaseActiveJobCount = input.knowledgeBaseActiveJobCount ?? null;
    this.knowledgeBaseLimit = input.knowledgeBaseLimit ?? null;
    this.oldestQueuedAgeSeconds = input.oldestQueuedAgeSeconds ?? null;
    this.maxQueuedAgeSeconds = input.maxQueuedAgeSeconds ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

export function requireWorkerJobRepository(
  repositories: AdminRepositories | null
): WorkerJobRepository | null {
  return repositories?.workerJobs ?? null;
}

export async function enqueueSourceFileProcessingJobs(input: {
  repositories: AdminRepositories;
  sourceFileIds: string[];
  knowledgeBaseId: string;
  reason: "upload" | "retry";
  config: Pick<RuntimeConfig, "worker">;
}): Promise<void> {
  const workerJobs = requireWorkerJobRepository(input.repositories);

  if (!workerJobs) {
    throw new Error("Worker job repository is unavailable");
  }

  const workerConfig = resolveWorkerConfig(input.config);
  await assertSourceFileQueueCapacity({
    repositories: input.repositories,
    knowledgeBaseId: input.knowledgeBaseId,
    config: input.config
  });

  const runAfter = new Date().toISOString();

  for (const sourceFileId of input.sourceFileIds) {
    await workerJobs.enqueueSourceFileJob({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId,
      reason: input.reason,
      runAfter,
      maxAttempts: workerConfig.jobMaxAttempts
    });
  }
}

export async function assertSourceFileQueueCapacity(input: {
  repositories: AdminRepositories;
  knowledgeBaseId?: string | null;
  config: Pick<RuntimeConfig, "worker">;
}): Promise<void> {
  const workerJobs = requireWorkerJobRepository(input.repositories);

  if (!workerJobs) {
    throw new Error("Worker job repository is unavailable");
  }

  const workerConfig = resolveWorkerConfig(input.config);
  const [activeJobCount, knowledgeBaseActiveJobCount, queueSummary] = await Promise.all([
    workerJobs.countActiveWorkerJobs({
      kinds: ["source_file_processing"]
    }),
    input.knowledgeBaseId
      ? workerJobs.countActiveWorkerJobs({
          kinds: ["source_file_processing"],
          knowledgeBaseId: input.knowledgeBaseId
        })
      : Promise.resolve(null),
    workerJobs.getWorkerQueueSummary({
      kinds: ["source_file_processing"],
      knowledgeBaseId: input.knowledgeBaseId ?? null,
      now: new Date().toISOString()
    })
  ]);
  const createBackpressureError = () =>
    new WorkerQueueBackpressureError({
      activeJobCount,
      limit: workerConfig.queueBackpressureLimit,
      knowledgeBaseActiveJobCount,
      knowledgeBaseLimit: input.knowledgeBaseId
        ? (workerConfig.queueBackpressureKnowledgeBaseLimit ?? null)
        : null,
      oldestQueuedAgeSeconds: queueSummary.oldestQueuedAgeSeconds,
      maxQueuedAgeSeconds: workerConfig.queueBackpressureMaxAgeSeconds ?? null,
      retryAfterSeconds: workerConfig.queueBackpressureRetryAfterSeconds ?? 60
    });

  if (activeJobCount >= workerConfig.queueBackpressureLimit) {
    throw createBackpressureError();
  }

  if (
    input.knowledgeBaseId &&
    knowledgeBaseActiveJobCount !== null &&
    knowledgeBaseActiveJobCount >=
      (workerConfig.queueBackpressureKnowledgeBaseLimit ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw createBackpressureError();
  }

  if (
    queueSummary.oldestQueuedAgeSeconds !== null &&
    queueSummary.oldestQueuedAgeSeconds >=
      (workerConfig.queueBackpressureMaxAgeSeconds ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw createBackpressureError();
  }
}
