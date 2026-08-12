import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextOperationRead } from
  "../src/storage-vnext/api/postgres-operation-read.js";

describe("PostgreSQL storage vNext operation reads", () => {
  it("rejects a malformed internal cursor with the pagination domain error", async () => {
    const sql = vi.fn(async () => []) as unknown as DatabaseClient;
    const operations = createPostgresStorageVnextOperationRead(sql);

    await expect(operations.list({
      knowledgeBaseId: "kb-cursor",
      limit: 20,
      cursor: "invalid"
    })).rejects.toMatchObject({
      name: "SourceResourceError",
      code: "INVALID_PAGINATION"
    });
    expect(sql).not.toHaveBeenCalled();
  });
});
