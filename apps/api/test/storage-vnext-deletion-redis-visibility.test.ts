import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type VisibilityCache = {
  invalidateKnowledgeBase(input: { knowledgeBaseId: string }): Promise<void>;
};

type VisibilityCacheFactory = (input: {
  redis: {
    clearKnowledgeBaseRuntimeKeys(input: {
      knowledgeBaseId: string;
    }): Promise<number>;
  };
}) => VisibilityCache;

let factory: VisibilityCacheFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/redis-visibility.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createRedisStorageVnextDeletionVisibilityCache?: VisibilityCacheFactory;
    };
  factory = loaded.createRedisStorageVnextDeletionVisibilityCache;
});

describe("storage vNext deletion Redis visibility", () => {
  it("clears only the exact knowledge-base current-read scope", async () => {
    const clearKnowledgeBaseRuntimeKeys = vi.fn(async () => 7);
    expect(factory).toBeTypeOf("function");
    if (!factory) throw new Error("Deletion Redis visibility cache is unavailable");
    const cache = factory({ redis: { clearKnowledgeBaseRuntimeKeys } });

    await cache.invalidateKnowledgeBase({ knowledgeBaseId: "kb-delete-cache" });

    expect(clearKnowledgeBaseRuntimeKeys).toHaveBeenCalledOnce();
    expect(clearKnowledgeBaseRuntimeKeys).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-delete-cache"
    });
  });

  it("rejects an empty or control-character scope before touching Redis", async () => {
    const clearKnowledgeBaseRuntimeKeys = vi.fn(async () => 0);
    expect(factory).toBeTypeOf("function");
    if (!factory) throw new Error("Deletion Redis visibility cache is unavailable");
    const cache = factory({ redis: { clearKnowledgeBaseRuntimeKeys } });

    await expect(cache.invalidateKnowledgeBase({ knowledgeBaseId: "" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(cache.invalidateKnowledgeBase({ knowledgeBaseId: "kb\0foreign" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(clearKnowledgeBaseRuntimeKeys).not.toHaveBeenCalled();
  });
});
