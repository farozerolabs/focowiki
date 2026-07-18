import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { ClaimedPublicationImpact, PublicationImpactRepository } from "../application/ports/publication-impact-repository.js";
import type { PublicationValidationRepository } from "../application/ports/publication-validation-repository.js";
import { RoleJobFailure, type RoleJobRecord } from "../domain/role-job.js";
import type { ImmutableObjectWriteResult } from "../publication/immutable-object-writer.js";
import { GENERATED_ROOT_MANIFEST_PATHS } from "../okf/generated-graph-resources.js";
import {
  readPublicationWorkSettings,
  type PublicationWorkSettings
} from "../publication/publication-settings-snapshot.js";

type ImpactWriter = {
  write: (impact: ClaimedPublicationImpact, settings: PublicationWorkSettings) => Promise<{
    handled: boolean;
    touchedShardCount: number;
  }>;
  writeBatch?: (
    impacts: ClaimedPublicationImpact[],
    settings: PublicationWorkSettings
  ) => Promise<{
    handled: boolean;
    touchedShardCount: number;
  }>;
};

type PublicationFinalizer = {
  finalize: (input: {
    knowledgeBaseId: string;
    generationId: string;
  }) => Promise<void>;
};

const GROUPED_PROJECTIONS = new Set([
  "directory", "search", "links", "manifest", "tree", "graph_node", "graph_edge"
]);

export function createPublicationRoleProcessor(input: {
  generations: PublicationGenerationRepository;
  impacts: PublicationImpactRepository;
  validation: PublicationValidationRepository;
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  writers: ImpactWriter[];
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
      await processImpacts({ ...input, job, generationId, workerId, signal, now, workSettings });
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
        throw retryable("GENERATION_STATE_CHANGED", "Publication generation state changed");
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
      await input.generations.failGeneration({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId,
        code: "GENERATION_VALIDATION_FAILED",
        message,
        failedAt: now().toISOString()
      });
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
      throw retryable("GENERATION_ACTIVATION_CONFLICT", "Publication activation must be retried");
    }
  };
}

async function processImpacts(input: {
  generations: PublicationGenerationRepository;
  impacts: PublicationImpactRepository;
  writers: ImpactWriter[];
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
        await failGeneration(input, "PUBLICATION_IMPACT_FAILED", `${remaining.failed} publication impacts failed`);
        throw new RoleJobFailure({
          code: "PUBLICATION_IMPACT_FAILED",
          message: "Publication impact retries are exhausted",
          retryable: false
        });
      }
      if (remaining.pending > 0 || remaining.running > 0) {
        throw retryable("PUBLICATION_IMPACT_PENDING", "Publication impacts are pending");
      }
      return;
    }

    const groups = groupImpacts(claimed);
    for (
      let groupIndex = 0;
      groupIndex < groups.length;
      groupIndex += input.workSettings.impactConcurrency
    ) {
      const groupPage = groups.slice(
        groupIndex,
        groupIndex + input.workSettings.impactConcurrency
      );
      const results = await Promise.all(groupPage.map((group) =>
        processImpactGroup(input, group)
      ));
      const failed = results.find((result) => result !== null);
      if (!failed) continue;

      const failedAt = input.now();
      await input.impacts.release({
        impactIds: groups
          .slice(groupIndex + groupPage.length)
          .flat()
          .map((impact) => impact.id),
        workerId: input.workerId,
        releasedAt: failedAt.toISOString()
      });
      if (results.some((result) => result?.terminal)) {
        await failGeneration(input, "PROJECTION_WRITE_FAILED", failed.message);
        throw new RoleJobFailure({
          code: "PROJECTION_WRITE_FAILED",
          message: failed.message,
          retryable: false,
          cause: failed.error
        });
      }
      throw retryable(
        "PROJECTION_WRITE_RETRY",
        "Projection write will be retried",
        failed.error
      );
    }
  }
  throw retryable("PUBLICATION_ABORTED", "Publication was interrupted");
}

