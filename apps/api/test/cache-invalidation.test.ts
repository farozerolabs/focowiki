import { describe, expect, it } from "vitest";
import { invalidateKnowledgeBaseCaches } from "../src/admin/cache-invalidation.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";

describe("knowledge base cache invalidation", () => {
  it("marks source-file and active root tree scopes stale after a file release changes", async () => {
    const invalidatedScopes: string[] = [];
    const redis = {
      async markPaginationInvalid(scope: string) {
        invalidatedScopes.push(scope);
      }
    } as unknown as RedisCoordinator;

    await invalidateKnowledgeBaseCaches({
      redis,
      knowledgeBaseId: "kb-001",
      releaseId: "release-002",
      sourceFileId: "source-001",
      ttlSeconds: 900
    });

    expect(invalidatedScopes).toEqual(
      expect.arrayContaining([
        "source-files:kb-001",
        "developer-openapi:source-files:kb-001",
        "source-file-events:kb-001:source-001",
        "developer-openapi:source-file-events:kb-001:source-001",
        "developer-openapi:related:kb-001:source-001",
        "file-tree:kb-001:release-002",
        "developer-openapi:tree:kb-001:release-002",
        "bundle-files:kb-001:release-002",
        "public-files:kb-001:release-002",
        "developer-openapi:file-search:kb-001:release-002"
      ])
    );
  });
});
