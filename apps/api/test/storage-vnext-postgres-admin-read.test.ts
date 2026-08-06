import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextAdminRead } from
  "../src/storage-vnext/api/postgres-admin-read.js";
import { createPostgresStorageVnextAdminResourceRead } from
  "../src/storage-vnext/api/postgres-admin-resources.js";
import type { StorageVnextCatalogReadPort } from
  "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextReleaseReadPort } from
  "../src/storage-vnext/release/ports.js";
import type { StorageVnextSearchQueryPort } from
  "../src/storage-vnext/search/ports.js";

describe("PostgreSQL storage vNext Admin reads", () => {
  it("keeps directory cursors valid when the next page changes its limit", async () => {
    const rows = [
      sourceDirectoryRow("directory-a", "archive"),
      sourceDirectoryRow("directory-b", "guide")
    ];
    const application = createPostgresStorageVnextAdminResourceRead(
      (async () => rows) as unknown as DatabaseClient
    );

    const first = await application.listDirectories({
      knowledgeBaseId: "kb-directory-cursor",
      parentDirectoryId: null,
      limit: 1,
      cursor: null
    });

    expect(first.nextCursor).toBeTruthy();
    await expect(application.listDirectories({
      knowledgeBaseId: "kb-directory-cursor",
      parentDirectoryId: null,
      limit: 2,
      cursor: first.nextCursor
    })).resolves.toMatchObject({
      items: [{ id: "directory-a" }, { id: "directory-b" }]
    });
  });

  it("pushes every visible source-file column filter into the bounded SQL query", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join("?"), values });
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminResourceRead(sql);

    await application.listSourceFiles({
      knowledgeBaseId: "kb-filters",
      directoryId: undefined,
      filters: {
        pathQuery: "guide",
        sourceFileIdPrefix: "source-file-",
        state: null,
        currentStage: "metadata_resolution",
        modelInvocationStatus: "not_recorded",
        generatedOutputStatus: "pending",
        startedFrom: "2026-08-01T00:00:00.000Z",
        startedTo: "2026-08-02T00:00:00.000Z",
        endedFrom: "2026-08-01T00:00:00.000Z",
        endedTo: "2026-08-02T00:00:00.000Z",
        errorState: "without_error",
        errorCodeQuery: "SOURCE",
        actionState: "none"
      },
      limit: 20,
      cursor: null
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("source.created_at >=");
    expect(queries[0]?.text).toContain("source.updated_at <=");
    expect(queries[0]?.text).toContain("source.safe_error_code");
    expect(queries[0]?.values).toEqual(expect.arrayContaining([
      ["pending", "processing", "failed"],
      "not_recorded",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "without_error",
      "SOURCE",
      "none"
    ]));
  });

  it("returns matching directory entries before unified-index file matches", async () => {
    const application = createPostgresStorageVnextAdminRead({
      sql: (async () => [directoryRow("pages")]) as unknown as DatabaseClient,
      catalog: {
        async getKnowledgeBase() {
          return {
            publicId: "kb-1",
            name: "Knowledge base",
            description: null,
            revision: 1,
            visibility: "current",
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z"
          };
        },
        async listSourceFilesByPublicIds() {
          return [];
        }
      } as unknown as StorageVnextCatalogReadPort,
      releases: {
        async getActiveRoot() {
          return {
            publicId: "root-1",
            knowledgeBaseId: "kb-1",
            role: "active",
            manifestChecksum: "checksum",
            revision: 1,
            createdAt: "2026-08-06T00:00:00.000Z",
            expiresAt: null
          };
        }
      } as unknown as StorageVnextReleaseReadPort,
      search: {
        async search() {
          return { items: [], nextCursor: null };
        }
      } as StorageVnextSearchQueryPort
    });

    const result = await application.searchFiles({
      knowledgeBaseId: "kb-1",
      query: "pages",
      limit: 5,
      cursor: null
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{
          entry: {
            logicalPath: "pages",
            entryType: "directory",
            descendantFileCount: 200
          },
          ancestors: []
        }],
        nextCursor: null
      }
    });
  });
});

function directoryRow(logicalPath: string) {
  return {
    record_id: "directory:",
    logical_path: logicalPath,
    parent_path: "",
    entry_type: "directory" as const,
    source_file_public_id: null,
    source_directory_public_id: null,
    entry_kind: null,
    direct_directory_count: 5,
    direct_file_count: 0,
    descendant_file_count: 200,
    resource_revision: 0
  };
}

function sourceDirectoryRow(publicId: string, logicalPath: string) {
  return {
    public_id: publicId,
    knowledge_base_id: "kb-directory-cursor",
    parent_public_id: null,
    logical_path: logicalPath,
    revision: 1,
    created_at: new Date("2026-08-06T00:00:00.000Z"),
    updated_at: new Date("2026-08-06T00:00:00.000Z"),
    direct_file_count: 1,
    descendant_file_count: 1
  };
}
