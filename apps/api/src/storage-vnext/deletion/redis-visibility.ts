import type { RedisCoordinator } from "../../redis/coordination.js";
import type { StorageVnextDeletionVisibilityCache } from "./ports.js";

type DeletionRedisPort = Pick<RedisCoordinator, "clearKnowledgeBaseRuntimeKeys">;

export function createRedisStorageVnextDeletionVisibilityCache(input: {
  redis: DeletionRedisPort;
}): StorageVnextDeletionVisibilityCache {
  return {
    async invalidateKnowledgeBase({ knowledgeBaseId }) {
      assertKnowledgeBaseId(knowledgeBaseId);
      await input.redis.clearKnowledgeBaseRuntimeKeys({ knowledgeBaseId });
    }
  };
}

function assertKnowledgeBaseId(value: string): void {
  if (!value || Buffer.byteLength(value) > 255 || value.includes("\0")) {
    throw Object.assign(new Error("Storage vNext deletion visibility error: invalid_input"), {
      code: "invalid_input"
    });
  }
}
