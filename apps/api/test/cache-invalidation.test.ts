import { describe, expect, it } from "vitest";
import { invalidateKnowledgeBaseCaches } from "../src/admin/cache-invalidation.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";

describe("knowledge base cache invalidation", () => {
  it("marks source-file scopes stale after source state changes", async () => {
    const invalidatedScopes: string[] = [];
    const redis = {
      async markPaginationInvalid(scope: string) {
        invalidatedScopes.push(scope);
      }
    } as unknown as RedisCoordinator;

    await invalidateKnowledgeBaseCaches({
      redis,
      knowledgeBaseId: "kb-001",
      sourceFileId: "source-001",
      ttlSeconds: 900
    });

    expect(invalidatedScopes).toEqual(
      expect.arrayContaining([
        "source-files:kb-001",
        "developer-openapi:source-files:kb-001",
        "source-file-events:kb-001:source-001",
        "developer-openapi:source-file-events:kb-001:source-001",
        "developer-openapi:related:kb-001:source-001"
      ])
    );
  });
});
