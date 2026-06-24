import type { OkfLogLimits } from "@focowiki/okf";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "./cache-invalidation.js";
import type { PublicationRuntimeOptions } from "./publication-scheduler.js";

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
    publication: PublicationRuntimeOptions;
  }) => Promise<SourcePageDeletionResult>;
};

export type SourcePageDeletionResult =
  | {
      ok: true;
      publicationQueued: true;
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
    !files.listSourceFiles ||
    !files.getBundleFile ||
    !files.createSourceFileEvent ||
    !repositories.workerJobs
  ) {
    return null;
  }

  const softDeleteKnowledgeBase = repositories.knowledgeBases.softDeleteKnowledgeBase;
  const softDeleteSourceFile = files.softDeleteSourceFile;
  const listSourceFiles = files.listSourceFiles;
  const getBundleFile = files.getBundleFile;
  const createSourceFileEvent = files.createSourceFileEvent;
  const workerJobs = repositories.workerJobs;

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

      await workerJobs.enqueuePublicationJob({
        knowledgeBaseId: knowledgeBase.id,
        reason: "deletion",
        runAfter: input.generatedAt,
        maxAttempts: input.publication.workerJobMaxAttempts ?? 3
      });

      await createSourceFileEvent({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: file.sourceFileId,
        stageKey: "source_deletion",
        messageKey: "sourceFiles.stage.sourceDeletion",
        startedAt: null,
        endedAt: new Date().toISOString(),
        severity: "info"
      });
      await invalidateKnowledgeBaseCaches({
        redis,
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        sourceFileId: file.sourceFileId,
        ttlSeconds: input.cursorTtlSeconds
      });

      return {
        ok: true,
        publicationQueued: true
      };
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
