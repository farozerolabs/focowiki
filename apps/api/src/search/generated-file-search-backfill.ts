import type { AdminRepositories } from "../db/admin-repositories.js";
import { createGeneratedFileSearchDocument } from "./generated-file-search-documents.js";
import type { RuntimeLogger } from "../logger.js";

export type GeneratedFileSearchIndexBackfillOptions = {
  repositories: AdminRepositories;
  logger: RuntimeLogger;
  pageSize?: number;
};

export type GeneratedFileSearchIndexBackfillResult = {
  knowledgeBaseCount: number;
  releaseCount: number;
  fileCount: number;
};

const DEFAULT_PAGE_SIZE = 500;

export async function backfillGeneratedFileSearchDocuments(
  options: GeneratedFileSearchIndexBackfillOptions
): Promise<GeneratedFileSearchIndexBackfillResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  let knowledgeBaseCursor: string | null = null;
  let knowledgeBaseCount = 0;
  let releaseCount = 0;
  let fileCount = 0;

  do {
    const knowledgeBasePage = await options.repositories.knowledgeBases.listKnowledgeBases({
      limit: pageSize,
      cursor: knowledgeBaseCursor
    });

    for (const knowledgeBase of knowledgeBasePage.items) {
      knowledgeBaseCount += 1;

      if (!knowledgeBase.activeReleaseId) {
        continue;
      }

      releaseCount += 1;
      const indexed = await backfillRelease({
        repositories: options.repositories,
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        pageSize
      });
      fileCount += indexed;
      options.logger.info("Generated file search documents indexed", {
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        fileCount: indexed
      });
    }

    knowledgeBaseCursor = knowledgeBasePage.nextCursor;
  } while (knowledgeBaseCursor);

  return {
    knowledgeBaseCount,
    releaseCount,
    fileCount
  };
}

async function backfillRelease(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  releaseId: string;
  pageSize: number;
}): Promise<number> {
  if (!input.repositories.files?.upsertBundleFileSearchDocuments) {
    throw new Error("Generated file search document repository is unavailable");
  }

  let cursor: string | null = null;
  let fileCount = 0;

  do {
    const page = await input.repositories.files.listBundleFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      releaseId: input.releaseId,
      limit: input.pageSize,
      cursor
    });

    if (page.items.length > 0) {
      await input.repositories.files.upsertBundleFileSearchDocuments(
        page.items.map(createGeneratedFileSearchDocument)
      );
      fileCount += page.items.length;
    }

    cursor = page.nextCursor;
  } while (cursor);

  return fileCount;
}
