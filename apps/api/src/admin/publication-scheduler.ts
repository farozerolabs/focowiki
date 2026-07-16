import { randomUUID } from "node:crypto";
import type { OkfGraphLimits, OkfLogLimits } from "@focowiki/okf";
import type {
  AdminRepositories,
  PublicationJobReason,
  PublicationJobMode
} from "../db/admin-repositories.js";
import type { ReleaseSourceFileRecord } from "../application/ports/release-publication-repository.js";
import { assertReleaseCandidate } from "../application/release-candidate-validation.js";
import { publishOkfRelease, type SourceFileForPublication } from "../okf/publication.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";
import { createReleaseId } from "./upload-processor-utils.js";
import { PublicationCatalogStaleError } from "../domain/publication.js";
import type { SourceFilePublicationEligibility } from "../domain/source-file-job.js";

export type PublicationRuntimeOptions = {
  mode: PublicationJobMode;
  batchSize: number;
  intervalSeconds: number;
  indexShardSize: number;
  linkIndexShardSize: number;
  manifestShardSize: number;
  graphMaintenanceBatchSize: number;
  rootSummaryLimit: number;
  directoryIndexMaxEntries?: number;
  directoryIndexMaxBytes?: number;
  graphCandidateLimit?: number;
  graphEdgeShardSize?: number;
  graphPublicationShardSize?: number;
  graphInsightEnabled?: boolean;
  workerJobMaxAttempts?: number;
};

export type KnowledgeBasePublicationService = {
  markSourceFileReady: (input: {
    knowledgeBaseId: string;
    knowledgeBaseName: string;
    sourceFileId: string;
    relatedSourceFileIds?: string[] | undefined;
    generatedAt: string;
    pageSize: number;
    cursorTtlSeconds: number;
    fileProcessingConcurrency: number;
    okfLog?: Partial<OkfLogLimits> | undefined;
    options: PublicationRuntimeOptions;
    eligibility: SourceFilePublicationEligibility;
  }) => Promise<{ published: boolean; releaseId: string | null; catalogGeneration: number | null }>;
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
    targetCatalogGeneration: number;
    allowEmptyPublication?: boolean | undefined;
  }) => Promise<{ published: boolean; releaseId: string | null; catalogGeneration: number | null }>;
};

