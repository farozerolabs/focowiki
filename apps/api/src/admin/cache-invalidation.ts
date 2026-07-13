import type { RedisCoordinator } from "../redis/coordination.js";

export type KnowledgeBaseCacheInvalidationInput = {
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  releaseId: string | null;
  sourceFileId?: string | null;
  sourceFileIds?: string[];
  ttlSeconds: number;
};

export async function invalidateKnowledgeBaseCaches(
  input: KnowledgeBaseCacheInvalidationInput
): Promise<void> {
  const sourceFileIds = [
    ...(input.sourceFileId ? [input.sourceFileId] : []),
    ...(input.sourceFileIds ?? [])
  ];
  const scopes = [
    "knowledge-bases",
    `source-files:${input.knowledgeBaseId}`,
    `developer-openapi:source-files:${input.knowledgeBaseId}`,
    `releases:${input.knowledgeBaseId}`,
    ...sourceFileIds.flatMap((sourceFileId) => [
      `source-file-events:${input.knowledgeBaseId}:${sourceFileId}`,
      `developer-openapi:source-file-events:${input.knowledgeBaseId}:${sourceFileId}`,
      `developer-openapi:related:${input.knowledgeBaseId}:${sourceFileId}`
    ]),
    ...(input.releaseId
      ? [
          `file-tree:${input.knowledgeBaseId}:${input.releaseId}`,
          `developer-openapi:tree:${input.knowledgeBaseId}:${input.releaseId}`,
          `bundle-files:${input.knowledgeBaseId}:${input.releaseId}`,
          `public-files:${input.knowledgeBaseId}:${input.releaseId}`,
          `developer-openapi:file-search:${input.knowledgeBaseId}:${input.releaseId}`,
          `developer-openapi:graph-search:${input.knowledgeBaseId}:${input.releaseId}`,
          `developer-openapi:graph-expand:${input.knowledgeBaseId}:${input.releaseId}`
        ]
      : [])
  ];

  await Promise.all(
    scopes.map((scope) => input.redis.markPaginationInvalid(scope, "changed", input.ttlSeconds))
  );
}
