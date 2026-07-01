import { randomUUID } from "node:crypto";
import type { OkfGraphLimits, OkfLogLimits } from "@focowiki/okf";
import type {
  AdminRepositories,
  BundleFileRecord,
  PublicationJobReason,
  PublicationJobMode,
  SourceFileRecord
} from "../db/admin-repositories.js";
import {
  publishOkfRelease,
  type PreviousBundleFileForPublication,
  type SourceFileForPublication
} from "../okf/publication.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";
import { createReleaseId } from "./upload-processor-utils.js";

export type PublicationRuntimeOptions = {
  mode: PublicationJobMode;
  batchSize: number;
  intervalSeconds: number;
  indexShardSize: number;
  linkIndexShardSize: number;
  manifestShardSize: number;
  graphEdgeShardSize: number;
  graphCandidateLimit: number;
  graphMaintenanceBatchSize: number;
  rootSummaryLimit: number;
  workerJobMaxAttempts?: number;
};

export type KnowledgeBasePublicationService = {
  markSourceFileReady: (input: {
    knowledgeBaseId: string;
    knowledgeBaseName: string;
    sourceFileId: string;
    generatedAt: string;
    pageSize: number;
    cursorTtlSeconds: number;
    fileProcessingConcurrency: number;
    okfLog?: Partial<OkfLogLimits> | undefined;
    options: PublicationRuntimeOptions;
  }) => Promise<{ published: boolean; releaseId: string | null }>;
  publishNow: (input: {
    knowledgeBaseId: string;
    knowledgeBaseName: string;
    generatedAt: string;
    pageSize: number;
    cursorTtlSeconds: number;
    fileProcessingConcurrency: number;
    okfLog?: Partial<OkfLogLimits> | undefined;
    options: PublicationRuntimeOptions;
    reason: PublicationJobReason;
    allowEmptyPublication?: boolean | undefined;
  }) => Promise<{ published: boolean; releaseId: string | null }>;
};

