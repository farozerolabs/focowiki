import { randomUUID } from "node:crypto";
import type {
  AdminRepositories,
  BundleFileRecord,
  KnowledgeBaseRecord,
  UploadTaskEventRecord,
  UploadTaskRecord
} from "../db/admin-repositories.js";
import { publishOkfRelease } from "../okf/publication.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";

export type AdminDeletionService = {
  deleteKnowledgeBase: (input: {
    knowledgeBaseId: string;
    deletedAt: string;
    cursorTtlSeconds: number;
  }) => Promise<boolean>;
  createSourcePageDeletionTask: (input: {
    knowledgeBaseId: string;
    logicalPath: string;
  }) => Promise<SourcePageDeletionStartResult>;
  processSourcePageDeletion: (input: {
    knowledgeBase: KnowledgeBaseRecord;
    file: BundleFileRecord;
    task: UploadTaskRecord;
    deletedAt: string;
    generatedAt: string;
    batchSize: number;
    cursorTtlSeconds: number;
    fileProcessingConcurrency: number;
  }) => Promise<UploadTaskRecord>;
};

export type SourcePageDeletionStartResult =
  | {
      ok: true;
      knowledgeBase: KnowledgeBaseRecord;
      file: BundleFileRecord;
      task: UploadTaskRecord;
    }
  | {
      ok: false;
      reason: "not_found" | "not_deletable";
    };

