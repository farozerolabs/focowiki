import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { PublicationImpactRepository } from "../application/ports/publication-impact-repository.js";
import type { PublicationSubtaskRepository } from "../application/ports/publication-subtask-repository.js";
import type { PublicationValidationRepository } from "../application/ports/publication-validation-repository.js";
import {
  RoleJobFailure,
  RoleJobReschedule,
  type RoleJobRecord
} from "../domain/role-job.js";
import { PublicationGenerationBusyError } from "../domain/publication.js";
import {
  ImmutableObjectWriteInProgressError,
  type ImmutableObjectWriteResult
} from "../publication/immutable-object-writer.js";
import { GENERATED_ROOT_MANIFEST_PATHS } from "../okf/generated-graph-resources.js";
import {
  readPublicationWorkSettings,
  type PublicationWorkSettings
} from "../publication/publication-settings-snapshot.js";
import { createContinuousSlotScheduler } from "./continuous-slot-scheduler.js";
import {
  executePublicationImpactGroup,
  groupPublicationImpacts,
  type PublicationImpactWriter
} from "./publication-impact-executor.js";

type PublicationImpactProcessorRepository = Omit<
  PublicationImpactRepository,
  "claimPartitionBatch" | "countPartitionIncomplete"
>;

type PublicationFinalizer = {
  finalize: (input: {
    knowledgeBaseId: string;
    generationId: string;
  }) => Promise<void>;
};

