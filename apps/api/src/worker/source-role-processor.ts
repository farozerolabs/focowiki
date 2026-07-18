import type { SourceFileQueueProcessor } from "../admin/source-file-processor.js";
import { SourceFileProcessingCancelledError } from "../admin/source-file-processor.js";
import { SourceFileAttemptError } from "../application/source-file-failure.js";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import { RoleJobFailure, type RoleJobRecord } from "../domain/role-job.js";
import { createModelAssistanceFromRuntimeSettings } from "../runtime-settings/model-assistance.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { ImpactPlannerConfig } from "../publication/impact-planner.js";
import { processResourceOperationJob } from "./resource-operation-jobs.js";

export function createSourceRoleProcessor(input: {
  config: RuntimeConfig;
  repositories: AdminRepositories;
  processor: SourceFileQueueProcessor;
  runtimeSettings: RuntimeSettingsService;
  roleJobs: Pick<RoleJobRepository, "enqueue" | "cancelSourceJobsForDeletionIntent">;
  generations: Pick<PublicationGenerationRepository, "commitMutation">;
  impactPlanner: ImpactPlannerConfig;
  cleanupObjectKeys: (keys: string[]) => Promise<void>;
}) {
  return async (job: RoleJobRecord): Promise<void> => {
    if (job.role === "source" && job.kind === "resource_operation") {
      const snapshot = await input.runtimeSettings.getSnapshot();
      const result = await processResourceOperationJob({
        job,
        repositories: input.repositories,
        roleJobs: input.roleJobs,
        generations: input.generations,
        impactPlanner: input.impactPlanner,
        sourceJobMaxAttempts: snapshot.worker.jobMaxAttempts,
        publicationJobMaxAttempts: snapshot.worker.jobMaxAttempts,
        databaseBatchSize: snapshot.worker.hardDeleteDatabaseBatchSize
      });
      await input.cleanupObjectKeys(result.cleanupObjectKeys);
      return;
    }
    if (
      job.role !== "source"
      || job.kind !== "source_processing"
      || !job.sourceFileId
      || !job.sourceRevisionId
    ) {
      throw new RoleJobFailure({
        code: "INVALID_SOURCE_ROLE_JOB",
        message: "Source role job identifiers are invalid",
        retryable: false
      });
    }
    const knowledgeBase = await input.repositories.knowledgeBases.getKnowledgeBase(
      job.knowledgeBaseId
    );
    if (!knowledgeBase) {
      return;
    }
    const snapshot = await input.runtimeSettings.getSnapshot();

    try {
      await input.processor.processFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: job.sourceFileId,
        sourceRevisionId: job.sourceRevisionId,
        generatedAt: new Date().toISOString(),
        batchSize: snapshot.worker.generationBatchSize,
        cursorTtlSeconds: input.config.pagination.cursorTtlSeconds,
        graph: snapshot.graph,
        modelAssistance: createModelAssistanceFromRuntimeSettings(snapshot),
        publicationSettingsSnapshot: {
          publication: snapshot.publication,
          graph: snapshot.graph
        },
        publicationMaxAttempts: snapshot.worker.jobMaxAttempts,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts
      });
    } catch (error) {
      if (error instanceof SourceFileProcessingCancelledError) {
        return;
      }
      if (error instanceof SourceFileAttemptError) {
        throw new RoleJobFailure({
          code: error.failure.code,
          message: error.failure.message,
          retryable: error.automaticRetryAllowed,
          cause: error
        });
      }
      throw error;
    }
  };
}
