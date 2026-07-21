import { describe, expect, it } from "vitest";
import {
  createActiveReadCacheScope,
  createActiveReadPageCacheId
} from "../src/active-read-cache-scope.js";

describe("active read cache scope", () => {
  it("partitions cached reads by knowledge base, generation, operation, filters, and authorization", () => {
    const base = {
      authorizationScope: "admin" as const,
      operation: "tree",
      knowledgeBaseId: "kb-001",
      generationId: "generation-001",
      filters: {
        parentPath: "pages",
        entryType: "file"
      }
    };
    const scope = createActiveReadCacheScope(base);

    expect(scope).toContain("active-read:admin:tree:kb-001:generation-001:filters=");
    expect(createActiveReadCacheScope({ ...base, knowledgeBaseId: "kb-002" })).not.toBe(scope);
    expect(createActiveReadCacheScope({ ...base, generationId: "generation-002" })).not.toBe(scope);
    expect(createActiveReadCacheScope({ ...base, operation: "tree-search" })).not.toBe(scope);
    expect(createActiveReadCacheScope({
      ...base,
      filters: { parentPath: "pages/docs", entryType: "file" }
    })).not.toBe(scope);
    expect(createActiveReadCacheScope({
      ...base,
      authorizationScope: "developer-openapi"
    })).not.toBe(scope);
  });

  it("makes the previous generation cache unreachable after atomic cutover", () => {
    const before = createActiveReadCacheScope({
      authorizationScope: "admin",
      operation: "source-file-list",
      knowledgeBaseId: "kb-001",
      generationId: "generation-001",
      filters: { signature: "all" }
    });
    const after = createActiveReadCacheScope({
      authorizationScope: "admin",
      operation: "source-file-list",
      knowledgeBaseId: "kb-001",
      generationId: "generation-002",
      filters: { signature: "all" }
    });

    expect(after).not.toBe(before);
  });

  it("partitions pages by cursor, limit, and operation-specific input", () => {
    expect(createActiveReadPageCacheId({
      cursorToken: null,
      limit: 50,
      input: { parentPath: "pages" }
    })).not.toBe(createActiveReadPageCacheId({
      cursorToken: "cursor-001",
      limit: 50,
      input: { parentPath: "pages" }
    }));
    expect(createActiveReadPageCacheId({
      cursorToken: null,
      limit: 50,
      input: { parentPath: "pages" }
    })).not.toBe(createActiveReadPageCacheId({
      cursorToken: null,
      limit: 100,
      input: { parentPath: "pages" }
    }));
    expect(createActiveReadPageCacheId({
      cursorToken: null,
      limit: 50,
      input: { parentPath: "pages" }
    })).not.toBe(createActiveReadPageCacheId({
      cursorToken: null,
      limit: 50,
      input: { parentPath: "pages/docs" }
    }));
  });
});
