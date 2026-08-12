import { describe, expect, it, vi } from "vitest";
import { createRedisStorageVnextSemanticPagination } from
  "../src/storage-vnext/search/redis-semantic-pagination.js";

describe("storage vNext Redis semantic pagination", () => {
  it("keeps cursor state short-lived, scope-bound, and opaque", async () => {
    const setPaginationCursor = vi.fn(async () => undefined);
    const getPaginationCursor = vi.fn(async () => ({
      version: 1 as const,
      seenSourceFilePublicIds: ["source-file-a"],
      scanLimit: 2
    }));
    const pagination = createRedisStorageVnextSemanticPagination({
      redis: { setPaginationCursor, getPaginationCursor } as never,
      ttlSeconds: 900
    });
    const state = {
      version: 1 as const,
      seenSourceFilePublicIds: ["source-file-a"],
      scanLimit: 2
    };

    const cursor = await pagination.write("scope-hash-a", state);
    expect(cursor).toMatch(/^search-cursor-[0-9a-f-]{36}$/u);
    expect(setPaginationCursor).toHaveBeenCalledWith(
      "storage-vnext:semantic-search:scope-hash-a",
      cursor,
      state,
      900
    );
    await expect(pagination.read("scope-hash-a", cursor)).resolves.toEqual(state);
    expect(getPaginationCursor).toHaveBeenCalledWith(
      "storage-vnext:semantic-search:scope-hash-a",
      cursor
    );
    await expect(pagination.read("scope-hash-a", "invalid")).resolves.toBeNull();
    expect(getPaginationCursor).toHaveBeenCalledTimes(1);
  });
});
