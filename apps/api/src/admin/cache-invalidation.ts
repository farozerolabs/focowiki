import type { RedisCoordinator } from "../redis/coordination.js";

export type KnowledgeBaseCacheInvalidationInput = {
  redis: RedisCoordinator;
  knowledgeBaseId: string;
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
    ...sourceFileIds.flatMap((sourceFileId) => [
      `source-file-events:${input.knowledgeBaseId}:${sourceFileId}`,
      `developer-openapi:source-file-events:${input.knowledgeBaseId}:${sourceFileId}`,
      `developer-openapi:related:${input.knowledgeBaseId}:${sourceFileId}`
    ])
  ];

  await Promise.all(
    scopes.map((scope) => input.redis.markPaginationInvalid(scope, "changed", input.ttlSeconds))
  );
}
