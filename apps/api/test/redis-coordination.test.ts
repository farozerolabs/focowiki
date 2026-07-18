import { describe, expect, it, vi } from "vitest";
import { createRedisCoordinator, type RedisCommandClient } from "../src/redis/coordination.js";

describe("redis coordination cleanup", () => {
  it("clears source-file runtime keys and source-scoped paginated caches", async () => {
    const deletedKeys: string[] = [];
    const client = createRedisClient({
      keys: [
        "focowiki:pagination-invalid:source-file-events:kb-test:source-file-test",
        "focowiki:pagination-cursors:developer-openapi:related:kb-test:source-file-test:cursor-a",
        "focowiki:page-cache:developer-openapi:related:kb-test:source-file-test:page-a"
      ],
      deletedKeys
    });
    const redis = createRedisCoordinator(client);

    const deleted = await redis.clearSourceFileRuntimeKeys({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test"
    });

    expect(deleted).toBe(7);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        "focowiki:source-file-events:source-file-test",
        "focowiki:source-file-graph-state:source-file-test",
        "focowiki:source-file-locks:source-file-test",
        "focowiki:source-file-graph-locks:source-file-test",
        "focowiki:pagination-invalid:source-file-events:kb-test:source-file-test",
        "focowiki:pagination-cursors:developer-openapi:related:kb-test:source-file-test:cursor-a",
        "focowiki:page-cache:developer-openapi:related:kb-test:source-file-test:page-a"
      ])
    );
  });

  it("clears knowledge-base runtime keys and source runtime keys together", async () => {
    const deletedKeys: string[] = [];
    const client = createRedisClient({
      keys: [
        "focowiki:pagination-invalid:source-files:kb-test",
        "focowiki:pagination-cursors:file-tree:kb-test:generation-test:cursor-a",
        "focowiki:page-cache:active-files:kb-test:generation-test:page-a"
      ],
      deletedKeys
    });
    const redis = createRedisCoordinator(client);

    const deleted = await redis.clearKnowledgeBaseRuntimeKeys({
      knowledgeBaseId: "kb-test",
      sourceFileIds: ["source-file-a"]
    });

    expect(deleted).toBe(9);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        "focowiki:knowledge-base-publication-locks:kb-test",
        "focowiki:pagination-invalid:source-files:kb-test",
        "focowiki:pagination-cursors:file-tree:kb-test:generation-test:cursor-a",
        "focowiki:page-cache:active-files:kb-test:generation-test:page-a",
        "focowiki:source-file-events:source-file-a",
        "focowiki:source-file-graph-state:source-file-a",
        "focowiki:source-file-locks:source-file-a",
        "focowiki:source-file-graph-locks:source-file-a"
      ])
    );
  });

  it("discovers source runtime keys from the knowledge-base index during hard delete", async () => {
    const deletedKeys: string[] = [];
    const client = createRedisClient({ keys: [], deletedKeys });
    const redis = createRedisCoordinator(client);
    await redis.recordSourceFileEvent(
      { knowledgeBaseId: "kb-test", sourceFileId: "source-file-indexed" },
      { knowledgeBaseId: "kb-test", stage: "completed" },
      300
    );
    await redis.recordSourceFileGraphState(
      { knowledgeBaseId: "kb-test", sourceFileId: "source-file-indexed" },
      { knowledgeBaseId: "kb-test", status: "completed" },
      300
    );

    await redis.clearKnowledgeBaseRuntimeKeys({ knowledgeBaseId: "kb-test" });

    expect(deletedKeys).toEqual(expect.arrayContaining([
      "focowiki:source-file-events:source-file-indexed",
      "focowiki:source-file-graph-state:source-file-indexed"
    ]));
  });

  it("clears both authorization and usage keys for a revoked OpenAPI key", async () => {
    const deletedKeys: string[] = [];
    const redis = createRedisCoordinator(createRedisClient({ keys: [], deletedKeys }));

    await redis.clearPublicOpenApiKeyRuntimeKeys("key-test", "hash-test");

    expect(deletedKeys).toEqual([
      "focowiki:public-openapi-key-cache:hash-test",
      "focowiki:public-openapi-key-used:key-test"
    ]);
  });
});

function createRedisClient(input: {
  keys: string[];
  deletedKeys: string[];
}): RedisCommandClient {
  const deleted = new Set<string>();
  const keys = new Set(input.keys);
  const sets = new Map<string, Set<string>>();
  return {
    set: vi.fn(async (key: string) => {
      keys.add(key);
      return "OK";
    }),
    get: vi.fn(async () => null),
    del: vi.fn(async (key: string) => {
      if (deleted.has(key)) {
        return 0;
      }
      deleted.add(key);
      input.deletedKeys.push(key);
      keys.delete(key);
      sets.delete(key);
      return 1;
    }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 60),
    sAdd: vi.fn(async (key: string, member: string | string[]) => {
      const values = Array.isArray(member) ? member : [member];
      const members = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const value of values) {
        if (!members.has(value)) added += 1;
        members.add(value);
      }
      sets.set(key, members);
      keys.add(key);
      return added;
    }),
    sRem: vi.fn(async (key: string, member: string | string[]) => {
      const values = Array.isArray(member) ? member : [member];
      const members = sets.get(key);
      if (!members) return 0;
      let removed = 0;
      for (const value of values) {
        if (members.delete(value)) removed += 1;
      }
      return removed;
    }),
    scanIterator: async function* (options: { MATCH?: string }) {
      const pattern = options.MATCH ?? "*";
      const matches = [...keys].filter((key) => matchesPattern(key, pattern));

      if (matches.length > 0) {
        yield matches;
      }
    },
    sScanIterator: async function* (key: string) {
      const members = [...(sets.get(key) ?? [])];
      if (members.length > 0) yield members;
    }
  };
}

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