export function createKnowledgeBasePublicationService(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator
): KnowledgeBasePublicationService | null {
  const files = repositories.files;

  if (
    !files?.createRelease ||
    !files.createBundleFiles ||
    !files.createBundleTreeEntries ||
    !files.activateRelease ||
    !files.listSourceFiles ||
    !files.listPublicationLogHistory ||
    !files.markSourceFilesPublicationDirty ||
    !files.countDirtySourceFiles ||
    !files.listDirtySourceFiles ||
    !files.markSourceFilesPublicationVisible ||
    !files.markSourceFilesPublicationFailed ||
    !files.createPublicationJob ||
    !files.startPublicationJob ||
    !files.completePublicationJob ||
    !files.failPublicationJob
  ) {
    return null;
  }

  const createRelease = files.createRelease;
  const createBundleFiles = files.createBundleFiles;
  const createBundleTreeEntries = files.createBundleTreeEntries;
  const activateRelease = files.activateRelease;
  const listSourceFiles = files.listSourceFiles;
  const listBundleFiles = files.listBundleFiles;
  const listPublicationLogHistory = files.listPublicationLogHistory;
  const markSourceFilesPublicationDirty = files.markSourceFilesPublicationDirty;
  const countDirtySourceFiles = files.countDirtySourceFiles;
  const listDirtySourceFiles = files.listDirtySourceFiles;
  const markSourceFilesPublicationVisible = files.markSourceFilesPublicationVisible;
  const markSourceFilesPublicationFailed = files.markSourceFilesPublicationFailed;
  const createSourceFileEvent = files.createSourceFileEvent;
  const createPublicationJob = files.createPublicationJob;
  const startPublicationJob = files.startPublicationJob;
  const completePublicationJob = files.completePublicationJob;
  const failPublicationJob = files.failPublicationJob;
  const workerJobs = repositories.workerJobs ?? null;

  const service: KnowledgeBasePublicationService = {
    async markSourceFileReady(input) {
      await markSourceFilesPublicationDirty({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileIds: [input.sourceFileId],
        dirtyAt: input.generatedAt
      });

      const dirty = await countDirtySourceFiles({
        knowledgeBaseId: input.knowledgeBaseId
      });
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        input.knowledgeBaseId
      );

      if (!knowledgeBase) {
        return { published: false, releaseId: null };
      }

      const reason = resolvePublicationReason({
        mode: input.options.mode,
        dirtyCount: dirty.count,
        batchSize: input.options.batchSize,
        oldestDirtyAt: dirty.oldestDirtyAt,
        generatedAt: input.generatedAt,
        intervalSeconds: input.options.intervalSeconds,
        hasActiveRelease: Boolean(knowledgeBase?.activeReleaseId)
      });

      if (!reason) {
        await enqueuePendingPublicationWorkerJob({
          workerJobs,
          knowledgeBaseId: input.knowledgeBaseId,
          options: input.options,
          dirtyCount: dirty.count,
          oldestDirtyAt: dirty.oldestDirtyAt,
          generatedAt: input.generatedAt
        });
        return { published: false, releaseId: null };
      }

      if (workerJobs) {
        await workerJobs.enqueuePublicationJob({
          knowledgeBaseId: input.knowledgeBaseId,
          reason,
          runAfter: input.generatedAt,
          maxAttempts: input.options.workerJobMaxAttempts ?? 3
        });
      }

      return { published: false, releaseId: null };
    },
    async publishNow(input) {
      const ownerId = `publication-worker-${randomUUID()}`;
      const lockAcquired = await redis.acquireKnowledgeBasePublicationLock(
        input.knowledgeBaseId,
        ownerId,
        input.cursorTtlSeconds
      );

      if (!lockAcquired) {
        return { published: false, releaseId: null };
      }

      try {
        let nextReason: PublicationJobReason | null = input.reason;
        let result: { published: boolean; releaseId: string | null } = {
          published: false,
          releaseId: null
        };

        while (nextReason) {
          const dirtySourceIds = await collectDirtySourceFileIds({
            listDirtySourceFiles,
            knowledgeBaseId: input.knowledgeBaseId,
            pageSize: input.pageSize,
            maxSourceFiles: publicationSourceLimit(input.options, nextReason)
          });

          if (dirtySourceIds.length === 0 && !input.allowEmptyPublication) {
            return result;
          }

          const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
            input.knowledgeBaseId
          );

          if (!knowledgeBase) {
            return result;
          }

          const job = await createPublicationJob({
            id: `publication-job-${randomUUID()}`,
            knowledgeBaseId: input.knowledgeBaseId,
            mode: input.options.mode,
            reason: nextReason,
            dirtySourceCount: dirtySourceIds.length
          });
          const startedAt = new Date().toISOString();
          const startedJob = await startPublicationJob({
            id: job.id,
            startedAt
          });

          if (!startedJob) {
            return result;
          }

          try {
            const previousReleaseId = knowledgeBase.activeReleaseId ?? null;
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

            const publication = await publishOkfRelease({
              knowledgeBaseId: input.knowledgeBaseId,
              knowledgeBaseName: input.knowledgeBaseName,
              releaseId,
              generatedAt: input.generatedAt,
              pageSize: input.pageSize,
              concurrency: input.fileProcessingConcurrency,
              log: input.okfLog,
              storage,
              indexShardSize: input.options.indexShardSize,
              linkIndexShardSize: input.options.linkIndexShardSize,
              manifestShardSize: input.options.manifestShardSize,
              rootSummaryLimit: input.options.rootSummaryLimit,
              graph: publicationGraphLimits(input.options),
              dirtySourceFileIds: dirtySourceIds.length > 0 ? dirtySourceIds : undefined,
              fetchPublicationLogHistory: ({ knowledgeBaseId, maxEntries }) =>
                listPublicationLogHistory({
                  knowledgeBaseId,
                  maxEntries
                }),
              fetchPreviousBundleFilePage: previousReleaseId
                ? ({ cursor, limit }) =>
                    listBundleFiles({
                      knowledgeBaseId: input.knowledgeBaseId,
                      releaseId: previousReleaseId,
                      cursor,
                      limit
                    }).then((page) => ({
                      ...page,
                      items: page.items.map(toPreviousBundleFileForPublication)
                    }))
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
              fetchGraphNeighborhood: repositories.graph
                ? ({ sourceFileId, limit }) =>
                    repositories.graph!
                      .listGraphNeighborhood({
                        knowledgeBaseId: input.knowledgeBaseId,
                        sourceFileId,
                        limit,
                        cursor: null
                      })
                      .then((page) => ({
                        sourceFileId,
                        relationships: page.items.map((relationship) => ({
                          fileId: relationship.fileId,
                          path: relationship.path,
                          title: relationship.title,
                          relationType: relationship.relationType,
                          direction: relationship.direction,
                          weight: relationship.weight,
                          reason: relationship.reason,
                          source: relationship.source,
                          ...(relationship.evidence ? { evidence: relationship.evidence } : {})
                        }))
                      }))
                : undefined,
              fetchSourcePage: ({ cursor, limit }) =>
                listSourceFiles({
                  knowledgeBaseId: input.knowledgeBaseId,
                  cursor,
                  limit
                }).then((page) => ({
                  ...page,
                  items: page.items
                    .filter((item) => item.processingStatus === "completed")
                    .map(toSourceFileForPublication)
                })),
              persistBundleFiles: (filesToPersist) => createBundleFiles(filesToPersist),
              persistBundleTreeEntries: (entries) => createBundleTreeEntries(entries)
            });
            const endedAt = new Date().toISOString();
            const activeKnowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
              input.knowledgeBaseId
            );

            if (!activeKnowledgeBase) {
              await failPublicationJob({
                id: job.id,
                endedAt,
                errorCode: "KNOWLEDGE_BASE_DELETED",
                errorMessage: "Knowledge base was deleted before release activation."
              }).catch(() => undefined);
              return result;
            }

            await activateRelease({
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId,
              publishedAt: endedAt,
              fileCount: publication.fileCount,
              manifestChecksumSha256: publication.manifestChecksumSha256
            });
            await markSourceFilesPublicationVisible({
              knowledgeBaseId: input.knowledgeBaseId,
              sourceFileIds: dirtySourceIds,
              generatedOutputs: publication.generatedSourceFileOutputs,
              visibleAt: endedAt
            });
            await repositories.graph?.refreshGraphSummariesForSourceFiles?.({
              knowledgeBaseId: input.knowledgeBaseId,
              sourceFileIds: dirtySourceIds,
              limit: 3
            });
            if (createSourceFileEvent) {
              for (const sourceFileId of dirtySourceIds) {
                await createSourceFileEvent({
                  knowledgeBaseId: input.knowledgeBaseId,
                  sourceFileId,
                  stageKey: "release_activation",
                  messageKey: "source_file.stage.release_activation.completed",
                  startedAt: endedAt,
                  endedAt,
                  severity: "info"
                });
              }
            }
            await completePublicationJob({
              id: job.id,
              releaseId,
              endedAt
            });
            await invalidateKnowledgeBaseCaches({
              redis,
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId,
              ttlSeconds: input.cursorTtlSeconds
            });

            result = { published: true, releaseId };
            const dirty = await countDirtySourceFiles({
              knowledgeBaseId: input.knowledgeBaseId
            });
            nextReason = resolveLockedContinuationReason({
              mode: input.options.mode,
              dirtyCount: dirty.count,
              batchSize: input.options.batchSize,
              oldestDirtyAt: dirty.oldestDirtyAt,
              generatedAt: input.generatedAt,
              intervalSeconds: input.options.intervalSeconds
            });

            if (!nextReason) {
              await enqueuePendingPublicationWorkerJob({
                workerJobs,
                knowledgeBaseId: input.knowledgeBaseId,
                options: input.options,
                dirtyCount: dirty.count,
                oldestDirtyAt: dirty.oldestDirtyAt,
                generatedAt: input.generatedAt
              });
            }
          } catch (error) {
            const endedAt = new Date().toISOString();
            const message = error instanceof Error ? error.message : "Publication failed";
            await markSourceFilesPublicationFailed({
              knowledgeBaseId: input.knowledgeBaseId,
              sourceFileIds: dirtySourceIds,
              errorCode: "PUBLICATION_FAILED",
              errorMessage: message
            }).catch(() => undefined);
            await failPublicationJob({
              id: job.id,
              endedAt,
              errorCode: "PUBLICATION_FAILED",
              errorMessage: message
            }).catch(() => undefined);
            throw error;
          }
        }

        return result;
      } finally {
        await redis.releaseKnowledgeBasePublicationLock(input.knowledgeBaseId, ownerId);
      }
    }
  };

  return service;
}

