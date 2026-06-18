import { randomUUID } from "node:crypto";
import {
  MetadataValidationError,
  parseUploadedMarkdownSource,
  resolveSourceMetadata,
  type OkfLogLimits,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import type {
  AdminRepositories,
  SourceFileProcessingStage,
  SourceFileRecord
} from "../db/admin-repositories.js";
import { publishOkfRelease } from "../okf/publication.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";
import { createModelInvocationTracker } from "./model-invocation-tracker.js";
import { readModelSuggestions, type ModelAssistanceOptions } from "./model-suggestions.js";
import { processSourceFileGraphStage } from "./source-file-graph-stage.js";
import {
  sourceFileStageMessageKey,
  waitForPublicationLock
} from "./source-file-processor-support.js";
import { createProgressClock, createUploadProgressTracker } from "./upload-progress.js";
import { createReleaseId } from "./upload-processor-utils.js";

export type SourceFileQueueProcessor = {
  processFile: (input: SourceFileProcessInput) => Promise<SourceFileRecord>;
};

export type SourceFileProcessInput = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sourceFileId: string;
  generatedAt: string;
  batchSize: number;
  cursorTtlSeconds: number;
  fileProcessingConcurrency: number;
  okfLog?: Partial<OkfLogLimits> | undefined;
};

