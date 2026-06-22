import { randomUUID } from "node:crypto";
import type { OkfGraphLimits, OkfLogLimits } from "@focowiki/okf";
import type {
  AdminRepositories,
  PublicationJobReason,
  PublicationJobMode,
  SourceFileRecord
} from "../db/admin-repositories.js";
import { publishOkfRelease } from "../okf/publication.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";
import { createReleaseId } from "./upload-processor-utils.js";

export type PublicationRuntimeOptions = {
  mode: PublicationJobMode;
  batchSize: number;
  intervalSeconds: number;
  indexShardSize: number;
  graphEdgeShardSize: number;
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

type BatchIntervalPublicationInput = Omit<
  Parameters<KnowledgeBasePublicationService["publishNow"]>[0],
  "reason"
>;

const pendingBatchPublicationTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
        scheduleBatchIntervalPublication({
          service,
          publishInput: input,
          countDirtySourceFiles,
          dirtyCount: dirty.count,
          oldestDirtyAt: dirty.oldestDirtyAt
        });
        return { published: false, releaseId: null };
      }

      const result = await service.publishNow({
        ...input,
        reason
      });

      const nextDirty = await countDirtySourceFiles({
        knowledgeBaseId: input.knowledgeBaseId
      });
      scheduleBatchIntervalPublication({
        service,
        publishInput: input,
        countDirtySourceFiles,
        dirtyCount: nextDirty.count,
        oldestDirtyAt: nextDirty.oldestDirtyAt
      });

      return result;
    },
    async publishNow(input) {
      clearBatchPublicationTimer(input.knowledgeBaseId);
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
            pageSize: input.pageSize
          });

          if (dirtySourceIds.length === 0 && !input.allowEmptyPublication) {
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
              graph: publicationGraphLimits(input.options),
              fetchPublicationLogHistory: ({ knowledgeBaseId, maxEntries }) =>
                listPublicationLogHistory({
                  knowledgeBaseId,
                  maxEntries
                }),
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
                  items: page.items.filter((item) => item.processingStatus === "completed")
                })),
              persistBundleFiles: (filesToPersist) => createBundleFiles(filesToPersist),
              persistBundleTreeEntries: (entries) => createBundleTreeEntries(entries)
            });
            const endedAt = new Date().toISOString();

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
              visibleAt: endedAt
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
              scheduleBatchIntervalPublication({
                service,
                publishInput: input,
                countDirtySourceFiles,
                dirtyCount: dirty.count,
                oldestDirtyAt: dirty.oldestDirtyAt
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

function scheduleBatchIntervalPublication(input: {
  service: KnowledgeBasePublicationService;
  publishInput: BatchIntervalPublicationInput;
  countDirtySourceFiles: NonNullable<
    NonNullable<AdminRepositories["files"]>["countDirtySourceFiles"]
  >;
  dirtyCount: number;
  oldestDirtyAt: string | null;
}) {
  if (
    input.publishInput.options.mode !== "batch" ||
    input.dirtyCount === 0 ||
    !input.oldestDirtyAt ||
    input.publishInput.options.intervalSeconds <= 0
  ) {
    return;
  }

  clearBatchPublicationTimer(input.publishInput.knowledgeBaseId);
  const intervalMs = input.publishInput.options.intervalSeconds * 1_000;
  const dueAtMs = Date.parse(input.oldestDirtyAt) + intervalMs;
  const delayMs = Math.max(0, dueAtMs - Date.now());
  const timer = setTimeout(() => {
    pendingBatchPublicationTimers.delete(input.publishInput.knowledgeBaseId);
    void publishScheduledBatchInterval(input);
  }, delayMs);

  pendingBatchPublicationTimers.set(input.publishInput.knowledgeBaseId, timer);
}

async function publishScheduledBatchInterval(input: {
  service: KnowledgeBasePublicationService;
  publishInput: BatchIntervalPublicationInput;
  countDirtySourceFiles: NonNullable<
    NonNullable<AdminRepositories["files"]>["countDirtySourceFiles"]
  >;
}) {
  const result = await input.service
    .publishNow({
      ...input.publishInput,
      generatedAt: new Date().toISOString(),
      reason: "batch_interval"
    })
    .catch(() => ({ published: false, releaseId: null }));

  if (result.published) {
    return;
  }

  const dirty = await input
    .countDirtySourceFiles({ knowledgeBaseId: input.publishInput.knowledgeBaseId })
    .catch(() => ({ count: 0, oldestDirtyAt: null }));

  if (dirty.count === 0) {
    return;
  }

  scheduleBatchIntervalPublication({
    ...input,
    dirtyCount: dirty.count,
    oldestDirtyAt: dirty.oldestDirtyAt
  });
}

function clearBatchPublicationTimer(knowledgeBaseId: string) {
  const timer = pendingBatchPublicationTimers.get(knowledgeBaseId);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  pendingBatchPublicationTimers.delete(knowledgeBaseId);
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

  if (input.mode === "batch") {
    return "batch_interval";
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
}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;

  do {
    const page = await input.listDirtySourceFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.pageSize,
      cursor
    });
    ids.push(...page.items.map((source) => source.id));
    cursor = page.nextCursor;
  } while (cursor);

  return ids;
}

function isIntervalDue(oldestDirtyAt: string, generatedAt: string, intervalSeconds: number): boolean {
  return Date.parse(generatedAt) - Date.parse(oldestDirtyAt) >= intervalSeconds * 1_000;
}

function publicationGraphLimits(options: PublicationRuntimeOptions): OkfGraphLimits {
  return {
    edgeShardSize: options.graphEdgeShardSize
  };
}