export async function enqueuePendingPublicationWorkerJob(input: {
  workerJobs: AdminRepositories["workerJobs"] | null;
  knowledgeBaseId: string;
  options: PublicationRuntimeOptions;
  dirtyCount: number;
  oldestDirtyAt: string | null;
  generatedAt: string;
}): Promise<void> {
  if (!input.workerJobs || input.dirtyCount === 0 || input.options.mode === "manual") {
    return;
  }

  const next = resolvePendingPublicationJob(input);

  if (!next) {
    return;
  }

  await input.workerJobs.enqueuePublicationJob({
    knowledgeBaseId: input.knowledgeBaseId,
    reason: next.reason,
    runAfter: next.runAfter,
    maxAttempts: input.options.workerJobMaxAttempts ?? 3
  });
}

function resolvePendingPublicationJob(input: {
  options: PublicationRuntimeOptions;
  dirtyCount: number;
  oldestDirtyAt: string | null;
  generatedAt: string;
}): { reason: PublicationJobReason; runAfter: string } | null {
  if (input.options.mode === "per_file") {
    return { reason: "per_file", runAfter: input.generatedAt };
  }

  if (input.dirtyCount >= input.options.batchSize) {
    return { reason: "batch_threshold", runAfter: input.generatedAt };
  }

  if (!input.oldestDirtyAt || input.options.intervalSeconds <= 0) {
    return null;
  }

  const intervalMs = input.options.intervalSeconds * 1_000;
  return {
    reason: "batch_interval",
    runAfter: new Date(Date.parse(input.oldestDirtyAt) + intervalMs).toISOString()
  };
}

