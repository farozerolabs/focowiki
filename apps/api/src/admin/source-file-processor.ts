import { randomUUID } from "node:crypto";
import { type SourceModelSuggestions } from "@focowiki/okf";
import type {
  AdminRepositories,
  SourceFileProcessingStage,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import {
  createSourceProcessingFailure,
  SourceFileAttemptError
} from "../application/source-file-failure.js";
import type { SourceFileTerminalFailure } from "../domain/source-file-lifecycle.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { ModelAssistanceOptions } from "./model-suggestions.js";
import {
  SourceRevisionSupersededError,
  type SourceProcessingCompletion
} from "../application/source-processing-completion.js";
import type { RuntimeGraphSettings } from "../runtime-settings/types.js";
import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
import { processSourceFileGraphStage } from "./source-file-graph-stage.js";
import { processSourceFileMetadataStage } from "./source-file-metadata-stage.js";
import { processSourceFileModelStage } from "./source-file-model-stage.js";
import { readSourceFileContent } from "./source-file-storage-stage.js";
import { createProgressClock, createUploadProgressTracker } from "./upload-progress.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";
import { createSourceFileStageRecorder } from "./source-file-stage-recorder.js";

export type SourceFileQueueProcessor = {
  processFile: (input: SourceFileProcessInput) => Promise<SourceFileRecord>;
};

export class SourceFileProcessingCancelledError extends Error {
  public constructor(message = "Source file processing was cancelled.") {
    super(message);
    this.name = "SourceFileProcessingCancelledError";
  }
}

export type SourceFileProcessInput = {
  knowledgeBaseId: string;
  sourceFileId: string;
  generatedAt: string;
  batchSize: number;
  cursorTtlSeconds: number;
  graph?: Partial<RuntimeGraphSettings> | undefined;
  modelAssistance?: ModelAssistanceOptions | null | undefined;
  attemptCount?: number | undefined;
  maxAttempts?: number | undefined;
  sourceRevisionId?: string | undefined;
  publicationSettingsSnapshot?: SerializableJson | undefined;
  publicationMaxAttempts?: number | undefined;
};

export function createSourceFileQueueProcessor(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator,
  completion: SourceProcessingCompletion,
  modelAssistance: ModelAssistanceOptions | null = null,
  resourceBudgets?: {
    sourceObjectRead: ResourceBudget;
    graphQuery: ResourceBudget;
    databaseMutation: ResourceBudget;
  }
): SourceFileQueueProcessor | null {
  const files = repositories.files;

  if (
    !files?.getSourceFileForProcessing ||
    !files.updateSourceFileProcessingState ||
    !files.updateSourceFileMetadata ||
    !files.updateSourceFileModelSuggestions ||
    !files.createSourceFileEvent
  ) {
    return null;
  }

  const getSourceFile = files.getSourceFileForProcessing;
  const updateSourceFileMetadata = files.updateSourceFileMetadata;
  const updateSourceFileModelSuggestions = files.updateSourceFileModelSuggestions;
  const createSourceFileEvent = files.createSourceFileEvent;
  return {
    async processFile(input) {
      const ownerId = `source-worker-${randomUUID()}`;
      const progressClock = createProgressClock(input.generatedAt);
      const progress = createUploadProgressTracker({
        repositories,
        redis,
        knowledgeBaseId: input.knowledgeBaseId,
        ttlSeconds: input.cursorTtlSeconds
      });
      let sourceLockAcquired = false;
      let currentStage: SourceFileProcessingStage = "upload_storage";

      const mark = async (update: {
        status: SourceFileRecord["processingStatus"];
        stage: SourceFileProcessingStage;
        startedAt?: string | null;
        endedAt?: string | null;
        terminalFailure?: SourceFileTerminalFailure | null;
      }) => {
        await progress.markFile({
          sourceFileId: input.sourceFileId,
          status: update.status ?? "running",
          stage: update.stage,
          startedAt: update.startedAt ?? null,
          endedAt: update.endedAt ?? null,
          terminalFailure: update.terminalFailure ?? null
        });
      };

      const recordStage = createSourceFileStageRecorder({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        ttlSeconds: input.cursorTtlSeconds,
        createEvent: createSourceFileEvent,
        recordRedisEvent: (value, ttlSeconds) => redis.recordSourceFileEvent(
          {
            knowledgeBaseId: input.knowledgeBaseId,
            sourceFileId: input.sourceFileId
          },
          value,
          ttlSeconds
        )
      });

      try {
        sourceLockAcquired = await redis.acquireSourceFileLock(
          input.sourceFileId,
          ownerId,
          input.cursorTtlSeconds
        );

        const source = await getSourceFile({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId
        });

        if (!source) {
          throw new Error("Source file was not found");
        }

        if (!sourceLockAcquired) {
          return source;
        }

        if (source.processingStatus === "completed") {
          return source;
        }

        currentStage = "upload_storage";
        await assertSourceFileProcessingEligible();
        const uploadStartedAt = progressClock();
        await mark({
          status: "running",
          stage: currentStage,
          startedAt: uploadStartedAt,
          endedAt: null
        });
        const content = await runBudgeted(
          resourceBudgets?.sourceObjectRead,
          () => readSourceFileContent({ storage, source })
        );
        await recordStage(currentStage, {
          startedAt: uploadStartedAt,
          endedAt: progressClock(),
          severity: "info"
        });

        currentStage = "metadata_resolution";
        await mark({ status: "running", stage: currentStage, endedAt: null });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: null,
          severity: "info"
        });
        const metadataResult = await processSourceFileMetadataStage({
          knowledgeBaseId: input.knowledgeBaseId,
          source,
          content,
          updateSourceFileMetadata
        });
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: progressClock(),
          severity: "info"
        });

        currentStage = "llm_suggestion";
        await mark({ status: "running", stage: currentStage, endedAt: null });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: null,
          severity: "info"
        });
        const modelSource = {
          id: source.id,
          fileName: source.relativePath,
          title: metadataResult.resolved.metadata.title,
          type: metadataResult.resolved.metadata.type,
          tags: Array.isArray(metadataResult.resolved.metadata.tags)
            ? metadataResult.resolved.metadata.tags
            : [],
          body: metadataResult.resolved.body
        };
        let suggestions: SourceModelSuggestions | null = null;
        const effectiveModelAssistance = input.modelAssistance ?? modelAssistance;
        const modelResult = await processSourceFileModelStage({
          repositories,
          knowledgeBaseId: input.knowledgeBaseId,
          source,
          modelSource,
          modelAssistance: effectiveModelAssistance,
          progressClock,
          updateSourceFileModelSuggestions
        });
        suggestions = modelResult.suggestions;
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: modelResult.endedAt,
          severity: modelResult.severity
        });

        currentStage = "graph_generation";
        await assertSourceFileProcessingEligible();
        const graphStageResult = await processSourceFileGraphStage({
          repositories,
          redis,
          knowledgeBaseId: input.knowledgeBaseId,
          source,
          metadata: metadataResult.parsed.metadata,
          body: metadataResult.resolved.body,
          suggestions,
          pageSize: input.batchSize,
          maxCandidateNodes: input.graph?.candidateLimit,
          acceptedEdgeLimit: input.graph?.acceptedEdgeLimit,
          genericPhraseThreshold: input.graph?.genericPhraseThreshold,
          ttlSeconds: input.cursorTtlSeconds,
          ownerId,
          modelAssistance: input.graph?.modelReviewEnabled === false ? null : effectiveModelAssistance,
          progressClock,
          mark,
          recordStage,
          ...(resourceBudgets?.graphQuery
            ? { graphQueryBudget: resourceBudgets.graphQuery }
            : {}),
          ...(resourceBudgets?.databaseMutation
            ? { databaseMutationBudget: resourceBudgets.databaseMutation }
            : {})
        });

        if (!input.sourceRevisionId) {
          throw new Error("Source revision ID is required");
        }
        const sourceRevisionId = input.sourceRevisionId;
        currentStage = "projection_generation";
        const completionStartedAt = progressClock();
        await mark({ status: "running", stage: currentStage, endedAt: null });
        await recordStage(currentStage, {
          startedAt: completionStartedAt,
          endedAt: null,
          severity: "info"
        });
        try {
          await runBudgeted(resourceBudgets?.databaseMutation, () => completion.complete({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceFileId: source.id,
            sourceRevisionId,
            graphNeighborSourceFileIds: graphStageResult.affectedSourceFileIds.filter(
              (sourceFileId) => sourceFileId !== source.id
            ),
            graphEdgeIds: graphStageResult.edgeIds,
            removedGraphEdgeIds: graphStageResult.removedEdgeIds,
            publicationSettingsSnapshot: input.publicationSettingsSnapshot,
            publicationMaxAttempts: input.publicationMaxAttempts,
            completedAt: progressClock()
          }));
        } catch (error) {
          if (error instanceof SourceRevisionSupersededError) {
            throw new SourceFileProcessingCancelledError();
          }
          throw error;
        }
        const completedAt = progressClock();
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: completedAt,
          severity: "info"
        });

        const completedSource = await getSourceFile({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId
        });

        if (!completedSource) {
          throw new Error("Completed source file was not found");
        }

        return completedSource;
      } catch (error) {
        if (error instanceof SourceFileProcessingCancelledError) {
          throw error;
        }

        const failedAt = progressClock();
        const terminalFailure = createSourceProcessingFailure({
          stage: currentStage,
          error,
          occurredAt: failedAt,
          correlationId: ownerId
        });
        const automaticRetryAllowed = terminalFailure.retryKind === "source_processing";
        const terminal = !automaticRetryAllowed
          || (input.attemptCount ?? 1) >= (input.maxAttempts ?? 1);
        await mark({
          status: terminal ? "failed" : "queued",
          stage: currentStage,
          endedAt: failedAt,
          terminalFailure: terminal ? terminalFailure : null
        }).catch(() => undefined);
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: failedAt,
          severity: terminal ? "error" : "warning"
        }).catch(() => undefined);
        throw new SourceFileAttemptError(terminalFailure, automaticRetryAllowed, {
          cause: error
        });
      } finally {
        if (sourceLockAcquired) {
          await redis.releaseSourceFileLock(input.sourceFileId, ownerId);
        }
      }

      async function assertSourceFileProcessingEligible(): Promise<void> {
        if (!input.sourceRevisionId) {
          throw new Error("Source revision ID is required");
        }
        try {
          await completion.assertCurrent({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceFileId: input.sourceFileId,
            sourceRevisionId: input.sourceRevisionId
          });
        } catch (error) {
          if (error instanceof SourceRevisionSupersededError) {
            throw new SourceFileProcessingCancelledError();
          }
          throw error;
        }
      }
    }
  };
}

function runBudgeted<T>(budget: ResourceBudget | undefined, operation: () => Promise<T>): Promise<T> {
  return budget ? budget.run(operation) : operation();
}