export function createKnowledgeBasePublicationService(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator
): KnowledgeBasePublicationService | null {
  const files = repositories.files;
  const releasePublication = repositories.releasePublication;

  if (
    !files?.createRelease ||
    !files.createBundleFiles ||
    !files.activateRelease ||
    !releasePublication ||
    !files.listPublicationLogHistory ||
    !files.markSourceFilesPublicationDirty ||
    !files.countDirtySourceFiles ||
    !files.listDirtySourceFiles ||
    !files.markSourceFilesPublicationFailed ||
    !files.createPublicationJob ||
    !files.startPublicationJob ||
    !files.completePublicationJob ||
    !files.failPublicationJob ||
    !files.rebuildBundleGraphSearchDocuments ||
    !files.rebuildReleaseGraphProjection ||
    !files.refreshReleaseReadSummary
  ) {
    return null;
  }

  const createRelease = files.createRelease;
  const createBundleFiles = files.createBundleFiles;
  const activateRelease = files.activateRelease;
  const listPublicationLogHistory = files.listPublicationLogHistory;
  const rebuildBundleGraphSearchDocuments = files.rebuildBundleGraphSearchDocuments;
  const rebuildReleaseGraphProjection = files.rebuildReleaseGraphProjection;
  const refreshReleaseReadSummary = files.refreshReleaseReadSummary;
  const markSourceFilesPublicationDirty = files.markSourceFilesPublicationDirty;
  const countDirtySourceFiles = files.countDirtySourceFiles;
  const listDirtySourceFiles = files.listDirtySourceFiles;
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
        sourceFileIds: Array.from(
          new Set([input.sourceFileId, ...(input.relatedSourceFileIds ?? [])])
        ),
        dirtyAt: input.generatedAt
      });

      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        input.knowledgeBaseId
      );

      if (!knowledgeBase) {
        return { published: false, releaseId: null, catalogGeneration: null };
      }
      const targetCatalogGeneration = requireCatalogGeneration(knowledgeBase.catalogGeneration);

      if (input.eligibility === "interactive") {
        await workerJobs?.enqueuePublicationJob({
          knowledgeBaseId: input.knowledgeBaseId,
          reason: "manual",
          targetCatalogGeneration,
          runAfter: input.generatedAt,
          maxAttempts: input.options.workerJobMaxAttempts ?? 3,
          forceSuccessor: true
        });
        return { published: false, releaseId: null, catalogGeneration: null };
      }

      const dirty = await countDirtySourceFiles({
        knowledgeBaseId: input.knowledgeBaseId
      });

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
          generatedAt: input.generatedAt,
          targetCatalogGeneration
        });
        return { published: false, releaseId: null, catalogGeneration: null };
      }

      if (workerJobs) {
        await workerJobs.enqueuePublicationJob({
          knowledgeBaseId: input.knowledgeBaseId,
          reason,
          targetCatalogGeneration,
          runAfter: input.generatedAt,
          maxAttempts: input.options.workerJobMaxAttempts ?? 3
        });
      }

      return { published: false, releaseId: null, catalogGeneration: null };
    },
    async publishNow(input) {
      const ownerId = `publication-worker-${randomUUID()}`;
      const lockAcquired = await redis.acquireKnowledgeBasePublicationLock(
        input.knowledgeBaseId,
        ownerId,
        input.cursorTtlSeconds
      );

      if (!lockAcquired) {
        return { published: false, releaseId: null, catalogGeneration: null };
      }

      try {
        let nextReason: PublicationJobReason | null = input.reason;
        let result: {
          published: boolean;
          releaseId: string | null;
          catalogGeneration: number | null;
        } = {
          published: false,
          releaseId: null,
          catalogGeneration: null
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
          const committedCatalogGeneration = requireCatalogGeneration(
            knowledgeBase.catalogGeneration
          );
          if (committedCatalogGeneration < input.targetCatalogGeneration) {
            throw new PublicationCatalogStaleError();
          }
          const releaseCatalogGeneration = input.targetCatalogGeneration;

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
              catalogGeneration: releaseCatalogGeneration,
              generatedAt: input.generatedAt,
              publishedAt: null,
              fileCount: 0,
              manifestChecksumSha256: "pending"
            });
            const snapshot = await releasePublication.materializeSourceSnapshot({
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId,
              publicationSourceFileIds: dirtySourceIds
            });
            const releaseChangeSummary = await releasePublication.summarizeChanges({
              knowledgeBaseId: input.knowledgeBaseId,
              previousReleaseId,
              releaseId,
              directoryLimit: 20
            });

            const publication = await publishOkfRelease({
              knowledgeBaseId: input.knowledgeBaseId,
              knowledgeBaseName: knowledgeBase.name,
              knowledgeBaseDescription: knowledgeBase.description,
              releaseId,
              generatedAt: input.generatedAt,
              pageSize: input.pageSize,
              concurrency: input.fileProcessingConcurrency,
              sourceFileCount: snapshot.sourceFileCount,
              log: input.okfLog,
              storage,
              indexShardSize: input.options.indexShardSize,
              linkIndexShardSize: input.options.linkIndexShardSize,
              manifestShardSize: input.options.manifestShardSize,
              rootSummaryLimit: input.options.rootSummaryLimit,
              directoryIndexMaxEntries: input.options.directoryIndexMaxEntries,
              directoryIndexMaxBytes: input.options.directoryIndexMaxBytes,
              graph: publicationGraphLimits(input.options),
              dirtySourceFileIds: dirtySourceIds,
              releaseChangeSummary,
              fetchReleaseChangePage: ({ cursor, limit }) =>
                releasePublication.listChanges({
                  knowledgeBaseId: input.knowledgeBaseId,
                  previousReleaseId,
                  releaseId,
                  cursor,
                  limit
                }),
              fetchPublicationLogHistory: ({ knowledgeBaseId, maxEntries }) =>
                listPublicationLogHistory({
                  knowledgeBaseId,
                  maxEntries
                }),
              fetchReusablePages: previousReleaseId
                ? (sourceFileIds) => releasePublication.listReusablePages({
                    knowledgeBaseId: input.knowledgeBaseId,
                    releaseId: previousReleaseId,
                    candidateReleaseId: releaseId,
                    sourceFileIds
                  })
                : undefined,
              fetchGraphNodePage: repositories.graph?.listActiveGraphNodes
                ? ({ cursor, limit }) =>
                    repositories.graph!.listActiveGraphNodes!({
                      knowledgeBaseId: input.knowledgeBaseId,
                      releaseId,
                      cursor,
                      limit
                    })
                : undefined,
              fetchGraphEdgePage: repositories.graph?.listActiveGraphEdges
                ? ({ cursor, limit }) =>
                    repositories.graph!.listActiveGraphEdges!({
                      knowledgeBaseId: input.knowledgeBaseId,
                      releaseId,
                      cursor,
                      limit
                    })
                : undefined,
              fetchSourceGraphNeighborhood: ({ sourceFileId, limit }) =>
                releasePublication.listSourceGraphNeighborhood({
                  knowledgeBaseId: input.knowledgeBaseId,
                  releaseId,
                  sourceFileId,
                  limit
                }).then((relationships) => ({ sourceFileId, relationships })),
              fetchGraphNeighborhood: repositories.graph?.listActiveGraphNeighborhood
                ? ({ sourceFileId, limit }) =>
                    repositories.graph!
                      .listActiveGraphNeighborhood!({
                        knowledgeBaseId: input.knowledgeBaseId,
                        releaseId,
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
              materializeGraphProjection: () => rebuildReleaseGraphProjection({
                knowledgeBaseId: input.knowledgeBaseId,
                releaseId
              }).then(() => undefined),
              fetchSourcePage: ({ cursor, limit }) =>
                releasePublication.listSourceFiles({
                  knowledgeBaseId: input.knowledgeBaseId,
                  releaseId,
                  cursor,
                  limit
                }).then((page) => ({
                  ...page,
                  items: page.items.map(toSourceFileForPublication)
                })),
              fetchNavigationEntryPage: ({ cursor, limit }) =>
                releasePublication.listNavigationEntries({
                  knowledgeBaseId: input.knowledgeBaseId,
                  releaseId,
                  cursor,
                  limit
                }),
              persistBundleFiles: (filesToPersist) => createBundleFiles(filesToPersist),
              persistMarkdownLinks: (links) => releasePublication.persistMarkdownLinks({
                knowledgeBaseId: input.knowledgeBaseId,
                releaseId,
                links
              }),
              copyReusableMarkdownLinks: previousReleaseId
                ? (sourceFileIds) => releasePublication.copyReusableMarkdownLinks({
                    knowledgeBaseId: input.knowledgeBaseId,
                    previousReleaseId,
                    releaseId,
                    sourceFileIds
                  })
                : async () => undefined,
              pruneInvalidSourceMarkdownLinks: ({ plannedTargetPaths, batchSize }) =>
                releasePublication.pruneInvalidSourceMarkdownLinks({
                  knowledgeBaseId: input.knowledgeBaseId,
                  releaseId,
                  plannedTargetPaths,
                  batchSize
                }),
              fetchMarkdownLinkPage: ({ cursor, limit, plannedTargetPaths }) =>
                releasePublication.listValidMarkdownLinks({
                  knowledgeBaseId: input.knowledgeBaseId,
                  releaseId,
                  cursor,
                  limit,
                  plannedTargetPaths
                }),
              materializeBundleTree: () => releasePublication.materializeTree({
                knowledgeBaseId: input.knowledgeBaseId,
                releaseId
              })
            });
            await rebuildBundleGraphSearchDocuments({
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId
            });
            await refreshReleaseReadSummary({
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId
            });
            await files.finalizeReleaseSearchIndexes?.({
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId
            });
            await assertReleaseCandidate({
              repository: releasePublication,
              knowledgeBaseId: input.knowledgeBaseId,
              releaseId,
              requireGraph: true
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

            result = {
              published: true,
              releaseId,
              catalogGeneration: releaseCatalogGeneration
            };
            const dirty = await countDirtySourceFiles({
              knowledgeBaseId: input.knowledgeBaseId
            });
            const latestKnowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
              input.knowledgeBaseId
            );
            if (latestKnowledgeBase) {
              await enqueuePendingPublicationWorkerJob({
                workerJobs,
                knowledgeBaseId: input.knowledgeBaseId,
                options: input.options,
                dirtyCount: dirty.count,
                oldestDirtyAt: dirty.oldestDirtyAt,
                generatedAt: input.generatedAt,
                targetCatalogGeneration: requireCatalogGeneration(
                  latestKnowledgeBase.catalogGeneration
                )
              });
            }
            nextReason = null;
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
  targetCatalogGeneration: number;
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
    targetCatalogGeneration: input.targetCatalogGeneration,
    runAfter: next.runAfter,
    maxAttempts: input.options.workerJobMaxAttempts ?? 3
  });
}

function requireCatalogGeneration(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new Error("Knowledge base catalog generation is invalid.");
  }
  return value as number;
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

export function toSourceFileForPublication(
  file: ReleaseSourceFileRecord
): SourceFileForPublication {
  return {
    id: file.sourceFileId,
    name: file.name,
    relativePath: file.relativePath,
    generatedPath: file.generatedPath,
    objectKey: file.objectKey,
    metadata: file.metadata,
    suggestions: file.suggestions,
    publicationRequired: file.publicationRequired
  };
}

function publicationGraphLimits(options: PublicationRuntimeOptions): OkfGraphLimits {
  return {
    pageRelatedLimit: Math.min(options.graphCandidateLimit ?? 200, 50),
    perFileLimit: options.graphCandidateLimit ?? 200,
    edgeShardSize: options.graphPublicationShardSize ?? options.graphEdgeShardSize ?? 5_000,
    insightEnabled: options.graphInsightEnabled ?? true
  };
}
