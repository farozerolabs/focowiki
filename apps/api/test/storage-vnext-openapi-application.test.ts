import { describe, expect, it, vi } from "vitest";
import { StorageVnextCatalogRepositoryError } from
  "../src/storage-vnext/catalog/postgres-repository.js";
import { createPostgresStorageVnextOpenApiApplication } from
  "../src/storage-vnext/api/postgres-openapi-application.js";
import type { StorageVnextSourceEventSummary } from
  "../src/storage-vnext/source-events/ports.js";
import { StorageVnextSourceEventRepositoryError } from
  "../src/storage-vnext/source-events/postgres-repository.js";
import { SearchProviderError } from
  "../src/application/ports/search-provider-runtime.js";
import { StorageVnextActiveSearchInputError } from
  "../src/storage-vnext/search/active-search.js";

describe("storage vNext Developer OpenAPI application", () => {
  it("maps an invalid knowledge-base cursor to the public validation error", async () => {
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: null as never,
      catalog: {
        async listKnowledgeBases() {
          throw new StorageVnextCatalogRepositoryError("invalid_cursor");
        }
      } as never,
      releases: null as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
      sourceEvents: null as never,
      source: null as never,
      search: null,
      webhooks: null as never
    });

    await expect(application.listKnowledgeBases({
      limit: 10,
      cursor: "tampered"
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      details: { field: "cursor" }
    });
  });

  it("returns the bounded source event history with the requested page cursor", async () => {
    const calls: unknown[] = [];
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: null as never,
      catalog: null as never,
      releases: null as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: {
        async getSourceFile() {
          return { id: "source-file-one" };
        }
      } as never,
      sourceEvents: {
        async list(input: unknown) {
          calls.push(input);
          return {
            items: [
              sourceEvent("source-event-accepted", "upload_storage", "info"),
              sourceEvent("source-event-progress", "metadata_resolution", "warning")
            ],
            nextCursor: "events-next"
          };
        }
      },
      source: null as never,
      search: null,
      webhooks: null as never
    });

    await expect(application.listSourceFileEvents({
      knowledgeBaseId: "knowledge-base-one",
      sourceFileId: "source-file-one",
      limit: 2,
      cursor: "events-cursor"
    })).resolves.toEqual({
      items: [
        expect.objectContaining({
          eventId: "source-event-accepted",
          stageKey: "upload_storage"
        }),
        expect.objectContaining({
          eventId: "source-event-progress",
          severity: "warning"
        })
      ],
      nextCursor: "events-next"
    });
    expect(calls).toEqual([{
      knowledgeBaseId: "knowledge-base-one",
      sourceFileId: "source-file-one",
      limit: 2,
      cursor: "events-cursor"
    }]);
  });

  it("maps an invalid source event cursor to the public validation error", async () => {
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: null as never,
      catalog: null as never,
      releases: null as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: {
        async getSourceFile() {
          return { id: "source-file-one" };
        }
      } as never,
      sourceEvents: {
        async list() {
          throw new StorageVnextSourceEventRepositoryError("invalid_cursor");
        }
      },
      source: null as never,
      search: null,
      webhooks: null as never
    });

    await expect(application.listSourceFileEvents({
      knowledgeBaseId: "knowledge-base-one",
      sourceFileId: "source-file-one",
      limit: 10,
      cursor: "tampered"
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      details: { field: "cursor" }
    });
  });

  it.each([
    [new SearchProviderError("SEARCH_ENGINE_UNAVAILABLE", true),
      "SEARCH_UNAVAILABLE", 503],
    [new SearchProviderError("SEARCH_ENGINE_OVERLOADED", true),
      "SEARCH_OVERLOADED", 503],
    [new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true),
      "SEARCH_TIMEOUT", 504],
    [new StorageVnextActiveSearchInputError("INVALID_SEARCH_CURSOR"),
      "VALIDATION_ERROR", 422]
  ] as const)(
    "maps search failure %s to %s",
    async (failure, code, httpStatus) => {
      const application = createPostgresStorageVnextOpenApiApplication({
        sql: null as never,
        catalog: null as never,
        releases: {
          async getActiveRoot() {
            return {
              publicId: "root-search-errors",
              knowledgeBaseId: "knowledge-base-search-errors",
              role: "active",
              manifestChecksum: "a".repeat(64),
              revision: 1,
              createdAt: "2026-08-07T00:00:00.000Z",
              expiresAt: null
            };
          }
        } as never,
        adminRead: null as never,
        adminCore: null as never,
        resources: null as never,
        sourceEvents: null as never,
        source: null as never,
        search: {
          async search() {
            throw failure;
          }
        },
        webhooks: null as never
      });

      await expect(application.searchFiles({
        knowledgeBaseId: "knowledge-base-search-errors",
        query: "evidence",
        scope: "all",
        fileKind: null,
        mode: "hybrid",
        graphDepth: 1,
        graphFanout: 10,
        limit: 20,
        cursor: null
      })).rejects.toMatchObject({ code, httpStatus });
    }
  );

  it("does not return source-backed pages for an unrelated generated file kind", async () => {
    const search = vi.fn(async () => ({
      items: [{
        publicId: "source-file-one",
        sourceFilePublicId: "source-file-one",
        logicalPath: "pages/guide.md",
        title: "Guide",
        snippet: "evidence",
        score: 1,
        kind: "file" as const,
        metadata: {}
      }],
      nextCursor: null
    }));
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: null as never,
      catalog: null as never,
      releases: {
        async getActiveRoot() {
          return {
            publicId: "root-file-kind",
            knowledgeBaseId: "knowledge-base-file-kind",
            role: "active",
            manifestChecksum: "a".repeat(64),
            revision: 1,
            createdAt: "2026-08-07T00:00:00.000Z",
            expiresAt: null
          };
        }
      } as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
      sourceEvents: null as never,
      source: null as never,
      search: { search },
      webhooks: null as never
    });

    await expect(application.searchFiles({
      knowledgeBaseId: "knowledge-base-file-kind",
      query: "evidence",
      scope: "all",
      fileKind: "index",
      mode: "file",
      graphDepth: 1,
      graphFanout: 10,
      limit: 20,
      cursor: null
    })).resolves.toMatchObject({ items: [], searchStatus: "no_candidates" });
    expect(search).not.toHaveBeenCalled();
  });
});

function sourceEvent(
  publicId: string,
  stageKey: StorageVnextSourceEventSummary["stageKey"],
  severity: "info" | "warning" | "error"
) {
  return {
    publicId,
    knowledgeBaseId: "knowledge-base-one",
    sourceFilePublicId: "source-file-one",
    sourceRevisionPublicId: "source-revision-one",
    sequence: 10,
    stageKey,
    messageKey: `sourceFiles.phase.${stageKey}`,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    severity,
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z"
  };
}
