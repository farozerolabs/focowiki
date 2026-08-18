import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextAdminRead } from
  "../src/storage-vnext/api/postgres-admin-read.js";
import { createPostgresStorageVnextAdminResourceRead } from
  "../src/storage-vnext/api/postgres-admin-resources.js";
import type { StorageVnextCatalogReadPort } from
  "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextSearchQueryPort } from
  "../src/storage-vnext/search/ports.js";

describe("PostgreSQL storage vNext Admin reads", () => {
  it("rejects malformed resource cursors with the pagination domain error", async () => {
    const sql = vi.fn(async () => []) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminResourceRead(sql);

    await expect(application.listDirectories({
      knowledgeBaseId: "kb-resource-cursor",
      parentDirectoryId: null,
      limit: 20,
      cursor: "invalid"
    })).rejects.toMatchObject({
      name: "SourceResourceError",
      code: "INVALID_PAGINATION"
    });
    expect(sql).not.toHaveBeenCalled();
  });

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
        blockingWorkKind: null,
        currentStage: "available",
        modelInvocationStatus: "not_recorded",
        generatedOutputStatus: "unavailable",
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
    expect(queries[0]?.text).toContain("job.started_at >=");
    expect(queries[0]?.text).toContain("job.terminal_at <=");
    expect(queries[0]?.text).toContain("job.safe_error_code");
    expect(queries[0]?.text).toContain("job.model_status");
    expect(queries[0]?.text).toContain("job.state =");
    expect(queries[0]?.text).toMatch(
      /job\.blocking_work_kind =/u
    );
    expect(queries[0]?.text).toMatch(
      /job\.state NOT IN \('waiting', 'processing'\)[\s\S]+job\.blocking_work_kind IS NULL[\s\S]+job\.state =/u
    );
    expect(queries[0]?.text).toContain("lifecycle.generated_output_status");
    expect(queries[0]?.text).toContain("= 'correctable'");
    expect(queries[0]?.text).toContain("= 'details_only'");
    expect(queries[0]?.text).toMatch(
      /= 'none'\s+AND lifecycle\.generated_output_status = 'unavailable'\s+AND job\.state <> 'error'/u
    );
    expect(queries[0]?.text).not.toContain("pending_publication");
    expect(queries[0]?.text).not.toContain("processing_stage_work_items");
    expect(queries[0]?.values).toEqual(expect.arrayContaining([
      "not_recorded",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "without_error",
      "SOURCE",
      "none"
    ]));
  });

  it("reads current-revision lifecycle from the compact source summary", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join("?"), values });
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminResourceRead(sql);

    await application.listSourceFiles({
      knowledgeBaseId: "kb-latest-semantic-operation",
      directoryId: undefined,
      filters: emptySourceFileFilters(),
      limit: 20,
      cursor: null
    });

    const query = queries[0]?.text ?? "";
    expect(query).toContain("JOIN focowiki.document_processing_jobs job");
    expect(query).toContain(
      "job.source_revision_public_id = active.current_source_revision_public_id"
    );
    expect(query).toContain("job.blocking_work_kind");
    expect(query).not.toContain("processing_source_summaries");
    expect(query).not.toContain("processing_stage_work_items");
  });

  it("does not reconstruct document state from legacy operation or event facts", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join("?"), values });
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminResourceRead(sql);

    await application.listSourceFiles({
      knowledgeBaseId: "kb-deterministic",
      directoryId: undefined,
      filters: emptySourceFileFilters(),
      limit: 20,
      cursor: null
    });

    const query = queries[0]?.text ?? "";
    expect(query).toContain("JOIN focowiki.document_processing_jobs job");
    expect(query).not.toContain("operation_work_items");
    expect(query).not.toContain("source_processing_events");
    expect(query).not.toContain("search_publication");
  });

  it("returns the durable model invocation used for the current source revision", async () => {
    const application = createPostgresStorageVnextAdminResourceRead(
      (async () => [{
        public_id: "source-file-model",
        knowledge_base_id: "kb-model",
        directory_public_id: null,
        logical_path: "model.md",
        active_source_revision_public_id: "source-revision-model",
        resource_revision: 3,
        content_revision: 2,
        created_at: new Date("2026-08-01T00:00:00.000Z"),
        updated_at: new Date("2026-08-01T00:00:02.000Z"),
        source_revision_public_id: "source-revision-model",
        checksum_sha256: "a".repeat(64),
        byte_count: 12,
        content_type: "text/markdown; charset=utf-8",
        generated_path: "pages/model.md",
        job_public_id: "document-job-model",
        job_state: "available",
        required_work_count: 8,
        completed_work_count: 8,
        active_work_kinds: [],
        blocking_work_kind: null,
        retrying_work_kind: null,
        safe_error_code: null,
        safe_error_message: null,
        retryable: false,
        retry_count: 0,
        model_status: "completed",
        model_name: "deepseek-v4-flash",
        model_started_at: new Date("2026-08-01T00:00:00.000Z"),
        model_ended_at: new Date("2026-08-01T00:00:02.000Z"),
        model_warning_count: 1,
        model_error_code: null,
        model_layer_executions: [],
        generated_output_status: "current_available",
        processing_started_at: new Date("2026-08-01T00:00:00.000Z"),
        processing_ended_at: new Date("2026-08-01T00:00:02.000Z")
      }]) as unknown as DatabaseClient
    );

    const result = await application.listSourceFiles({
      knowledgeBaseId: "kb-model",
      directoryId: undefined,
      filters: {
        pathQuery: null,
        sourceFileIdPrefix: null,
        state: null,
        blockingWorkKind: null,
        modelInvocationStatus: "completed",
        generatedOutputStatus: null,
        startedFrom: null,
        startedTo: null,
        endedFrom: null,
        endedTo: null,
        errorState: null,
        errorCodeQuery: null,
        actionState: null
      },
      limit: 20,
      cursor: null
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        resourceRevision: 3,
        contentRevision: 2,
        modelInvocationStatus: "completed",
        modelInvocationModelName: "deepseek-v4-flash",
        modelInvocationStartedAt: "2026-08-01T00:00:00.000Z",
        modelInvocationEndedAt: "2026-08-01T00:00:02.000Z",
        modelInvocationWarningCount: 1,
        modelInvocationErrorCode: null,
        processingStartedAt: "2026-08-01T00:00:00.000Z",
        processingEndedAt: "2026-08-01T00:00:02.000Z"
      })
    ]);
  });

  it("marks correctable deterministic input failures as manual correction", async () => {
    const application = createPostgresStorageVnextAdminResourceRead(
      (async () => [{
        public_id: "source-file-invalid",
        knowledge_base_id: "kb-invalid",
        directory_public_id: null,
        logical_path: "invalid.md",
        active_source_revision_public_id: null,
        resource_revision: 1,
        content_revision: 0,
        created_at: new Date("2026-08-01T00:00:00.000Z"),
        updated_at: new Date("2026-08-01T00:00:02.000Z"),
        source_revision_public_id: "source-revision-invalid",
        checksum_sha256: "a".repeat(64),
        byte_count: 12,
        content_type: "text/markdown; charset=utf-8",
        generated_path: null,
        job_public_id: "document-job-invalid",
        job_state: "error",
        required_work_count: 8,
        completed_work_count: 0,
        active_work_kinds: [],
        blocking_work_kind: "prepare",
        retrying_work_kind: null,
        safe_error_code: "semantic_source_metadata_invalid",
        safe_error_message: "Source metadata is invalid.",
        retryable: false,
        retry_count: 0,
        model_status: "not_required",
        model_name: null,
        model_started_at: null,
        model_ended_at: null,
        model_warning_count: 0,
        model_error_code: null,
        model_layer_executions: [],
        generated_output_status: "unavailable",
        processing_started_at: new Date("2026-08-01T00:00:00.000Z"),
        processing_ended_at: new Date("2026-08-01T00:00:02.000Z")
      }]) as unknown as DatabaseClient
    );

    const result = await application.listSourceFiles({
      knowledgeBaseId: "kb-invalid",
      directoryId: undefined,
      filters: emptySourceFileFilters(),
      limit: 20,
      cursor: null
    });

    expect(result.items[0]?.terminalFailure).toMatchObject({
      code: "semantic_source_metadata_invalid",
      retryKind: "none"
    });
  });

  it("reads content revision from the current content pointer instead of resource revision", async () => {
    const queries: string[] = [];
    const application = createPostgresStorageVnextAdminResourceRead(
      ((strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return Promise.resolve([]);
      }) as unknown as DatabaseClient
    );

    await application.listSourceFiles({
      knowledgeBaseId: "kb-content-revision",
      directoryId: undefined,
      filters: emptySourceFileFilters(),
      limit: 20,
      cursor: null
    });

    expect(queries[0]).toContain("active.activation_sequence AS content_revision");
  });

  it("returns matching directory entries before unified-index file matches", async () => {
    const application = createPostgresStorageVnextAdminRead({
      sql: ((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("knowledge_base_sequences")) {
          return Promise.resolve([{
            knowledge_base_id: "kb-1",
            activation_revision: 1
          }]);
        }
        return Promise.resolve(query.includes("directory_paths")
          ? [directoryRow("pages")] : []);
      }) as unknown as DatabaseClient,
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

  it("rejects malformed tree cursors before returning an empty unreleased tree", async () => {
    const application = createPostgresStorageVnextAdminRead({
      sql: (async () => []) as unknown as DatabaseClient,
      catalog: {
        async getKnowledgeBase() {
          return {
            publicId: "kb-unreleased",
            name: "Unreleased",
            description: null,
            revision: 1,
            visibility: "current",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z"
          };
        }
      } as unknown as StorageVnextCatalogReadPort,
      search: {
        async search() {
          return { items: [], nextCursor: null };
        }
      } as StorageVnextSearchQueryPort
    });

    await expect(application.listTree({
      knowledgeBaseId: "kb-unreleased",
      parentPath: "",
      entryType: null,
      query: null,
      limit: 20,
      cursor: "invalid"
    })).resolves.toEqual({ ok: false, code: "INVALID_PAGINATION" });
    await expect(application.searchFiles({
      knowledgeBaseId: "kb-unreleased",
      query: "boundary",
      limit: 20,
      cursor: "invalid"
    })).resolves.toEqual({ ok: false, code: "INVALID_PAGINATION" });
  });

  it("counts only uploaded source pages in a generated directory", async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      return Promise.resolve(query.includes("knowledge_base_sequences")
        ? [{ knowledge_base_id: "kb-source-count", activation_revision: 1 }]
        : []);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminRead({
      sql,
      catalog: {
        async getKnowledgeBase() {
          return {
            publicId: "kb-source-count",
            name: "Source count",
            description: null,
            revision: 1,
            visibility: "current",
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z"
          };
        }
      } as unknown as StorageVnextCatalogReadPort,
      search: null
    });

    await application.listTree({
      knowledgeBaseId: "kb-source-count",
      parentPath: "pages",
      entryType: null,
      query: null,
      limit: 20,
      cursor: null
    });

    expect(queries[1]).toMatch(
      /child\.logical_path LIKE path\.logical_path \|\| '\/%'\s+AND child\.source_file_public_id IS NOT NULL/u
    );
  });

  it("returns generated file path matches before unified-index source matches", async () => {
    let searchCalls = 0;
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("knowledge_base_sequences")) {
        return Promise.resolve([{
          knowledge_base_id: "kb-generated-search",
          activation_revision: 1
        }]);
      }
      if (query.includes("FROM focowiki.generated_page_heads page")
        && !query.includes("directory_paths")) {
        return Promise.resolve([generatedFileRow("_graph/index.md", "graph")]);
      }
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminRead({
      sql,
      catalog: {
        async getKnowledgeBase() {
          return {
            publicId: "kb-generated-search",
            name: "Generated search",
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
      search: {
        async search() {
          searchCalls += 1;
          return { items: [], nextCursor: null };
        }
      } as StorageVnextSearchQueryPort
    });

    const result = await application.searchFiles({
      knowledgeBaseId: "kb-generated-search",
      query: "_graph",
      limit: 5,
      cursor: null
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{
          entry: {
            logicalPath: "_graph/index.md",
            entryType: "file",
            fileKind: "graph_index",
            deletable: false
          },
          ancestors: [{ logicalPath: "_graph", entryType: "directory" }]
        }],
        nextCursor: null
      }
    });
    expect(searchCalls).toBe(1);
  });

  it("filters stale search-provider hits after their source ownership is deleted", async () => {
    const application = createPostgresStorageVnextAdminRead({
      sql: (async () => []) as unknown as DatabaseClient,
      catalog: {
        async getKnowledgeBase() {
          return {
            publicId: "kb-stale-search",
            name: "Stale search",
            description: null,
            revision: 2,
            visibility: "current",
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z"
          };
        },
        async listSourceFilesByPublicIds() {
          return [];
        }
      } as unknown as StorageVnextCatalogReadPort,
      search: {
        async search() {
          return {
            items: [{
              publicId: "generated-stale",
              sourceFilePublicId: "source-stale",
              logicalPath: "pages/deleted.md",
              title: "Deleted",
              snippet: null,
              score: 1,
              kind: "file",
              metadata: {}
            }],
            nextCursor: null
          };
        }
      } as StorageVnextSearchQueryPort
    });

    const result = await application.searchFiles({
      knowledgeBaseId: "kb-stale-search",
      query: "deleted",
      limit: 5,
      cursor: null
    });

    expect(result).toMatchObject({
      ok: true,
      value: { items: [], nextCursor: null }
    });
  });

  it("derives distinct stable ids for generated directories in tree and search queries", async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminRead({
      sql,
      catalog: {
        async getKnowledgeBase() {
          return {
            publicId: "kb-generated-directories",
            name: "Generated directories",
            description: null,
            revision: 1,
            visibility: "current",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:00.000Z"
          };
        },
        async listSourceFilesByPublicIds() {
          return [];
        }
      } as unknown as StorageVnextCatalogReadPort,
      search: {
        async search() {
          return { items: [], nextCursor: null };
        }
      } as StorageVnextSearchQueryPort
    });

    await application.listTree({
      knowledgeBaseId: "kb-generated-directories",
      parentPath: "",
      entryType: null,
      query: null,
      limit: 20,
      cursor: null
    });
    await application.searchFiles({
      knowledgeBaseId: "kb-generated-directories",
      query: "index",
      limit: 20,
      cursor: null
    });

    expect(queries).toHaveLength(5);
    for (const query of [queries[1], queries[3]]) {
      expect(query).toContain("focowiki.public_generated_directory_id");
      expect(query).not.toContain("resolve_release_directory_summaries");
    }
    expect(queries[4]).toContain("focowiki.public_generated_file_id");
    expect(queries.join("\n")).not.toContain("release_roots");
  });
});

function emptySourceFileFilters() {
  return {
    pathQuery: null,
    sourceFileIdPrefix: null,
    state: null,
    blockingWorkKind: null,
    currentStage: null,
    modelInvocationStatus: null,
    generatedOutputStatus: null,
    startedFrom: null,
    startedTo: null,
    endedFrom: null,
    endedTo: null,
    errorState: null,
    errorCodeQuery: null,
    actionState: null
  };
}

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

function generatedFileRow(logicalPath: string, entryKind: string) {
  return {
    record_id: "generated:record",
    logical_path: logicalPath,
    parent_path: logicalPath.slice(0, logicalPath.lastIndexOf("/")),
    entry_type: "file" as const,
    source_file_public_id: null,
    source_directory_public_id: null,
    entry_kind: entryKind,
    direct_directory_count: 0,
    direct_file_count: 0,
    descendant_file_count: 0,
    resource_revision: null
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
