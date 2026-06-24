import { randomUUID } from "node:crypto";
import type { OpenAIResponsesClient } from "@focowiki/okf";
import { resolveWorkerConfig, type RuntimeConfig } from "../config.js";
import type {
  AdminRepositories,
  PublicationJobReason
} from "../db/admin-repositories.js";
import type {
  WorkerJobKind,
  WorkerJobRecord,
  WorkerJobRepository
} from "../db/worker-job-repository.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { createModelSuggestionTaskRunner } from "../runtime/model-task-runner.js";
import {
  createKnowledgeBasePublicationService,
  enqueuePendingPublicationWorkerJob
} from "../admin/publication-scheduler.js";
import { createSourceFileQueueProcessor } from "../admin/source-file-processor.js";
import type { StorageAdapter } from "../storage/s3.js";

export type WorkerRuntimeLogger = {
  info: (message: string, details?: Record<string, unknown>) => void;
  warn: (message: string, details?: Record<string, unknown>) => void;
  error: (message: string, details?: Record<string, unknown>) => void;
};

export type WorkerRuntime = {
  run: (signal: AbortSignal) => Promise<void>;
  tick: (signal?: AbortSignal) => Promise<number>;
};

export function createWorkerRuntime(input: {
  config: RuntimeConfig;
  repositories: AdminRepositories;
  storage: StorageAdapter;
  redis: RedisCoordinator;
  modelClient: OpenAIResponsesClient | null;
  logger: WorkerRuntimeLogger;
}): WorkerRuntime {
  const workerJobs: WorkerJobRepository | undefined = input.repositories.workerJobs;

  if (!workerJobs) {
    throw new Error("Worker job repository is unavailable");
  }
  const jobRepository: WorkerJobRepository = workerJobs;

  const workerId = `worker-${randomUUID()}`;
  const modelSuggestionRunner = createModelSuggestionTaskRunner(input.config);
  const sourceFileProcessor = createSourceFileQueueProcessor(
    input.repositories,
    input.storage,
    input.redis,
    input.modelClient && input.config.model.enabled
      ? {
          client: input.modelClient,
          modelName: input.config.model.modelName,
          contextWindowTokens: input.config.model.contextWindowTokens,
          receiveTimeouts: {
            maxMs: input.config.model.requestMaxTimeoutMs,
            idleMs: input.config.model.requestIdleTimeoutMs
          },
          suggestionConcurrency: input.config.model.suggestionConcurrency,
          transientRetryDelayMs: input.config.model.transientRetryDelayMs,
          requestRunner: modelSuggestionRunner
        }
      : null
  );

  if (!sourceFileProcessor) {
    throw new Error("Source file processor is unavailable");
  }
  const processor = sourceFileProcessor;
  const workerConfig = resolveWorkerConfig(input.config);
  const activeJobIds = new Set<string>();
  let lastCleanupAtMs = 0;

  async function tick(signal: AbortSignal = neverAbortedSignal()): Promise<number> {
    if (signal.aborted) {
      return 0;
    }

    const now = new Date();
    await recordActiveHeartbeat();
    lastCleanupAtMs = await cleanupWorkerJobHistory({
      workerJobs: jobRepository,
      config: input.config,
      now,
      lastCleanupAtMs
    });
    const claimed = await claimWorkerJobsForTick({
      workerJobs: jobRepository,
      workerId,
      limit: workerConfig.claimBatchSize,
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - workerConfig.lockTtlSeconds * 1_000).toISOString()
    });

    if (claimed.length === 0) {
      return 0;
    }

    if (signal.aborted) {
      await releaseWorkerJobs({
        workerJobs: jobRepository,
        workerId,
        jobs: claimed,
        releasedAt: new Date().toISOString()
      });
      return 0;
    }

    return await processClaimedJobs({
      claimed,
      concurrency: workerConfig.sourceFileConcurrency,
      signal
    });
  }

  async function claimJobs(claimInput: {
    kinds: WorkerJobKind[];
    limit: number;
    now: Date;
  }): Promise<WorkerJobRecord[]> {
    await recordActiveHeartbeat();
    lastCleanupAtMs = await cleanupWorkerJobHistory({
      workerJobs: jobRepository,
      config: input.config,
      now: claimInput.now,
      lastCleanupAtMs
    });
    return await jobRepository.claimWorkerJobs({
      workerId,
      kinds: claimInput.kinds,
      limit: claimInput.limit,
      now: claimInput.now.toISOString(),
      staleBefore: new Date(
        claimInput.now.getTime() - workerConfig.lockTtlSeconds * 1_000
      ).toISOString()
    });
  }

  async function processClaimedJobs(processInput: {
    claimed: WorkerJobRecord[];
    concurrency: number;
    signal: AbortSignal;
  }): Promise<number> {
    for (const job of processInput.claimed) {
      activeJobIds.add(job.id);
    }
    await recordActiveHeartbeat();

    try {
      const result = await runWithConcurrency(
        processInput.claimed,
        processInput.concurrency,
        (job) =>
          withJobHeartbeat(
            {
              job,
              workerId,
              workerJobs: jobRepository,
              intervalMs: workerConfig.heartbeatIntervalMs ?? 15_000
            },
            () =>
              processWorkerJob({
                job,
                workerId,
                workerJobs: jobRepository,
                repositories: input.repositories,
                storage: input.storage,
                redis: input.redis,
                sourceFileProcessor: processor,
                config: input.config,
                logger: input.logger
              })
          ),
        processInput.signal
      );
      if (result.skippedItems.length > 0) {
        await releaseWorkerJobs({
          workerJobs: jobRepository,
          workerId,
          jobs: result.skippedItems,
          releasedAt: new Date().toISOString()
        });
      }
      return result.processedCount;
    } finally {
      for (const job of processInput.claimed) {
        activeJobIds.delete(job.id);
      }
      await recordActiveHeartbeat();
    }
  }

  async function runLane(input: {
    kinds: WorkerJobKind[];
    limit: number;
    concurrency: number;
    pollIntervalMs: number;
    signal: AbortSignal;
  }): Promise<void> {
    while (!input.signal.aborted) {
      const claimed = await claimJobs({
        kinds: input.kinds,
        limit: input.limit,
        now: new Date()
      });

      if (claimed.length === 0) {
        await sleep(input.pollIntervalMs, input.signal);
        continue;
      }

      if (input.signal.aborted) {
        await releaseWorkerJobs({
          workerJobs: jobRepository,
          workerId,
          jobs: claimed,
          releasedAt: new Date().toISOString()
        });
        return;
      }

      await processClaimedJobs({
        claimed,
        concurrency: input.concurrency,
        signal: input.signal
      });
    }
  }

  async function recordActiveHeartbeat(): Promise<void> {
    await recordHeartbeat(jobRepository, workerId, activeJobIds.size);
  }

  return {
    run: async (signal) => {
      input.logger.info("Worker service started", { workerId });

      await Promise.all([
        runLane({
          kinds: ["publication"],
          limit: 1,
          concurrency: 1,
          pollIntervalMs: Math.min(workerConfig.pollIntervalMs, 1_000),
          signal
        }),
        runLane({
          kinds: ["source_file_processing"],
          limit: workerConfig.claimBatchSize,
          concurrency: workerConfig.sourceFileConcurrency,
          pollIntervalMs: workerConfig.pollIntervalMs,
          signal
        })
      ]);

      input.logger.info("Worker service stopped", { workerId });
    },
    tick
  };
}

