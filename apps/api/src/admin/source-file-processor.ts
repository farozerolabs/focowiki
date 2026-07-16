import { randomUUID } from "node:crypto";
import {
  MetadataValidationError,
  type OkfLogLimits,
  type SourceModelSuggestions
} from "@focowiki/okf";
import type {
  AdminRepositories,
  SourceFileProcessingStage,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { SourceFilePublicationEligibility } from "../domain/source-file-job.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { ModelAssistanceOptions } from "./model-suggestions.js";
import type { RuntimeGraphSettings } from "../runtime-settings/types.js";
import {
  createKnowledgeBasePublicationService,
  type PublicationRuntimeOptions
} from "./publication-scheduler.js";
import { processSourceFileBundleStage } from "./source-file-bundle-stage.js";
import { processSourceFileGraphStage } from "./source-file-graph-stage.js";
import { processSourceFileMetadataStage } from "./source-file-metadata-stage.js";
import { processSourceFileModelStage } from "./source-file-model-stage.js";
import { processSourceFilePublicationStage } from "./source-file-publication-stage.js";
import { sourceFileStageMessageKey } from "./source-file-processor-support.js";
import { createProgressClock, createUploadProgressTracker } from "./upload-progress.js";

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
  knowledgeBaseName: string;
  sourceFileId: string;
  generatedAt: string;
  batchSize: number;
  cursorTtlSeconds: number;
  fileProcessingConcurrency: number;
  okfLog?: Partial<OkfLogLimits> | undefined;
  publication?: Partial<PublicationRuntimeOptions> | undefined;
  graph?: Partial<RuntimeGraphSettings> | undefined;
  modelAssistance?: ModelAssistanceOptions | null | undefined;
  publicationEligibility?: SourceFilePublicationEligibility | undefined;
};

