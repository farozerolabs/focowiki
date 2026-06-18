import type { RedisCoordinator } from "../redis/coordination.js";

export type KnowledgeBaseCacheInvalidationInput = {
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  releaseId: string | null;
  sourceFileId?: string | null;
  ttlSeconds: number;
};

export async function invalidateKnowledgeBaseCaches(
  input: KnowledgeBaseCacheInvalidationInput
): Promise<void> {
  const scopes = [
    "knowledge-bases",
    `source-files:${input.knowledgeBaseId}`,
    `releases:${input.knowledgeBaseId}`,
    ...(input.sourceFileId
      ? [`source-file-events:${input.knowledgeBaseId}:${input.sourceFileId}`]
      : []),
    ...(input.releaseId
      ? [
          `file-tree:${input.knowledgeBaseId}:${input.releaseId}:root`,
          `bundle-files:${input.knowledgeBaseId}:${input.releaseId}`,
          `public-files:${input.knowledgeBaseId}:${input.releaseId}`
        ]
      : [])
  ];

  await Promise.all(
    scopes.map((scope) => input.redis.markPaginationInvalid(scope, "changed", input.ttlSeconds))
  );
}
