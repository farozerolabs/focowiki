import type { PublicationImpactRepository } from "../application/ports/publication-impact-repository.js";
import type {
  PublicationSubtask,
  PublicationSubtaskRepository
} from "../application/ports/publication-subtask-repository.js";
import { readPublicationWorkSettings } from "../publication/publication-settings-snapshot.js";
import { createContinuousSlotScheduler } from "./continuous-slot-scheduler.js";
import {
  executePublicationImpactGroup,
  groupPublicationImpacts,
  type PublicationImpactWriter
} from "./publication-impact-executor.js";
import type { RoleWorkerSettings } from "./role-runtime.js";
import type { PublicationTerminalPhaseHandlers } from "./publication-terminal-phase-handler.js";
import { RoleJobFailure } from "../domain/role-job.js";
import { ImmutableObjectWriteInProgressError } from "../publication/immutable-object-writer.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";

type SubtaskResourceBudget = Pick<ResourceBudget, "run"> &
  Partial<Pick<ResourceBudget, "recordRetry">>;

export type PublicationSubtaskRuntime = {
  tick: (signal?: AbortSignal) => Promise<number>;
  run: (signal: AbortSignal) => Promise<void>;
};

export function createPublicationSubtaskRuntime(input: {
  subtasks: PublicationSubtaskRepository;
  impacts: PublicationImpactRepository;
  writers: PublicationImpactWriter[];
  terminalHandlers?: PublicationTerminalPhaseHandlers;
  settings: RoleWorkerSettings | (() => Promise<RoleWorkerSettings>);
  workerId: string;
  resourceBudgets?: {
    projectionPartition: SubtaskResourceBudget;
    directory: SubtaskResourceBudget;
  };
  now?: () => Date;
  logger?: {
    info: (message: string, details?: Record<string, unknown>) => void;
    warn: (message: string, details?: Record<string, unknown>) => void;
  };
}): PublicationSubtaskRuntime {
  const now = input.now ?? (() => new Date());

  async function tick(signal = new AbortController().signal): Promise<number> {
    if (signal.aborted) return 0;
    const settings = await resolveSettings(input.settings);
    const claimTime = now();
    const tasks = await input.subtasks.claim({
      workerId: input.workerId,
      limit: settings.claimBatchSize,
      now: claimTime.toISOString(),
      staleBefore: new Date(
        claimTime.getTime() - settings.lockTtlSeconds * 1_000
      ).toISOString()
    });
    if (tasks.length === 0) return 0;

    const scheduler = createContinuousSlotScheduler({
      concurrency: settings.concurrency
    });
    const scheduled = await scheduler.run(
      tasks,
      async (task) => {
        await processTask(task, settings, signal);
        return null;
      }
    );
    if (scheduled.unstarted.length > 0) {
      const releasedAt = now().toISOString();
      await Promise.all(scheduled.unstarted.map((task) => input.subtasks.reschedule({
        taskId: task.id,
        workerId: input.workerId,
        processedCount: task.processedCount,
        runAfter: releasedAt,
        rescheduledAt: releasedAt,
        preserveAttempt: true
      })));
    }
    return scheduled.results.length;
  }

  async function processTask(
    task: PublicationSubtask,
    settings: RoleWorkerSettings,
    signal: AbortSignal
  ): Promise<void> {
    const workSettings = readPublicationWorkSettings(task.settingsSnapshot);
    let processedCount = task.processedCount;
    const heartbeat = setInterval(() => {
      if (!task.leaseToken) return;
      const heartbeatAt = now();
      void input.subtasks.heartbeat({
        taskIds: [task.id],
        workerId: input.workerId,
        leaseTokenByTaskId: { [task.id]: task.leaseToken },
        heartbeatAt: heartbeatAt.toISOString(),
        leaseExpiresAt: new Date(
          heartbeatAt.getTime() + settings.lockTtlSeconds * 1_000
        ).toISOString()
      }).catch(() => undefined);
    }, settings.heartbeatIntervalMs);
    heartbeat.unref?.();
    const budget = task.taskKind === "directory"
      ? input.resourceBudgets?.directory
      : input.resourceBudgets?.projectionPartition;

    try {
      if (isTerminalPhase(task.taskKind)) {
        const handler = input.terminalHandlers?.[task.taskKind];
        if (!handler) throw new Error(`Publication subtask handler is unavailable: ${task.taskKind}`);
        await handler(task);
        await input.subtasks.complete({
          taskId: task.id,
          workerId: input.workerId,
          processedCount: 1,
          completedAt: now().toISOString()
        });
        return;
      }
      await runBudgeted(budget, async () => {
        while (!signal.aborted) {
          const claimTime = now();
          const claimed = await input.impacts.claimPartitionBatch({
            knowledgeBaseId: task.knowledgeBaseId,
            generationId: task.generationId,
            physicalPartition: task.physicalPartition,
            workerId: input.workerId,
            limit: workSettings.impactBatchSize,
            now: claimTime.toISOString(),
            staleBefore: new Date(
              claimTime.getTime() - settings.lockTtlSeconds * 1_000
            ).toISOString()
          });

          if (claimed.length === 0) {
            const status = await input.impacts.countPartitionIncomplete({
              knowledgeBaseId: task.knowledgeBaseId,
              generationId: task.generationId,
              physicalPartition: task.physicalPartition
            });
            processedCount = Math.max(processedCount, status.completed);
            if (status.failed > 0) {
              await input.subtasks.fail({
                taskId: task.id,
                workerId: input.workerId,
                processedCount,
                code: "PUBLICATION_IMPACT_FAILED",
                message: `${status.failed} publication impacts failed in the partition`,
                failedAt: now().toISOString(),
                terminal: true
              });
              return;
            }
            if (status.pending > 0 || status.running > 0) {
              budget?.recordRetry?.();
              await reschedule(task, processedCount, settings.retryDelayMs, true);
              return;
            }
            await input.subtasks.complete({
              taskId: task.id,
              workerId: input.workerId,
              processedCount,
              completedAt: now().toISOString()
            });
            return;
          }

          for (const group of groupPublicationImpacts(claimed)) {
            const result = await executePublicationImpactGroup({
              impacts: input.impacts,
              writers: input.writers,
              group,
              workerId: input.workerId,
              workSettings,
              retryDelayMs: settings.retryDelayMs,
              now
            });
            if (result.kind === "completed") {
              processedCount += result.completedCount;
              continue;
            }
            if (result.kind === "deferred" || !result.terminal) {
              budget?.recordRetry?.();
              await reschedule(task, processedCount, settings.retryDelayMs, true);
              return;
            }
            await input.subtasks.fail({
              taskId: task.id,
              workerId: input.workerId,
              processedCount,
              code: "PROJECTION_WRITE_FAILED",
              message: result.message,
              failedAt: now().toISOString(),
              terminal: true
            });
            return;
          }
        }
        await reschedule(task, processedCount, settings.retryDelayMs, true);
      });
    } catch (error) {
      if (error instanceof ImmutableObjectWriteInProgressError) {
        budget?.recordRetry?.();
        await reschedule(task, processedCount, settings.retryDelayMs, true);
        return;
      }
      if (error instanceof RoleJobFailure && error.retryable) {
        budget?.recordRetry?.();
        await reschedule(task, processedCount, settings.retryDelayMs, true);
        return;
      }
      const message = error instanceof Error ? error.message : "Publication subtask failed";
      const failure = await input.subtasks.fail({
        taskId: task.id,
        workerId: input.workerId,
        processedCount,
        code: "PUBLICATION_SUBTASK_FAILED",
        message,
        failedAt: now().toISOString(),
        terminal: error instanceof RoleJobFailure && !error.retryable
      });
      input.logger?.warn("Publication subtask failed", {
        taskId: task.id,
        generationId: task.generationId,
        terminal: failure.terminal
      });
      if (!failure.terminal) budget?.recordRetry?.();
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function reschedule(
    task: PublicationSubtask,
    processedCount: number,
    delayMs: number,
    preserveAttempt: boolean
  ): Promise<void> {
    const rescheduledAt = now();
    await input.subtasks.reschedule({
      taskId: task.id,
      workerId: input.workerId,
      processedCount,
      runAfter: new Date(rescheduledAt.getTime() + delayMs).toISOString(),
      rescheduledAt: rescheduledAt.toISOString(),
      preserveAttempt
    });
  }

  return {
    tick,
    async run(signal) {
      input.logger?.info("Publication subtask worker started", {
        workerId: input.workerId
      });
      while (!signal.aborted) {
        const processed = await tick(signal);
        if (processed === 0 && !signal.aborted) {
          const settings = await resolveSettings(input.settings);
          await sleep(settings.pollIntervalMs, signal);
        }
      }
      input.logger?.info("Publication subtask worker stopped", {
        workerId: input.workerId
      });
    }
  };
}

async function runBudgeted<T>(
  budget: SubtaskResourceBudget | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return budget ? budget.run(operation) : operation();
}

function isTerminalPhase(
  taskKind: PublicationSubtask["taskKind"]
): taskKind is "object" | "validation" | "activation" {
  return taskKind === "object" || taskKind === "validation" || taskKind === "activation";
}

async function resolveSettings(
  value: RoleWorkerSettings | (() => Promise<RoleWorkerSettings>)
): Promise<RoleWorkerSettings> {
  const settings = typeof value === "function" ? await value() : value;
  for (const [field, candidate] of Object.entries(settings)) {
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
  }
  return settings;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
