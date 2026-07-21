import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { WorkerRole } from "../domain/generation.js";
import {
  RoleJobFailure,
  RoleJobReschedule,
  type RoleJobRecord
} from "../domain/role-job.js";

export type RoleWorkerSettings = {
  claimBatchSize: number;
  concurrency: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  heartbeatIntervalMs: number;
  retryDelayMs: number;
};

export type RoleWorkerRuntime = {
  tick: (signal?: AbortSignal) => Promise<number>;
  run: (signal: AbortSignal) => Promise<void>;
};

export function createRoleWorkerRuntime(input: {
  role: WorkerRole;
  workerId: string;
  repository: RoleJobRepository;
  settings: RoleWorkerSettings | (() => Promise<RoleWorkerSettings>);
  beforeClaim?: (() => Promise<void>) | undefined;
  process: (job: RoleJobRecord, signal: AbortSignal) => Promise<void>;
  now?: (() => Date) | undefined;
  logger?: {
    info: (message: string, details?: Record<string, unknown>) => void;
    warn: (message: string, details?: Record<string, unknown>) => void;
  } | undefined;
}): RoleWorkerRuntime {
  if (typeof input.settings !== "function") {
    assertSettings(input.settings);
  }
  const now = input.now ?? (() => new Date());
  const activeJobIds = new Set<string>();
  let heartbeatInFlight: Promise<void> | null = null;
  let heartbeatRequested = false;

  async function recordHeartbeat(): Promise<void> {
    heartbeatRequested = true;
    if (!heartbeatInFlight) {
      const operation = (async () => {
        while (heartbeatRequested) {
          heartbeatRequested = false;
          await input.repository.heartbeat({
            role: input.role,
            workerId: input.workerId,
            jobIds: [...activeJobIds],
            now: now().toISOString()
          });
        }
      })();
      heartbeatInFlight = operation.finally(() => {
        heartbeatInFlight = null;
      });
    }
    await heartbeatInFlight;
  }

  async function tick(signal: AbortSignal = neverAbortedSignal()): Promise<number> {
    if (signal.aborted) {
      return 0;
    }

    await input.beforeClaim?.();
    await recordHeartbeat();
    const settings = await resolveSettings();
    const claimTime = now();
    const claimed = await input.repository.claim({
      role: input.role,
      workerId: input.workerId,
      limit: settings.claimBatchSize,
      now: claimTime.toISOString(),
      staleBefore: new Date(
        claimTime.getTime() - settings.lockTtlSeconds * 1_000
      ).toISOString()
    });

    if (claimed.length === 0) {
      return 0;
    }

    if (signal.aborted) {
      await release(claimed);
      return 0;
    }

    for (const job of claimed) {
      activeJobIds.add(job.id);
    }
    await recordHeartbeat();
    const heartbeatTimer = setInterval(() => {
      void recordHeartbeat().catch(() => undefined);
    }, settings.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    let nextIndex = 0;
    let processedCount = 0;
    const runners = Array.from(
      { length: Math.min(settings.concurrency, claimed.length) },
      async () => {
        while (!signal.aborted) {
          const job = claimed[nextIndex];
          nextIndex += 1;
          if (!job) {
            return;
          }
          try {
            await processJob(job, signal, settings);
            processedCount += 1;
          } finally {
            activeJobIds.delete(job.id);
          }
        }
      }
    );

    try {
      await Promise.all(runners);
      const unstarted = claimed.slice(nextIndex);
      if (unstarted.length > 0) {
        await release(unstarted);
        for (const job of unstarted) {
          activeJobIds.delete(job.id);
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      await recordHeartbeat();
    }
    return processedCount;
  }

  async function processJob(
    job: RoleJobRecord,
    signal: AbortSignal,
    settings: RoleWorkerSettings
  ): Promise<void> {
    try {
      await input.process(job, signal);
      await input.repository.complete({
        jobId: job.id,
        workerId: input.workerId,
        completedAt: now().toISOString()
      });
    } catch (error) {
      if (error instanceof RoleJobReschedule) {
        await input.repository.reschedule({
          jobId: job.id,
          workerId: input.workerId,
          runAfter: error.runAfter,
          rescheduledAt: now().toISOString()
        });
        return;
      }
      const failure = normalizeFailure(error);
      const failedAt = now();
      const terminal = !failure.retryable || job.attemptCount >= job.maxAttempts;
      if (terminal) {
        await input.repository.fail({
          jobId: job.id,
          workerId: input.workerId,
          code: failure.code,
          message: failure.message,
          failedAt: failedAt.toISOString()
        });
      } else {
        await input.repository.retry({
          jobId: job.id,
          workerId: input.workerId,
          code: failure.code,
          message: failure.message,
          failedAt: failedAt.toISOString(),
          runAfter: new Date(
            failedAt.getTime() + settings.retryDelayMs
          ).toISOString()
        });
      }
      input.logger?.warn("Role job failed", {
        role: input.role,
        jobId: job.id,
        safeErrorCode: failure.code,
        terminal
      });
    }
  }

  async function release(jobs: RoleJobRecord[]): Promise<void> {
    await input.repository.release({
      jobIds: jobs.map((job) => job.id),
      workerId: input.workerId,
      releasedAt: now().toISOString()
    });
  }

  return {
    tick,
    async run(signal) {
      input.logger?.info("Role worker started", {
        role: input.role,
        workerId: input.workerId
      });
      try {
        while (!signal.aborted) {
          const processed = await tick(signal);
          if (processed === 0 && !signal.aborted) {
            const settings = await resolveSettings();
            await sleep(settings.pollIntervalMs, signal);
          }
        }
      } finally {
        await input.repository.removeHeartbeat({ workerId: input.workerId });
        input.logger?.info("Role worker stopped", {
          role: input.role,
          workerId: input.workerId
        });
      }
    }
  };

  async function resolveSettings(): Promise<RoleWorkerSettings> {
    const settings = typeof input.settings === "function"
      ? await input.settings()
      : input.settings;
    assertSettings(settings);
    return settings;
  }
}

function normalizeFailure(error: unknown): RoleJobFailure {
  if (error instanceof RoleJobFailure) {
    return error;
  }
  return new RoleJobFailure({
    code: "ROLE_JOB_FAILED",
    message: error instanceof Error ? error.message : "Role job failed",
    cause: error
  });
}

function assertSettings(settings: RoleWorkerSettings): void {
  for (const [field, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
  }
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