export function createDeletionService(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator
): AdminDeletionService | null {
  const filesRepository = repositories.files;
  const taskRepository = repositories.tasks;

  if (
    !repositories.knowledgeBases.softDeleteKnowledgeBase ||
    !filesRepository?.softDeleteSourceFile ||
    !filesRepository.createRelease ||
    !filesRepository.createBundleFiles ||
    !filesRepository.createBundleTreeEntries ||
    !filesRepository.activateRelease ||
    !filesRepository.listSourceFiles ||
    !taskRepository?.createUploadTask ||
    !taskRepository.completeUploadTask ||
    !taskRepository.createUploadTaskEvent
  ) {
    return null;
  }

  const softDeleteKnowledgeBase = repositories.knowledgeBases.softDeleteKnowledgeBase;
  const softDeleteSourceFile = filesRepository.softDeleteSourceFile;
  const createRelease = filesRepository.createRelease;
  const createBundleFiles = filesRepository.createBundleFiles;
  const createBundleTreeEntries = filesRepository.createBundleTreeEntries;
  const activateRelease = filesRepository.activateRelease;
  const listSourceFiles = filesRepository.listSourceFiles;
  const createUploadTask = taskRepository.createUploadTask;
  const completeUploadTask = taskRepository.completeUploadTask;

  return {
    async deleteKnowledgeBase(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        input.knowledgeBaseId
      );

      if (!knowledgeBase) {
        return false;
      }

      const deleted = await softDeleteKnowledgeBase({
        id: input.knowledgeBaseId,
        deletedAt: input.deletedAt
      });

      if (!deleted) {
        return false;
      }

      await invalidateKnowledgeBaseCaches({
        redis,
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        ttlSeconds: input.cursorTtlSeconds
      });
      return true;
    },
    async createSourcePageDeletionTask(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        input.knowledgeBaseId
      );

      if (!knowledgeBase?.activeReleaseId) {
        return { ok: false, reason: "not_found" };
      }

      const file = await filesRepository.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath: input.logicalPath
      });

      if (!file) {
        return { ok: false, reason: "not_found" };
      }

      if (file.fileKind !== "page" || !file.sourceFileId) {
        return { ok: false, reason: "not_deletable" };
      }

      const task = await createUploadTask({
        knowledgeBaseId: knowledgeBase.id,
        sourceCount: 1,
        operation: "delete_source"
      });

      return { ok: true, knowledgeBase, file, task };
    },
    async processSourcePageDeletion(input) {
      const ownerId = `admin-api-${randomUUID()}`;
      let lockAcquired = false;
      let releaseId: string | null = null;

      try {
        lockAcquired = await redis.acquireTaskLock(
          input.task.id,
          ownerId,
          input.cursorTtlSeconds
        );

        if (!lockAcquired) {
          throw new Error("Deletion task lock is already held");
        }

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "source_deletion",
          startedAt: input.generatedAt,
          endedAt: null,
          severity: "info"
        });

        const deleted = await softDeleteSourceFile({
          knowledgeBaseId: input.knowledgeBase.id,
          sourceFileId: input.file.sourceFileId ?? "",
          deletedAt: input.deletedAt
        });

        if (!deleted) {
          throw new Error("Source file was not deleted");
        }

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "source_deletion",
          startedAt: input.generatedAt,
          endedAt: new Date().toISOString(),
          severity: "info"
        });

        releaseId = createReleaseId();
        const bundleRootKey = storage.keyspace.releaseRootKey(input.knowledgeBase.id, releaseId);

        await createRelease({
          id: releaseId,
          knowledgeBaseId: input.knowledgeBase.id,
          taskId: input.task.id,
          bundleRootKey,
          generatedAt: input.generatedAt,
          publishedAt: null,
          fileCount: 0,
          manifestChecksumSha256: "pending"
        });

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "bundle_generation",
          startedAt: input.generatedAt,
          endedAt: null,
          severity: "info"
        });

        const publication = await publishOkfRelease({
          knowledgeBaseId: input.knowledgeBase.id,
          releaseId,
          taskId: input.task.id,
          generatedAt: input.generatedAt,
          pageSize: input.batchSize,
          concurrency: input.fileProcessingConcurrency,
          storage,
          fetchSourcePage: ({ cursor, limit }) =>
            listSourceFiles({
              knowledgeBaseId: input.knowledgeBase.id,
              cursor,
              limit
            }),
          persistBundleFiles: (files) => createBundleFiles(files),
          persistBundleTreeEntries: (entries) => createBundleTreeEntries(entries)
        });

        const endedAt = new Date().toISOString();
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "okf_validation",
          startedAt: input.generatedAt,
          endedAt,
          severity: "info"
        });
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "bundle_generation",
          startedAt: input.generatedAt,
          endedAt,
          severity: "info"
        });
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "index_publication",
          startedAt: input.generatedAt,
          endedAt,
          severity: "info"
        });

        await activateRelease({
          knowledgeBaseId: input.knowledgeBase.id,
          releaseId,
          taskId: input.task.id,
          publishedAt: endedAt,
          fileCount: publication.fileCount,
          manifestChecksumSha256: publication.manifestChecksumSha256
        });

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "release_activation",
          startedAt: input.generatedAt,
          endedAt,
          severity: "info"
        });

        const completedTask = await completeUploadTask({
          knowledgeBaseId: input.knowledgeBase.id,
          taskId: input.task.id,
          endedAt,
          resultReleaseId: releaseId
        });

        await redis.recordTaskEvent(
          input.task.id,
          {
            knowledgeBaseId: input.knowledgeBase.id,
            lifecycle: "ended"
          },
          input.cursorTtlSeconds
        );
        await invalidateKnowledgeBaseCaches({
          redis,
          knowledgeBaseId: input.knowledgeBase.id,
          releaseId,
          taskId: input.task.id,
          ttlSeconds: input.cursorTtlSeconds
        });

        return completedTask;
      } catch (error) {
        const endedAt = new Date().toISOString();
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: releaseId ? "bundle_generation" : "source_deletion",
          startedAt: input.generatedAt,
          endedAt,
          severity: "error"
        }).catch(() => undefined);
        await completeUploadTask({
          knowledgeBaseId: input.knowledgeBase.id,
          taskId: input.task.id,
          endedAt,
          resultReleaseId: null,
          internalErrorCode: "SOURCE_DELETION_FAILED",
          internalErrorMessage: "Deletion failed"
        }).catch(() => undefined);
        await redis
          .recordTaskEvent(
            input.task.id,
            {
              knowledgeBaseId: input.knowledgeBase.id,
              lifecycle: "ended"
            },
            input.cursorTtlSeconds
          )
          .catch(() => undefined);
        await invalidateKnowledgeBaseCaches({
          redis,
          knowledgeBaseId: input.knowledgeBase.id,
          releaseId: input.knowledgeBase.activeReleaseId,
          taskId: input.task.id,
          ttlSeconds: input.cursorTtlSeconds
        }).catch(() => undefined);
        throw error;
      } finally {
        if (lockAcquired) {
          await redis.releaseTaskLock(input.task.id, ownerId);
        }
      }
    }
  };
}

async function recordTaskPhase(options: {
  taskRepository: NonNullable<AdminRepositories["tasks"]>;
  taskId: string;
  phaseKey: string;
  startedAt: string | null;
  endedAt: string | null;
  severity: UploadTaskEventRecord["severity"];
}): Promise<void> {
  if (!options.taskRepository.createUploadTaskEvent) {
    return;
  }

  await options.taskRepository.createUploadTaskEvent({
    taskId: options.taskId,
    phaseKey: options.phaseKey,
    messageKey: `tasks.phase.${toCamelCase(options.phaseKey)}`,
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    severity: options.severity
  });
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function createReleaseId(): string {
  return `release-${randomUUID()}`;
}