async function claimWorkerJobsForTick(input: {
  workerJobs: WorkerJobRepository;
  workerId: string;
  limit: number;
  now: string;
  staleBefore: string;
}): Promise<WorkerJobRecord[]> {
  if (input.limit <= 0) {
    return [];
  }

  const publicationJobs = await input.workerJobs.claimWorkerJobs({
    workerId: input.workerId,
    kinds: ["publication"],
    limit: Math.min(1, input.limit),
    now: input.now,
    staleBefore: input.staleBefore
  });
  const remainingLimit = input.limit - publicationJobs.length;

  if (remainingLimit <= 0) {
    return publicationJobs;
  }

  const sourceFileJobs = await input.workerJobs.claimWorkerJobs({
    workerId: input.workerId,
    kinds: ["source_file_processing"],
    limit: remainingLimit,
    now: input.now,
    staleBefore: input.staleBefore
  });

  return [...publicationJobs, ...sourceFileJobs];
}

async function processWorkerJob(input: {
  job: WorkerJobRecord;
  workerId: string;
  workerJobs: WorkerJobRepository;
  repositories: AdminRepositories;
  storage: StorageAdapter;
  redis: RedisCoordinator;
  sourceFileProcessor: NonNullable<ReturnType<typeof createSourceFileQueueProcessor>>;
  config: RuntimeConfig;
  logger: WorkerRuntimeLogger;
}): Promise<void> {
  if (input.job.kind === "publication") {
    await processPublicationJob(input);
    return;
  }

  await processSourceFileJob(input);
}