export function createSourceFileQueueProcessor(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator,
  modelAssistance: ModelAssistanceOptions | null = null
): SourceFileQueueProcessor | null {
  const files = repositories.files;

  if (
    !files?.getSourceFile ||
    !files.createRelease ||
    !files.createBundleFiles ||
    !files.createBundleTreeEntries ||
    !files.activateRelease ||
    !files.listSourceFiles ||
    !files.updateSourceFileProcessingState ||
    !files.updateSourceFileMetadata ||
    !files.updateSourceFileModelSuggestions ||
    !files.createSourceFileEvent
  ) {
    return null;
  }

  const getSourceFile = files.getSourceFile;
  const createRelease = files.createRelease;
  const createBundleFiles = files.createBundleFiles;
  const createBundleTreeEntries = files.createBundleTreeEntries;
  const activateRelease = files.activateRelease;
  const listSourceFiles = files.listSourceFiles;
  const listPublicationLogHistory = files.listPublicationLogHistory;
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
      let publicationLockAcquired = false;
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

        if (source.processingStatus === "completed" || source.processingStatus === "running") {
          return source;
        }

        currentStage = "upload_storage";
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
        await mark({ status: "running", stage: currentStage, endedAt: null, errorCode: null });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: null,
          severity: "info"
        });
        const content = await storage.getObjectText(source.objectKey);

        if (content === null) {
          throw new Error("Source object was not found");
        }

        const parsed = parseUploadedMarkdownSource({
          fileName: source.originalName,
          content
        });
        await updateSourceFileMetadata({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: source.id,
          metadata: parsed.metadata
        });
        const resolved = resolveSourceMetadata({
          fileName: source.originalName,
          content,
          metadata: parsed.metadata
        });
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: progressClock(),
          severity: "info"
        });

        currentStage = "llm_suggestion";
        await mark({ status: "running", stage: currentStage, endedAt: null, errorCode: null });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: null,
          severity: "info"
        });
        const tracker = createModelInvocationTracker({
          repositories,
          knowledgeBaseId: input.knowledgeBaseId,
          modelName: modelAssistance?.modelName ?? null
        });
        const modelSource = {
          id: source.id,
          fileName: source.originalName,
          title: resolved.metadata.title,
          type: resolved.metadata.type,
          tags: Array.isArray(resolved.metadata.tags) ? resolved.metadata.tags : [],
          body: resolved.body
        };
        let suggestions: SourceModelSuggestions | null = null;

        if (modelAssistance) {
          const result = await readModelSuggestions({
            sources: [modelSource],
            modelAssistance,
            onSourceStart: async () => tracker.start(source.id, progressClock()),
            onSourceComplete: async (_source, modelResult) =>
              tracker.complete(source.id, progressClock(), modelResult)
          }).catch(async (error: unknown) => {
            await tracker.complete(source.id, progressClock(), {
              suggestions: null,
              warnings: [error instanceof Error ? error.message : "Model suggestion failed"]
            });
            throw error;
          });
          suggestions = result.suggestionsBySourceId.get(source.id) ?? null;

          if (!suggestions) {
            throw new Error("Model suggestions failed");
          }

          await updateSourceFileModelSuggestions({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceFileId: source.id,
            suggestions
          });
          await recordStage(currentStage, {
            startedAt: null,
            endedAt: progressClock(),
            severity: result.warnings.length > 0 ? "warning" : "info"
          });
        } else {
          const startedAt = progressClock();
          const endedAt = progressClock();
          await tracker.skip(source.id, startedAt, endedAt);
          await updateSourceFileModelSuggestions({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceFileId: source.id,
            suggestions: null
          });
          await recordStage(currentStage, {
            startedAt: null,
            endedAt,
            severity: "info"
          });
        }

        currentStage = "graph_generation";
        await processSourceFileGraphStage({
          repositories,
          redis,
          knowledgeBaseId: input.knowledgeBaseId,
          source,
          metadata: parsed.metadata,
          body: resolved.body,
          suggestions,
          pageSize: input.batchSize,
          ttlSeconds: input.cursorTtlSeconds,
          ownerId,
          modelAssistance,
          progressClock,
          mark,
          recordStage
        });

        currentStage = "bundle_generation";
        await mark({ status: "running", stage: currentStage, endedAt: null, errorCode: null });
        publicationLockAcquired = await waitForPublicationLock({
          redis,
          knowledgeBaseId: input.knowledgeBaseId,
          ownerId,
          ttlSeconds: input.cursorTtlSeconds
        });

        if (!publicationLockAcquired) {
          throw new Error("Knowledge base publication lock was not acquired");
        }

        const releaseId = createReleaseId();
        const bundleRootKey = storage.keyspace.releaseRootKey(input.knowledgeBaseId, releaseId);
        await createRelease({
          id: releaseId,
          knowledgeBaseId: input.knowledgeBaseId,
          bundleRootKey,
          generatedAt: input.generatedAt,
          publishedAt: null,
          fileCount: 0,
          manifestChecksumSha256: "pending"
        });
        await recordStage(currentStage, {
          startedAt: progressClock(),
          endedAt: null,
          severity: "info"
        });

        const publication = await publishOkfRelease({
          knowledgeBaseId: input.knowledgeBaseId,
          knowledgeBaseName: input.knowledgeBaseName,
          releaseId,
          generatedAt: input.generatedAt,
          pageSize: input.batchSize,
          concurrency: input.fileProcessingConcurrency,
          log: input.okfLog,
          storage,
          fetchPublicationLogHistory: listPublicationLogHistory
            ? ({ knowledgeBaseId, maxEntries }) =>
                listPublicationLogHistory({
                  knowledgeBaseId,
                  maxEntries
                })
            : undefined,
          fetchGraphNodePage: repositories.graph
            ? ({ cursor, limit }) =>
                repositories.graph!.listGraphNodes({
                  knowledgeBaseId: input.knowledgeBaseId,
                  cursor,
                  limit
                })
            : undefined,
          fetchGraphEdgePage: repositories.graph
            ? ({ cursor, limit }) =>
                repositories.graph!.listGraphEdges({
                  knowledgeBaseId: input.knowledgeBaseId,
                  cursor,
                  limit
                })
            : undefined,
          fetchSourcePage: ({ cursor, limit }) =>
            listSourceFiles({
              knowledgeBaseId: input.knowledgeBaseId,
              cursor,
              limit
            }).then((page) => ({
              ...page,
              items: page.items
                .filter(
                  (item) =>
                    item.processingStatus === "completed" || item.id === input.sourceFileId
                )
                .map((item) => ({
                  ...item,
                  metadata:
                    item.id === input.sourceFileId
                      ? (parsed.metadata as SourceMetadataDefaults)
                      : item.metadata,
                  suggestions:
                    item.id === input.sourceFileId ? suggestions : item.modelSuggestions ?? null
                }))
            })),
          persistBundleFiles: (filesToPersist) => createBundleFiles(filesToPersist),
          persistBundleTreeEntries: (entries) => createBundleTreeEntries(entries),
          onSourcePageStage: ({ sourceFileIds, stage }) =>
            sourceFileIds.includes(input.sourceFileId)
              ? mark({
                  status: "running",
                  stage,
                  endedAt: null,
                  errorCode: null
                })
              : Promise.resolve()
        });

        const publicationEndedAt = progressClock();
        await recordStage("bundle_generation", {
          startedAt: null,
          endedAt: publicationEndedAt,
          severity: "info"
        });
        await recordStage("okf_validation", {
          startedAt: null,
          endedAt: publicationEndedAt,
          severity: "info"
        });
        await recordStage("index_publication", {
          startedAt: null,
          endedAt: publicationEndedAt,
          severity: "info"
        });

        currentStage = "release_activation";
        const releaseActivationStartedAt = progressClock();
        await mark({
          status: "running",
          stage: currentStage,
          endedAt: null,
          errorCode: null
        });
        await recordStage(currentStage, {
          startedAt: releaseActivationStartedAt,
          endedAt: null,
          severity: "info"
        });

        await activateRelease({
          knowledgeBaseId: input.knowledgeBaseId,
          releaseId,
          publishedAt: releaseActivationStartedAt,
          fileCount: publication.fileCount,
          manifestChecksumSha256: publication.manifestChecksumSha256
        });

        const releaseActivationEndedAt = progressClock();
        await recordStage(currentStage, {
          startedAt: null,
          endedAt: releaseActivationEndedAt,
          severity: "info"
        });
        await mark({
          status: "completed",
          stage: currentStage,
          endedAt: releaseActivationEndedAt,
          errorCode: null
        });
        await invalidateKnowledgeBaseCaches({
          redis,
          knowledgeBaseId: input.knowledgeBaseId,
          releaseId,
          sourceFileId: input.sourceFileId,
          ttlSeconds: input.cursorTtlSeconds
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
        if (publicationLockAcquired) {
          await redis.releaseKnowledgeBasePublicationLock(input.knowledgeBaseId, ownerId);
        }
        if (sourceLockAcquired) {
          await redis.releaseSourceFileLock(input.sourceFileId, ownerId);
        }
      }
    }
  };
}