function resolvePublicationReason(input: {
  mode: PublicationJobMode;
  dirtyCount: number;
  batchSize: number;
  oldestDirtyAt: string | null;
  generatedAt: string;
  intervalSeconds: number;
  hasActiveRelease: boolean;
}): PublicationJobReason | null {
  if (input.mode === "manual") {
    return null;
  }

  if (input.mode === "per_file") {
    return "per_file";
  }

  if (!input.hasActiveRelease) {
    return "bootstrap";
  }

  if (input.dirtyCount >= input.batchSize) {
    return "batch_threshold";
  }

  if (input.oldestDirtyAt && isIntervalDue(input.oldestDirtyAt, input.generatedAt, input.intervalSeconds)) {
    return "batch_interval";
  }

  return null;
}

function resolveLockedContinuationReason(input: {
  mode: PublicationJobMode;
  dirtyCount: number;
  batchSize: number;
  oldestDirtyAt: string | null;
  generatedAt: string;
  intervalSeconds: number;
}): PublicationJobReason | null {
  if (input.mode === "manual" || input.dirtyCount === 0) {
    return null;
  }

  if (input.mode === "per_file") {
    return "per_file";
  }

  if (input.dirtyCount >= input.batchSize) {
    return "batch_threshold";
  }

  if (input.oldestDirtyAt && isIntervalDue(input.oldestDirtyAt, input.generatedAt, input.intervalSeconds)) {
    return "batch_interval";
  }

  return null;
}

async function collectDirtySourceFileIds(input: {
  listDirtySourceFiles: NonNullable<
    NonNullable<AdminRepositories["files"]>["listDirtySourceFiles"]
  >;
  knowledgeBaseId: string;
  pageSize: number;
  maxSourceFiles: number;
}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;

  do {
    const remaining = input.maxSourceFiles - ids.length;

    if (remaining <= 0) {
      break;
    }

    const page = await input.listDirtySourceFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: Math.min(input.pageSize, remaining),
      cursor
    });
    ids.push(...page.items.map((source) => source.id));
    cursor = page.nextCursor;
  } while (cursor && ids.length < input.maxSourceFiles);

  return ids;
}

function publicationSourceLimit(
  options: PublicationRuntimeOptions,
  reason: PublicationJobReason
): number {
  if (options.mode === "per_file" || reason === "per_file") {
    return 1;
  }

  return Math.max(1, options.batchSize);
}

function isIntervalDue(oldestDirtyAt: string, generatedAt: string, intervalSeconds: number): boolean {
  return Date.parse(generatedAt) - Date.parse(oldestDirtyAt) >= intervalSeconds * 1_000;
}

function toPreviousBundleFileForPublication(
  file: BundleFileRecord
): PreviousBundleFileForPublication {
  return {
    sourceFileId: file.sourceFileId,
    fileKind: file.fileKind,
    logicalPath: file.logicalPath,
    objectKey: file.objectKey,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    okfType: file.okfType,
    title: file.title,
    description: file.description,
    tags: file.tags,
    frontmatter: file.frontmatter
  };
}

export function toSourceFileForPublication(file: SourceFileRecord): SourceFileForPublication {
  return {
    id: file.id,
    originalName: file.originalName,
    objectKey: file.objectKey,
    metadata: file.metadata,
    suggestions: file.modelSuggestions ?? null
  };
}

function publicationGraphLimits(options: PublicationRuntimeOptions): OkfGraphLimits {
  return {
    pageRelatedLimit: Math.min(options.graphCandidateLimit, 50),
    perFileLimit: options.graphCandidateLimit,
    edgeShardSize: options.graphEdgeShardSize
  };
}