async function processSourceFileJob(input: {
  job: WorkerJobRecord;
  workerId: string;
  workerJobs: WorkerJobRepository;
  repositories: AdminRepositories;
  sourceFileProcessor: NonNullable<ReturnType<typeof createSourceFileQueueProcessor>>;
  config: RuntimeConfig;
  logger: WorkerRuntimeLogger;
}): Promise<void> {
  if (!input.job.sourceFileId) {
    await failJob(input, "INVALID_WORKER_JOB", "Source file job is missing sourceFileId.");
    return;
  }

  const knowledgeBase = await input.repositories.knowledgeBases.getKnowledgeBase(
    input.job.knowledgeBaseId
  );

  if (!knowledgeBase) {
    await completeOrphanedJob(input, "Source-file job completed without knowledge base.");
    return;
  }

  try {
    input.logger.info("Worker job started", {
      jobId: input.job.id,
      kind: input.job.kind,
      sourceFileId: input.job.sourceFileId,
      attemptCount: input.job.attemptCount
    });
    await input.sourceFileProcessor.processFile({
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.name,
      sourceFileId: input.job.sourceFileId,
      generatedAt: new Date().toISOString(),
      batchSize: input.config.upload.generationBatchSize,
      cursorTtlSeconds: input.config.pagination.cursorTtlSeconds,
      fileProcessingConcurrency: input.config.upload.fileProcessingConcurrency,
      okfLog: input.config.okf?.log,
      publication: {
        ...input.config.publication,
        workerJobMaxAttempts: resolveWorkerConfig(input.config).jobMaxAttempts
      }
    });

    await input.workerJobs.completeWorkerJob({
      id: input.job.id,
      workerId: input.workerId,
      completedAt: new Date().toISOString()
    });
    input.logger.info("Worker job completed", {
      jobId: input.job.id,
      kind: input.job.kind,
      sourceFileId: input.job.sourceFileId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker job failed";
    await failJob(input, "WORKER_JOB_FAILED", message);
  }
}

async function processPublicationJob(input: {
  job: WorkerJobRecord;
  workerId: string;
  workerJobs: WorkerJobRepository;
  repositories: AdminRepositories;
  storage: StorageAdapter;
  redis: RedisCoordinator;
  config: RuntimeConfig;
  logger: WorkerRuntimeLogger;
}): Promise<void> {
  const reason = readPublicationReason(input.job.payload);

  if (!reason) {
    await failJob(input, "INVALID_WORKER_JOB", "Publication job is missing a valid reason.");
    return;
  }

  const knowledgeBase = await input.repositories.knowledgeBases.getKnowledgeBase(
    input.job.knowledgeBaseId
  );

  if (!knowledgeBase) {
    await completeOrphanedJob(input, "Publication job completed without knowledge base.");
    return;
  }

  const publicationService = createKnowledgeBasePublicationService(
    input.repositories,
    input.storage,
    input.redis
  );

  if (!publicationService) {
    await failJob(input, "PUBLICATION_SERVICE_UNAVAILABLE", "Publication service is unavailable.");
    return;
  }

  try {
    input.logger.info("Publication job started", {
      jobId: input.job.id,
      kind: input.job.kind,
      knowledgeBaseId: input.job.knowledgeBaseId,
      attemptCount: input.job.attemptCount
    });
    const result = await publicationService.publishNow({
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.name,
      generatedAt: new Date().toISOString(),
      pageSize: input.config.upload.generationBatchSize,
      cursorTtlSeconds: input.config.pagination.cursorTtlSeconds,
      fileProcessingConcurrency: input.config.upload.fileProcessingConcurrency,
      okfLog: input.config.okf?.log,
      options: {
        ...input.config.publication,
        workerJobMaxAttempts: resolveWorkerConfig(input.config).jobMaxAttempts
      },
      reason,
      allowEmptyPublication: reason === "deletion"
    });

    if (!result.published) {
      const dirtyCount = await input.repositories.files?.countDirtySourceFiles?.({
        knowledgeBaseId: knowledgeBase.id
      });

      if ((dirtyCount?.count ?? 0) === 0) {
        await input.workerJobs.completeWorkerJob({
          id: input.job.id,
          workerId: input.workerId,
          completedAt: new Date().toISOString()
        });
        input.logger.info("Publication job completed without dirty files", {
          jobId: input.job.id,
          kind: input.job.kind,
          knowledgeBaseId: input.job.knowledgeBaseId
        });
        return;
      }

      await failJob(input, "PUBLICATION_NOT_READY", "Publication job did not publish a release.");
      return;
    }

    const completedAt = new Date().toISOString();
    await input.workerJobs.completeWorkerJob({
      id: input.job.id,
      workerId: input.workerId,
      completedAt
    });
    await enqueueRemainingPublicationJob({
      repositories: input.repositories,
      config: input.config,
      knowledgeBaseId: knowledgeBase.id,
      generatedAt: completedAt
    });
    input.logger.info("Publication job completed", {
      jobId: input.job.id,
      kind: input.job.kind,
      knowledgeBaseId: input.job.knowledgeBaseId,
      releaseId: result.releaseId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publication worker job failed";
    await failJob(input, "PUBLICATION_JOB_FAILED", message);
  }
}

async function enqueueRemainingPublicationJob(input: {
  repositories: AdminRepositories;
  config: RuntimeConfig;
  knowledgeBaseId: string;
  generatedAt: string;
}): Promise<void> {
  const workerJobs = input.repositories.workerJobs ?? null;
  const countDirtySourceFiles = input.repositories.files?.countDirtySourceFiles;

  if (!workerJobs || !countDirtySourceFiles) {
    return;
  }

  const dirty = await countDirtySourceFiles({
    knowledgeBaseId: input.knowledgeBaseId
  });
  await enqueuePendingPublicationWorkerJob({
    workerJobs,
    knowledgeBaseId: input.knowledgeBaseId,
    options: {
      ...input.config.publication,
      workerJobMaxAttempts: resolveWorkerConfig(input.config).jobMaxAttempts
    },
    dirtyCount: dirty.count,
    oldestDirtyAt: dirty.oldestDirtyAt,
    generatedAt: input.generatedAt
  });
}

async function completeOrphanedJob(input: {
  job: WorkerJobRecord;
  workerId: string;
  workerJobs: WorkerJobRepository;
  logger: WorkerRuntimeLogger;
}, message: string): Promise<void> {
  await input.workerJobs.completeWorkerJob({
    id: input.job.id,
    workerId: input.workerId,
    completedAt: new Date().toISOString()
  });
  input.logger.info(message, {
    jobId: input.job.id,
    kind: input.job.kind,
    knowledgeBaseId: input.job.knowledgeBaseId,
    sourceFileId: input.job.sourceFileId
  });
}

async function failJob(
  input: {
    job: WorkerJobRecord;
    workerId: string;
    workerJobs: WorkerJobRepository;
    config: RuntimeConfig;
    logger?: WorkerRuntimeLogger;
  },
  errorCode: string,
  errorMessage: string
): Promise<void> {
  const failedAt = new Date();
  const workerConfig = resolveWorkerConfig(input.config);
  const retryAfter =
    input.job.attemptCount < input.job.maxAttempts
      ? new Date(failedAt.getTime() + workerConfig.jobRetryDelayMs).toISOString()
      : null;

  if (retryAfter) {
    await input.workerJobs.failWorkerJob({
      id: input.job.id,
      workerId: input.workerId,
      failedAt: failedAt.toISOString(),
      errorCode,
      errorMessage,
      retryAfter
    });
    input.logger?.warn("Worker job will retry", {
      jobId: input.job.id,
      kind: input.job.kind,
      sourceFileId: input.job.sourceFileId,
      attemptCount: input.job.attemptCount,
      errorCode,
      retryAfter
    });
    return;
  }

  await input.workerJobs.deadLetterWorkerJob({
    id: input.job.id,
    workerId: input.workerId,
    failedAt: failedAt.toISOString(),
    errorCode,
    errorMessage
  });
  input.logger?.error("Worker job moved to dead letter", {
    jobId: input.job.id,
    kind: input.job.kind,
    sourceFileId: input.job.sourceFileId,
    attemptCount: input.job.attemptCount,
    errorCode
  });
}

function readPublicationReason(payload: Record<string, unknown>): PublicationJobReason | null {
  const value = payload.reason;

  if (
    value === "bootstrap" ||
    value === "batch_threshold" ||
    value === "batch_interval" ||
    value === "manual" ||
    value === "per_file" ||
    value === "deletion"
  ) {
    return value;
  }

  return null;
}

async function withJobHeartbeat<T>(
  input: {
    job: WorkerJobRecord;
    workerId: string;
    workerJobs: WorkerJobRepository;
    intervalMs: number;
  },
  work: () => Promise<T>
): Promise<T> {
  await input.workerJobs.heartbeatWorkerJob({
    id: input.job.id,
    workerId: input.workerId,
    heartbeatAt: new Date().toISOString()
  });
  const timer = setInterval(() => {
    void input.workerJobs.heartbeatWorkerJob({
      id: input.job.id,
      workerId: input.workerId,
      heartbeatAt: new Date().toISOString()
    });
  }, input.intervalMs);
  timer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function recordHeartbeat(
  workerJobs: WorkerJobRepository,
  workerId: string,
  activeJobCount: number
): Promise<void> {
  await workerJobs.recordWorkerHeartbeat({
    workerId,
    activeJobCount,
    lastSeenAt: new Date().toISOString()
  });
}

async function releaseWorkerJobs(input: {
  workerJobs: WorkerJobRepository;
  workerId: string;
  jobs: WorkerJobRecord[];
  releasedAt: string;
}): Promise<void> {
  await Promise.all(
    input.jobs.map((job) =>
      input.workerJobs.releaseWorkerJob({
        id: job.id,
        workerId: input.workerId,
        releasedAt: input.releasedAt,
        runAfter: input.releasedAt
      })
    )
  );
}

async function cleanupWorkerJobHistory(input: {
  workerJobs: WorkerJobRepository;
  config: RuntimeConfig;
  now: Date;
  lastCleanupAtMs: number;
}): Promise<number> {
  const workerConfig = resolveWorkerConfig(input.config);
  const cleanupIntervalMs = 5 * 60 * 1_000;

  if (input.now.getTime() - input.lastCleanupAtMs < cleanupIntervalMs) {
    return input.lastCleanupAtMs;
  }

  await input.workerJobs.cleanupWorkerJobs({
    completedBefore: daysBefore(input.now, workerConfig.completedJobRetentionDays ?? 7),
    failedBefore: daysBefore(input.now, workerConfig.failedJobRetentionDays ?? 30),
    deadLetterBefore: daysBefore(input.now, workerConfig.deadLetterJobRetentionDays ?? 90),
    limit: workerConfig.retentionCleanupBatchSize ?? 1_000
  });

  return input.now.getTime();
}

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
  signal: AbortSignal = neverAbortedSignal()
): Promise<{ processedCount: number; skippedItems: T[] }> {
  let cursor = 0;
  const startedIndexes = new Set<number>();
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal.aborted) {
        break;
      }

      const index = cursor;
      const item = items[cursor];
      cursor += 1;

      if (item) {
        startedIndexes.add(index);
        await work(item);
      }
    }
  });

  await Promise.all(workers);
  return {
    processedCount: startedIndexes.size,
    skippedItems: items.filter((_, index) => !startedIndexes.has(index))
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}