async function processImpactGroup(
  input: Parameters<typeof processImpacts>[0],
  group: ClaimedPublicationImpact[]
): Promise<{ error: unknown; message: string; terminal: boolean } | null> {
  try {
    const result = await dispatchImpactGroup(input.writers, group, input.workSettings);
    for (let index = 0; index < group.length; index += 1) {
      const impact = group[index]!;
      await input.impacts.complete({
        knowledgeBaseId: impact.knowledgeBaseId,
        generationId: impact.generationId,
        impactId: impact.id,
        workerId: input.workerId,
        touchedShardCount: index === 0 ? result.touchedShardCount : 0,
        completedAt: input.now().toISOString()
      });
    }
    return null;
  } catch (error) {
    const failedAt = input.now();
    const message = error instanceof Error ? error.message : "Projection write failed";
    const failures = await Promise.all(group.map((impact) => input.impacts.fail({
      knowledgeBaseId: impact.knowledgeBaseId,
      generationId: impact.generationId,
      impactId: impact.id,
      workerId: input.workerId,
      code: "PROJECTION_WRITE_FAILED",
      message,
      retryCursor: impact.retryCursor,
      retryAt: new Date(failedAt.getTime() + input.retryDelayMs).toISOString(),
      failedAt: failedAt.toISOString()
    })));
    return {
      error,
      message,
      terminal: failures.some((failure) => failure.terminal)
    };
  }
}

async function dispatchImpact(
  writers: ImpactWriter[],
  impact: ClaimedPublicationImpact,
  settings: PublicationWorkSettings
): Promise<{ touchedShardCount: number }> {
  let result: { touchedShardCount: number } | null = null;
  for (const writer of writers) {
    const candidate = await writer.write(impact, settings);
    if (!candidate.handled) continue;
    if (result) throw new Error("Publication impact has multiple writers");
    result = { touchedShardCount: candidate.touchedShardCount };
  }
  if (!result && impact.projectionKind === "cleanup" && impact.action === "validate") {
    return { touchedShardCount: 0 };
  }
  if (!result) throw new Error(`Publication impact is unsupported: ${impact.projectionKind}`);
  return result;
}

async function dispatchImpactGroup(
  writers: ImpactWriter[],
  impacts: ClaimedPublicationImpact[],
  settings: PublicationWorkSettings
): Promise<{ touchedShardCount: number }> {
  if (impacts.length === 1) {
    return dispatchImpact(writers, impacts[0]!, settings);
  }
  let result: { touchedShardCount: number } | null = null;
  for (const writer of writers) {
    if (!writer.writeBatch) continue;
    const candidate = await writer.writeBatch(impacts, settings);
    if (!candidate.handled) continue;
    if (result) throw new Error("Publication impact batch has multiple writers");
    result = { touchedShardCount: candidate.touchedShardCount };
  }
  if (!result) {
    throw new Error("Publication impact batch is unsupported");
  }
  return result;
}

function groupImpacts(
  impacts: ClaimedPublicationImpact[]
): ClaimedPublicationImpact[][] {
  const groups: ClaimedPublicationImpact[][] = [];
  const byShard = new Map<string, ClaimedPublicationImpact[]>();
  for (const impact of impacts) {
    if (!GROUPED_PROJECTIONS.has(impact.projectionKind)) {
      groups.push([impact]);
      continue;
    }
    const key = `${impact.projectionKind}\u0000${impact.projectionKey}`;
    const group = byShard.get(key);
    if (group) {
      group.push(impact);
    } else {
      const created = [impact];
      byShard.set(key, created);
      groups.push(created);
    }
  }
  return groups;
}

async function failGeneration(
  input: {
    generations: PublicationGenerationRepository;
    job: RoleJobRecord;
    generationId: string;
    now: () => Date;
  },
  code: string,
  message: string
): Promise<void> {
  await input.generations.failGeneration({
    knowledgeBaseId: input.job.knowledgeBaseId,
    generationId: input.generationId,
    code,
    message,
    failedAt: input.now().toISOString()
  });
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

function retryable(code: string, message: string, cause?: unknown): RoleJobFailure {
  return new RoleJobFailure({ code, message, retryable: true, cause });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