export function createPublicationRoleProcessor(input: {
  generations: PublicationGenerationRepository;
  impacts: PublicationImpactProcessorRepository;
  subtasks?: PublicationSubtaskRepository;
  validation: PublicationValidationRepository;
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  writers: PublicationImpactWriter[];
  finalizers: PublicationFinalizer[];
  impactLockTtlSeconds: number;
  retryDelayMs: number;
  validationIssueLimit: number;
  now?: () => Date;
}) {
  assertPositiveInteger(input.impactLockTtlSeconds, "impactLockTtlSeconds");
  assertPositiveInteger(input.retryDelayMs, "retryDelayMs");
  assertPositiveInteger(input.validationIssueLimit, "validationIssueLimit");
  const now = input.now ?? (() => new Date());

  return async (job: RoleJobRecord, signal: AbortSignal): Promise<void> => {
    assertPublicationJob(job);
    try {
      await processPublicationJob(input, job, signal, now);
    } catch (error) {
      if (error instanceof RoleJobReschedule) throw error;
      if (error instanceof PublicationGenerationBusyError) {
        throw continuation(now(), input.retryDelayMs);
      }
      if (error instanceof ImmutableObjectWriteInProgressError) {
        throw continuation(now(), input.retryDelayMs);
      }
      const retryable = isRetryableFailure(error);
      if (retryable && job.attemptCount < job.maxAttempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Publication retries are exhausted";
      const code = retryable
        ? "PUBLICATION_RETRIES_EXHAUSTED"
        : error instanceof RoleJobFailure
          ? error.code
          : "PUBLICATION_FAILED";
      await input.generations.failGeneration({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId: job.generationId!,
        code,
        message,
        failedAt: now().toISOString()
      });
      if (!retryable) throw error;
      throw new RoleJobFailure({
        code: "PUBLICATION_RETRIES_EXHAUSTED",
        message,
        retryable: false,
        cause: error
      });
    }
  };
}

async function processPublicationJob(
  input: Parameters<typeof createPublicationRoleProcessor>[0],
  job: RoleJobRecord,
  signal: AbortSignal,
  now: () => Date
): Promise<void> {
  const generationId = job.generationId!;
  const workerId = job.lockedBy!;
  const workSettings = readPublicationWorkSettings(job.settingsSnapshot);
  const generation = await input.generations.freezeGeneration({
    knowledgeBaseId: job.knowledgeBaseId,
    generationId,
    frozenAt: now().toISOString()
  });
  if (!generation) return;
  if (generation.state === "frozen") {
    await input.generations.markGenerationState({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId,
      expectedState: "frozen",
      state: "building",
      updatedAt: now().toISOString()
    });
  }

  if (generation.state !== "validating") {
    if (input.subtasks) {
      await input.subtasks.ensureGenerationTasks({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId,
        settingsSnapshot: job.settingsSnapshot,
        maxAttempts: Math.max(3, job.maxAttempts),
        createdAt: now().toISOString()
      });
      const status = await input.subtasks.getGenerationStatus({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId
      });
      if (status.failed > 0) {
        throw new RoleJobFailure({
          code: "PUBLICATION_SUBTASK_FAILED",
          message: `${status.failed} publication partition tasks failed`,
          retryable: false
        });
      }
      if (status.remaining > 0) {
        throw continuation(now(), input.retryDelayMs);
      }
      return;
    } else {
      await processImpacts({ ...input, job, generationId, workerId, signal, now, workSettings });
    }
    for (const finalizer of input.finalizers) {
      await finalizer.finalize({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId
      });
    }
    const transitioned = await input.generations.markGenerationState({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId,
      expectedState: "building",
      state: "validating",
      updatedAt: now().toISOString()
    });
    if (!transitioned) {
      throw continuation(now(), input.retryDelayMs);
    }
  }

  const issues = await input.validation.validateChangedClosure({
    knowledgeBaseId: job.knowledgeBaseId,
    generationId,
    issueLimit: input.validationIssueLimit
  });
  if (issues.length > 0) {
    const message = issues
      .map((issue) => `${issue.code}:${issue.reference ?? "-"}`)
      .join(", ");
    throw new RoleJobFailure({
      code: "GENERATION_VALIDATION_FAILED",
      message,
      retryable: false
    });
  }

  const roots = [];
  for (const path of GENERATED_ROOT_MANIFEST_PATHS) {
    const reference = await input.references.findStagedByRef({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId,
      refKind: "root",
      refKey: path
    }) ?? await input.references.findActiveByRef({
      knowledgeBaseId: job.knowledgeBaseId,
      refKind: "root",
      refKey: path
    });
    if (!reference) {
      throw new RoleJobFailure({
        code: "ROOT_REFERENCE_MISSING",
        message: `Required root reference is unavailable: ${path}`,
        retryable: false
      });
    }
    roots.push({
      path,
      checksumSha256: reference.checksumSha256,
      objectKey: reference.objectKey,
      contentType: reference.contentType,
      sizeBytes: reference.sizeBytes
    });
  }
  const manifest = await input.immutableObjects.write({
    body: `${JSON.stringify({
      formatVersion: 1,
      knowledgeBaseId: job.knowledgeBaseId,
      generationId,
      predecessorGenerationId: generation.predecessorGenerationId,
      roots
    })}\n`,
    contentType: "application/json; charset=utf-8"
  });
  await input.references.stageUpsert({
    knowledgeBaseId: job.knowledgeBaseId,
    generationId,
    refKind: "generation_manifest",
    refKey: "root",
    fileId: `generation-manifest-${generationId}`,
    checksumSha256: manifest.checksumSha256,
    formatVersion: manifest.formatVersion,
    logicalPath: null,
    sourceFileId: null,
    projectionShardId: null
  });
  const activated = await input.generations.activateGeneration({
    knowledgeBaseId: job.knowledgeBaseId,
    generationId,
    expectedPredecessorGenerationId: generation.predecessorGenerationId,
    rootManifestChecksumSha256: manifest.checksumSha256,
    rootManifestObjectKey: manifest.objectKey,
    activatedAt: now().toISOString()
  });
  if (!activated) {
    throw continuation(now(), input.retryDelayMs);
  }
}

function isRetryableFailure(error: unknown): boolean {
  return !(error instanceof RoleJobFailure) || error.retryable;
}

async function processImpacts(input: {
  generations: PublicationGenerationRepository;
  impacts: PublicationImpactProcessorRepository;
  writers: PublicationImpactWriter[];
  job: RoleJobRecord;
  generationId: string;
  workerId: string;
  signal: AbortSignal;
  workSettings: PublicationWorkSettings;
  impactLockTtlSeconds: number;
  retryDelayMs: number;
  now: () => Date;
}): Promise<void> {
  while (!input.signal.aborted) {
    const claimTime = input.now();
    const claimed = await input.impacts.claimBatch({
      knowledgeBaseId: input.job.knowledgeBaseId,
      generationId: input.generationId,
      workerId: input.workerId,
      limit: input.workSettings.impactBatchSize,
      now: claimTime.toISOString(),
      staleBefore: new Date(
        claimTime.getTime() - input.impactLockTtlSeconds * 1_000
      ).toISOString()
    });
    if (claimed.length === 0) {
      const remaining = await input.impacts.countIncomplete({
        knowledgeBaseId: input.job.knowledgeBaseId,
        generationId: input.generationId
      });
      if (remaining.failed > 0) {
        throw new RoleJobFailure({
          code: "PUBLICATION_IMPACT_FAILED",
          message: `${remaining.failed} publication impacts failed`,
          retryable: false
        });
      }
      if (remaining.pending > 0 || remaining.running > 0) {
        throw continuation(input.now(), input.retryDelayMs);
      }
      return;
    }

    const scheduler = createContinuousSlotScheduler({
      concurrency: input.workSettings.impactConcurrency
    });
    const scheduled = await scheduler.run(
      groupPublicationImpacts(claimed),
      async (group) => {
        const result = await executePublicationImpactGroup({
          impacts: input.impacts,
          writers: input.writers,
          group,
          workerId: input.workerId,
          workSettings: input.workSettings,
          retryDelayMs: input.retryDelayMs,
          now: input.now
        });
        return result.kind === "completed" ? null : result;
      },
      { shouldStop: (result) => result !== null }
    );
    const interrupted = scheduled.results.filter((result) => result !== null);
    if (interrupted.length === 0) continue;

    const failedAt = input.now();
    await input.impacts.release({
      impactIds: scheduled.unstarted.flat().map((impact) => impact.id),
      workerId: input.workerId,
      releasedAt: failedAt.toISOString()
    });
    const terminal = interrupted.find((result) =>
      result.kind === "failure" && result.terminal
    );
    if (terminal) {
      throw new RoleJobFailure({
        code: "PROJECTION_WRITE_FAILED",
        message: terminal.message,
        retryable: false,
        cause: terminal.error
      });
    }
    throw new RoleJobReschedule(
      new Date(failedAt.getTime() + input.retryDelayMs).toISOString()
    );
  }
  throw continuation(input.now(), input.retryDelayMs);
}

function assertPublicationJob(job: RoleJobRecord): void {
  if (
    job.role !== "publication" || job.kind !== "generation_publication" ||
    !job.generationId || !job.lockedBy
  ) {
    throw new RoleJobFailure({
      code: "INVALID_PUBLICATION_ROLE_JOB",
      message: "Publication role job identifiers are invalid",
      retryable: false
    });
  }
}

function continuation(now: Date, delayMs: number): RoleJobReschedule {
  return new RoleJobReschedule(new Date(now.getTime() + delayMs).toISOString());
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
