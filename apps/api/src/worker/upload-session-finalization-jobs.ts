import type { RuntimeConfig, WorkerRuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { WorkerJobRecord } from "../db/worker-job-repository.js";

export type UploadSessionFinalizationResult = {
  completed: boolean;
  processedCount: number;
  retryAfter: string | null;
};

export async function processUploadSessionFinalizationJob(input: {
  job: WorkerJobRecord;
  repositories: AdminRepositories;
  worker: WorkerRuntimeConfig;
  upload: RuntimeConfig["upload"];
}): Promise<UploadSessionFinalizationResult> {
  const sessionId = readSessionId(input.job.payload);
  const repository = input.repositories.uploadSessions;
  const workerJobs = input.repositories.workerJobs;
  if (!sessionId || !repository || !workerJobs) {
    throw new Error("Upload finalization dependencies are unavailable");
  }

  const capacity = await readAvailableSourceQueueCapacity({
    repositories: input.repositories,
    knowledgeBaseId: input.job.knowledgeBaseId,
    worker: input.worker
  });
  if (capacity <= 0) {
    return {
      completed: false,
      processedCount: 0,
      retryAfter: retryAfter(input.worker.queueBackpressureRetryAfterSeconds ?? 60)
    };
  }

  const now = new Date().toISOString();
  const result = await repository.finalizeEntryBatch({
    knowledgeBaseId: input.job.knowledgeBaseId,
    sessionId,
    now,
    runAfter: now,
    limit: Math.min(input.upload.generationBatchSize, capacity),
    jobMaxAttempts: input.worker.jobMaxAttempts
  });
  if (result.cancelled) {
    return { completed: true, processedCount: 0, retryAfter: null };
  }
  if (result.completed) {
    await repository.completeSession({
      knowledgeBaseId: input.job.knowledgeBaseId,
      sessionId,
      now: new Date().toISOString()
    });
  }
  return {
    completed: result.completed,
    processedCount: result.processedCount,
    retryAfter: result.completed ? null : retryAfter(1)
  };
}

export function readUploadFinalizationSessionId(job: WorkerJobRecord): string | null {
  return readSessionId(job.payload);
}

async function readAvailableSourceQueueCapacity(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  worker: WorkerRuntimeConfig;
}): Promise<number> {
  const workerJobs = input.repositories.workerJobs;
  if (!workerJobs) {
    return 0;
  }
  const [globalActive, knowledgeBaseActive, queue] = await Promise.all([
    workerJobs.countActiveWorkerJobs({ kinds: ["source_file_processing"] }),
    workerJobs.countActiveWorkerJobs({
      kinds: ["source_file_processing"],
      knowledgeBaseId: input.knowledgeBaseId
    }),
    workerJobs.getWorkerQueueSummary({
      kinds: ["source_file_processing"],
      knowledgeBaseId: input.knowledgeBaseId,
      now: new Date().toISOString()
    })
  ]);
  if (
    queue.oldestQueuedAgeSeconds !== null
    && queue.oldestQueuedAgeSeconds >=
      (input.worker.queueBackpressureMaxAgeSeconds ?? Number.MAX_SAFE_INTEGER)
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      input.worker.queueBackpressureLimit - globalActive,
      (input.worker.queueBackpressureKnowledgeBaseLimit ?? Number.MAX_SAFE_INTEGER)
        - knowledgeBaseActive
    )
  );
}

function readSessionId(payload: Record<string, unknown>): string | null {
  const value = payload.sessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function retryAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}