export function createSourceFileQueueProcessor(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator,
  modelAssistance: ModelAssistanceOptions | null = null
): SourceFileQueueProcessor | null {
  const files = repositories.files;

  if (
    !files?.getSourceFileForProcessing ||
    !files.updateSourceFileProcessingState ||
    !files.updateSourceFileMetadata ||
    !files.updateSourceFileModelSuggestions ||
    !files.createSourceFileEvent ||
    !repositories.workerJobs
  ) {
    return null;
  }

  const getSourceFile = files.getSourceFileForProcessing;
  const updateSourceFileMetadata = files.updateSourceFileMetadata;
  const updateSourceFileModelSuggestions = files.updateSourceFileModelSuggestions;
  const createSourceFileEvent = files.createSourceFileEvent;
  const publicationService = createKnowledgeBasePublicationService(repositories, storage, redis);

  if (!publicationService) {
    return null;
  }

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
        errorCode?: string | null;
        errorMessage?: string | null;
      }) => {
        await progress.markFile({
          sourceFileId: input.sourceFileId,
          status: update.status ?? "running",
          stage: update.stage,
          startedAt: update.startedAt ?? null,
          endedAt: update.endedAt ?? null,
          errorCode: update.errorCode ?? null,
          errorMessage: update.errorMessage ?? null
        });
      };

      const recordStage = async (stage: SourceFileProcessingStage, event: {
        startedAt: string | null;
        endedAt: string | null;
        severity: "info" | "warning" | "error";
      }) => {
        await createSourceFileEvent({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId,
          stageKey: stage,
          messageKey: sourceFileStageMessageKey(stage),
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          severity: event.severity
        });
        await redis.recordSourceFileEvent(
          input.sourceFileId,
          {
            knowledgeBaseId: input.knowledgeBaseId,
            stage,
            severity: event.severity
          },
          input.cursorTtlSeconds
        );
      };

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
        await mark({
          status: "running",
          stage: currentStage,
          startedAt: progressClock(),
          endedAt: null,
          errorCode: null
        });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: progressClock(),
          severity: "info"
        });

        currentStage = "metadata_resolution";
        await assertSourceFileProcessingEligible();
        await mark({ status: "running", stage: currentStage, endedAt: null, errorCode: null });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: null,
          severity: "info"
        });
        const metadataResult = await processSourceFileMetadataStage({
          storage,
          knowledgeBaseId: input.knowledgeBaseId,
          source,
          updateSourceFileMetadata
        });
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: progressClock(),
          severity: "info"
        });

        currentStage = "llm_suggestion";
        await assertSourceFileProcessingEligible();
        await mark({ status: "running", stage: currentStage, endedAt: null, errorCode: null });
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
          recordStage
        });

        currentStage = "bundle_generation";
        await assertSourceFileProcessingEligible();
        await processSourceFileBundleStage({
          progressClock,
          mark,
          recordStage
        });

        currentStage = "index_publication";
        await assertSourceFileProcessingEligible();
        await processSourceFilePublicationStage({
          publicationService,
          knowledgeBaseId: input.knowledgeBaseId,
          knowledgeBaseName: input.knowledgeBaseName,
          sourceFileId: source.id,
          relatedSourceFileIds: graphStageResult.affectedSourceFileIds.filter(
            (sourceFileId) => sourceFileId !== source.id
          ),
          generatedAt: input.generatedAt,
          pageSize: input.batchSize,
          cursorTtlSeconds: input.cursorTtlSeconds,
          fileProcessingConcurrency: input.fileProcessingConcurrency,
          okfLog: input.okfLog,
          options: resolvePublicationOptions(input),
          eligibility: input.publicationEligibility ?? "import",
          progressClock,
          mark,
          recordStage
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
        const errorCode =
          error instanceof MetadataValidationError
            ? "METADATA_VALIDATION_FAILED"
            : currentStage === "llm_suggestion"
              ? "MODEL_SUGGESTION_FAILED"
              : currentStage === "graph_generation"
                ? "GRAPH_GENERATION_FAILED"
              : "SOURCE_FILE_PROCESSING_FAILED";
        const message = error instanceof Error ? error.message : "Source file processing failed";
        await mark({
          status: "failed",
          stage: currentStage,
          endedAt: failedAt,
          errorCode,
          errorMessage: message
        }).catch(() => undefined);
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: failedAt,
          severity: "error"
        }).catch(() => undefined);
        throw error;
      } finally {
        if (sourceLockAcquired) {
          await redis.releaseSourceFileLock(input.sourceFileId, ownerId);
        }
      }

      async function assertSourceFileProcessingEligible(): Promise<void> {
        const currentKnowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
          input.knowledgeBaseId
        );

        if (!currentKnowledgeBase) {
          throw new SourceFileProcessingCancelledError();
        }

        const currentSource = await getSourceFile({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId
        });

        if (!currentSource || currentSource.deletedAt || currentSource.taskDeletedAt) {
          throw new SourceFileProcessingCancelledError();
        }
      }
    }
  };
}

function resolvePublicationOptions(input: SourceFileProcessInput): PublicationRuntimeOptions {
  return {
    mode: input.publication?.mode ?? "batch",
    batchSize: input.publication?.batchSize ?? input.batchSize,
    intervalSeconds: input.publication?.intervalSeconds ?? 300,
    indexShardSize: input.publication?.indexShardSize ?? 1_000,
    linkIndexShardSize: input.publication?.linkIndexShardSize ?? 1_000,
    manifestShardSize: input.publication?.manifestShardSize ?? 1_000,
    graphMaintenanceBatchSize: input.publication?.graphMaintenanceBatchSize ?? 500,
    rootSummaryLimit: input.publication?.rootSummaryLimit ?? 500,
    directoryIndexMaxEntries: input.publication?.directoryIndexMaxEntries ?? 200,
    directoryIndexMaxBytes: input.publication?.directoryIndexMaxBytes ?? 65_536
  };
}
