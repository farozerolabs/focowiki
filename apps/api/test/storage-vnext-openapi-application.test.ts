import { describe, expect, it, vi } from "vitest";
import { StorageVnextCatalogRepositoryError } from
  "../src/storage-vnext/catalog/postgres-repository.js";
import { createPostgresStorageVnextOpenApiApplication } from
  "../src/storage-vnext/api/postgres-openapi-application.js";
import { SearchProviderError } from
  "../src/application/ports/search-provider-runtime.js";
import { StorageVnextActiveSearchInputError } from
  "../src/storage-vnext/search/active-search.js";

describe("storage vNext Developer OpenAPI application", () => {
  it.each(["id", "path"] as const)(
    "returns byte-equivalent uploaded Markdown for source-backed file content by %s",
    async (lookup) => {
      const original = [
        "---",
        'title: "Original order"',
        'status: "stable"',
        "---",
        "",
        "# Original order",
        "",
        "Keep the uploaded bytes and final newline.",
        ""
      ].join("\n");
      const sql = (async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT page.logical_path")) {
          return [{
            logical_path: "pages/original.md",
            source_file_public_id: "source-file-original",
            object_id: "object-generated"
          }];
        }
        if (query.includes("knowledge_base_sequences")) {
          return [{
            knowledge_base_id: "knowledge-base-original",
            activation_revision: 7
          }];
        }
        throw new Error(`Unexpected query: ${query}`);
      }) as never;
      const application = createPostgresStorageVnextOpenApiApplication({
        sql,
        catalog: null as never,
        adminRead: null as never,
        adminCore: {
          async readGeneratedContent() {
            return {
              ok: true as const,
              value: {
                file: {
                  id: "source-file-original",
                  sourceFileId: "source-file-original",
                  logicalPath: "pages/original.md",
                  title: "Original order"
                },
                content: [
                  "---",
                  'status: "stable"',
                  'title: "Original order"',
                  "---",
                  "# Original order"
                ].join("\n")
              }
            };
          }
        } as never,
        resources: {
          async readSourceContent() {
            return {
              content: new TextEncoder().encode(original),
              contentType: "text/markdown; charset=utf-8",
              resourceRevision: 1,
              contentRevision: 1
            };
          }
        } as never,
        source: null as never,
        search: null,
        webhooks: null as never
      });

      const result = lookup === "id"
        ? await application.getFileContentById({
            knowledgeBaseId: "knowledge-base-original",
            fileId: "source-file-original"
          })
        : await application.getFileContentByPath({
            knowledgeBaseId: "knowledge-base-original",
            path: "pages/original.md"
          });

      expect(result).toMatchObject({
        file: {
          fileId: "source-file-original",
          path: "pages/original.md",
          title: "Original order"
        },
        content: original
      });
    }
  );

  it.each([
    ["name", "界".repeat(86)],
    ["description", "界".repeat(5_462)]
  ] as const)("rejects an oversized knowledge-base %s before persistence", async (field, value) => {
    const create = vi.fn();
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: null as never,
      catalog: null as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
      source: null as never,
      search: null,
      webhooks: null as never,
      knowledgeBaseCreation: { create }
    });

    await expect(application.createKnowledgeBase({
      name: field === "name" ? value : "Knowledge base",
      description: field === "description" ? value : null
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      details: { field }
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a graph file seed that is not part of the active release", async () => {
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: (async () => []) as never,
      catalog: null as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
      source: null as never,
      search: null,
      webhooks: null as never
    });

    await expect(application.expandGraph({
      knowledgeBaseId: "knowledge-base-graph-seed",
      fileId: "definitely-missing",
      depth: 0,
      fanout: 10,
      limit: 10,
      cursor: null
    })).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("uses a returned readable file ID as the graph seed without a second search", async () => {
    const search = vi.fn(async () => ({
      items: [{
        publicId: "source-file-guide",
        sourceFilePublicId: "source-file-guide",
        logicalPath: "pages/guide.md",
        title: "Coastal operations guide",
        snippet: "Explains how the station is maintained.",
        score: 0.8,
        kind: "file" as const,
        metadata: { tags: ["operations"] }
      }],
      nextCursor: null
    }));
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT page.logical_path")) {
        return [{
          logical_path: "pages/guide.md",
          source_file_public_id: "source-file-guide",
          object_id: "object-guide"
        }];
      }
      if (query.includes("knowledge_base_sequences")) {
        return [{
          knowledge_base_id: "knowledge-base-graph-query",
          activation_revision: 1
        }];
      }
      return [];
    }) as never;
    const application = createPostgresStorageVnextOpenApiApplication({
      sql,
      catalog: null as never,
      adminRead: null as never,
      adminCore: {
        async readGeneratedContent() {
          return {
            ok: true as const,
            value: {
              file: {
                id: "source-file-guide",
                sourceFileId: "source-file-guide",
                logicalPath: "pages/guide.md",
                title: "guide"
              },
              content: "# Coastal operations guide\n\nStation maintenance."
            }
          };
        }
      } as never,
      resources: null as never,
      source: null as never,
      search: { search },
      webhooks: null as never
    });

    await expect(application.expandGraph({
      knowledgeBaseId: "knowledge-base-graph-query",
      fileId: "source-file-guide",
      depth: 1,
      fanout: 10,
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      seedFile: {
        fileId: "source-file-guide",
        title: "Coastal operations guide"
      },
      resultSummary: { relationshipCount: 0 }
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("maps an invalid knowledge-base cursor to the public validation error", async () => {
    const application = createPostgresStorageVnextOpenApiApplication({
      sql: null as never,
      catalog: {
        async listKnowledgeBases() {
          throw new StorageVnextCatalogRepositoryError("invalid_cursor");
        }
      } as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
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
        sql: (async () => [{
          knowledge_base_id: "knowledge-base-search-errors",
          activation_revision: 1
        }]) as never,
        catalog: null as never,
        adminRead: null as never,
        adminCore: null as never,
        resources: null as never,
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
        rerank: false,
        rerankTopK: null,
        rerankScoreThreshold: null,
        cursor: null
      })).rejects.toMatchObject({ code, httpStatus });
    }
  );

  it("rejects an unsupported generated file kind instead of returning a false empty result", async () => {
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
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
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
      rerank: false,
      rerankTopK: null,
      rerankScoreThreshold: null,
      cursor: null
    } as never)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      details: { field: "fileKind" }
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("reports complete graph totals separately from the current result page", async () => {
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("indexed_document_count")) {
        return [{ indexed_document_count: "12", indexed_relationship_count: "34" }];
      }
      if (query.includes("knowledge_base_sequences")) {
        return [{
          knowledge_base_id: "knowledge-base-graph-summary",
          activation_revision: 1
        }];
      }
      if (query.includes("seed_source_file_public_id")) {
        return [{
          seed_source_file_public_id: "source-file-one",
          seed_node_public_id: "node-one",
          from_source_file_public_id: "source-file-one",
          relationship_depth: 1,
          relation_ordinal: 1,
          public_id: "edge-one-two",
          source_file_public_id: "source-file-two",
          logical_path: "pages/two.md",
          title: "Two",
          relation: "reference",
          weight: 0.8,
          reason: "One references Two.",
          direction: "outgoing"
        }];
      }
      throw new Error(`Unexpected query: ${query}`);
    }) as never;
    const application = createPostgresStorageVnextOpenApiApplication({
      sql,
      catalog: null as never,
      adminRead: null as never,
      adminCore: null as never,
      resources: null as never,
      source: null as never,
      search: {
        async search() {
          return {
            items: [{
              publicId: "source-file-one",
              sourceFilePublicId: "source-file-one",
              logicalPath: "pages/one.md",
              title: "One",
              snippet: "One",
              score: 1,
              kind: "graph" as const,
              metadata: {},
              evidenceFamilies: ["file_graph"],
              matchedFields: ["file_relationship"],
              evidenceTypes: ["file_relationship"]
            }],
            nextCursor: null
          };
        }
      },
      webhooks: null as never
    });

    await expect(application.searchFiles({
      knowledgeBaseId: "knowledge-base-graph-summary",
      query: "How is One connected to Two?",
      scope: "all",
      fileKind: "page",
      mode: "graph",
      graphDepth: 1,
      graphFanout: 10,
      limit: 10,
      rerank: false,
      rerankTopK: null,
      rerankScoreThreshold: null,
      cursor: null
    })).resolves.toMatchObject({
      items: [{
        graphContext: {
          relationships: [{
            fileId: "source-file-two",
            relationshipDepth: 1,
            fromFileId: "source-file-one"
          }]
        }
      }],
      graphSummary: {
        indexedDocumentCount: 12,
        indexedRelationshipCount: 34
      },
      resultSummary: { resultCount: 1 }
    });
  });
});
