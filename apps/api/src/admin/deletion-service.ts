import { randomUUID } from "node:crypto";
import type { OkfLogLimits } from "@focowiki/okf";
import type { AdminRepositories } from "../db/admin-repositories.js";
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
  deleteSourcePage: (input: {
    knowledgeBaseId: string;
    logicalPath: string;
    deletedAt: string;
    generatedAt: string;
    batchSize: number;
    cursorTtlSeconds: number;
    fileProcessingConcurrency: number;
    okfLog?: Partial<OkfLogLimits> | undefined;
  }) => Promise<SourcePageDeletionResult>;
};

export type SourcePageDeletionResult =
  | {
      ok: true;
      releaseId: string;
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
  const files = repositories.files;

  if (
    !repositories.knowledgeBases.softDeleteKnowledgeBase ||
    !files?.softDeleteSourceFile ||
    !files.createRelease ||
    !files.createBundleFiles ||
    !files.createBundleTreeEntries ||
    !files.activateRelease ||
    !files.listSourceFiles ||
    !files.getBundleFile ||
    !files.createSourceFileEvent
  ) {
    return null;
  }

  const softDeleteKnowledgeBase = repositories.knowledgeBases.softDeleteKnowledgeBase;
  const softDeleteSourceFile = files.softDeleteSourceFile;
  const createRelease = files.createRelease;
  const createBundleFiles = files.createBundleFiles;
  const createBundleTreeEntries = files.createBundleTreeEntries;
  const activateRelease = files.activateRelease;
  const listSourceFiles = files.listSourceFiles;
  const listPublicationLogHistory = files.listPublicationLogHistory;
  const getBundleFile = files.getBundleFile;
  const createSourceFileEvent = files.createSourceFileEvent;

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
      await cleanupKnowledgeBaseGraph({
        repositories,
        knowledgeBaseId: knowledgeBase.id,
        batchSize: 200
      });
      return true;
    },
    async deleteSourcePage(input) {
      const knowledgeBase = await repositories.knowledgeBases.getKnowledgeBase(
        input.knowledgeBaseId
      );

      if (!knowledgeBase?.activeReleaseId) {
        return { ok: false, reason: "not_found" };
      }

      const file = await getBundleFile({
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

      const ownerId = `source-delete-${randomUUID()}`;
      const lockAcquired = await waitForPublicationLock({
        redis,
        knowledgeBaseId: knowledgeBase.id,
        ownerId,
        ttlSeconds: input.cursorTtlSeconds
      });

      if (!lockAcquired) {
        throw new Error("Knowledge base publication lock was not acquired");
      }

      try {
        await createSourceFileEvent({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: file.sourceFileId,
          stageKey: "source_deletion",
          messageKey: "sourceFiles.stage.sourceDeletion",
          startedAt: input.generatedAt,
          endedAt: null,
          severity: "info"
        });

        const deleted = await softDeleteSourceFile({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: file.sourceFileId,
          deletedAt: input.deletedAt
        });

        if (!deleted) {
          return { ok: false, reason: "not_found" };
        }
        await repositories.graph?.deleteGraphForSourceFile({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: file.sourceFileId
        });

        const releaseId = `release-${randomUUID()}`;
        const bundleRootKey = storage.keyspace.releaseRootKey(knowledgeBase.id, releaseId);
        await createRelease({
          id: releaseId,
          knowledgeBaseId: knowledgeBase.id,
          bundleRootKey,
          generatedAt: input.generatedAt,
          publishedAt: null,
          fileCount: 0,
          manifestChecksumSha256: "pending"
        });

        const publication = await publishOkfRelease({
          knowledgeBaseId: knowledgeBase.id,
          knowledgeBaseName: knowledgeBase.name,
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
                  knowledgeBaseId: knowledgeBase.id,
                  cursor,
                  limit
                })
            : undefined,
          fetchGraphEdgePage: repositories.graph
            ? ({ cursor, limit }) =>
                repositories.graph!.listGraphEdges({
                  knowledgeBaseId: knowledgeBase.id,
                  cursor,
                  limit
                })
            : undefined,
          fetchSourcePage: ({ cursor, limit }) =>
            listSourceFiles({
              knowledgeBaseId: knowledgeBase.id,
              cursor,
              limit
            }).then((page) => ({
              ...page,
              items: page.items.filter((source) => source.processingStatus === "completed")
            })),
          persistBundleFiles: (bundleFiles) => createBundleFiles(bundleFiles),
          persistBundleTreeEntries: (entries) => createBundleTreeEntries(entries)
        });
        const endedAt = new Date().toISOString();

        await activateRelease({
          knowledgeBaseId: knowledgeBase.id,
          releaseId,
          publishedAt: endedAt,
          fileCount: publication.fileCount,
          manifestChecksumSha256: publication.manifestChecksumSha256
        });
        await createSourceFileEvent({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: file.sourceFileId,
          stageKey: "source_deletion",
          messageKey: "sourceFiles.stage.sourceDeletion",
          startedAt: null,
          endedAt,
          severity: "info"
        });
        await invalidateKnowledgeBaseCaches({
          redis,
          knowledgeBaseId: knowledgeBase.id,
          releaseId,
          sourceFileId: file.sourceFileId,
          ttlSeconds: input.cursorTtlSeconds
        });

        return {
          ok: true,
          releaseId
        };
      } finally {
        await redis.releaseKnowledgeBasePublicationLock(knowledgeBase.id, ownerId);
      }
    }
  };
}

async function cleanupKnowledgeBaseGraph(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  batchSize: number;
}): Promise<void> {
  if (!input.repositories.graph || !input.repositories.files?.listSourceFiles) {
    return;
  }

  let cursor: string | null = null;

  do {
    const page = await input.repositories.files.listSourceFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.batchSize,
      cursor
    });

    for (const source of page.items) {
      await input.repositories.graph.deleteGraphForSourceFile({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: source.id
      });
    }

    cursor = page.nextCursor;
  } while (cursor);
}

async function waitForPublicationLock(input: {
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  ownerId: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.min(input.ttlSeconds * 1_000, 60_000);

  while (Date.now() <= deadline) {
    const acquired = await input.redis.acquireKnowledgeBasePublicationLock(
      input.knowledgeBaseId,
      input.ownerId,
      input.ttlSeconds
    );

    if (acquired) {
      return true;
    }

    await sleep(1_000);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
