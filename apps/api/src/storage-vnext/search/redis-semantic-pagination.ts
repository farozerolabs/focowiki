import { randomUUID } from "node:crypto";

import type { RedisCoordinator } from "../../redis/coordination.js";
import type {
  StorageVnextSemanticPaginationPort,
  StorageVnextSemanticPaginationState
} from "./semantic-search.js";

export function createRedisStorageVnextSemanticPagination(input: {
  redis: RedisCoordinator;
  ttlSeconds: number;
}): StorageVnextSemanticPaginationPort {
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1) {
    throw new Error("Semantic search pagination TTL is invalid");
  }
  return {
    async read(scopeHash, cursor) {
      if (!isCursorId(cursor)) return null;
      return input.redis.getPaginationCursor<StorageVnextSemanticPaginationState>(
        scope(scopeHash),
        cursor
      );
    },
    async write(scopeHash, state) {
      const cursor = `search-cursor-${randomUUID()}`;
      await input.redis.setPaginationCursor(
        scope(scopeHash),
        cursor,
        state,
        input.ttlSeconds
      );
      return cursor;
    }
  };
}

function scope(scopeHash: string): string {
  return `storage-vnext:semantic-search:${scopeHash}`;
}

function isCursorId(value: string): boolean {
  return /^search-cursor-[0-9a-f-]{36}$/u.test(value);
}
