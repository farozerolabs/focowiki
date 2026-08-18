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

  it("reads list and detail directly without removed stage summaries", async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const operations = createPostgresStorageVnextOperationRead(sql);

    await operations.list({
      knowledgeBaseId: "kb-operation-summary",
      limit: 20,
      cursor: null
    });
    await operations.get({
      knowledgeBaseId: "kb-operation-summary",
      operationId: "operation-summary"
    });

    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query).not.toContain("processing_operation_summaries");
      expect(query).not.toContain("processing_stage_work_items");
      expect(query).not.toContain("processing_stage_dependencies");
    }
    for (const query of queries.slice(0, 2)) {
      expect(query.replace(/\s+/gu, " ")).toMatch(
        /operation\.operation_kind IN \( ?'upload', 'knowledge_base_metadata', 'source_file_metadata', 'source_replace', 'source_file_move', 'source_directory_move', 'deletion' ?\)/u
      );
    }
    expect(queries[2]).toContain("operation_tombstones");
  });

  it("reports metadata operations with their real public kind", async () => {
    const operations = createPostgresStorageVnextOperationRead(
      (async () => [{
        public_id: "operation-metadata",
        knowledge_base_id: "kb-metadata",
        operation_kind: "knowledge_base_metadata",
        state: "completed",
        expected_resource_revision: 1,
        target_kind: "knowledge_base",
        target_public_id: "kb-metadata",
        candidate_relative_path: null,
        result_summary: {},
        result_code: null,
        created_at: new Date("2026-08-13T00:00:00.000Z"),
        updated_at: new Date("2026-08-13T00:00:01.000Z"),
        completed_at: new Date("2026-08-13T00:00:01.000Z"),
        semantic_total_count: 0,
        semantic_completed_count: 0,
        semantic_pending_count: 0,
        semantic_failed_count: 0,
        semantic_cancelled_count: 0,
        semantic_superseded_count: 0,
        semantic_safe_error_code: null,
        semantic_current_stage_kind: null
      }]) as unknown as DatabaseClient
    );

    await expect(operations.get({
      knowledgeBaseId: "kb-metadata",
      operationId: "operation-metadata"
    })).resolves.toMatchObject({ kind: "knowledge_base_metadata" });
  });

  it.each(["accepted", "validating"])(
    "collapses the internal %s operation state to public processing",
    async (state) => {
      const operations = createPostgresStorageVnextOperationRead(
        (async () => [{
          public_id: `operation-${state}`,
          knowledge_base_id: "kb-state",
          operation_kind: "source_file_move",
          state,
          expected_resource_revision: 1,
          target_kind: "source_file",
          target_public_id: "source-file-state",
          candidate_relative_path: "moved.md",
          result_summary: null,
          result_code: null,
          created_at: new Date("2026-08-18T00:00:00.000Z"),
          updated_at: new Date("2026-08-18T00:00:01.000Z"),
          completed_at: null,
          document_total_count: 0,
          document_waiting_count: 0,
          document_processing_count: 0,
          document_available_count: 0,
          document_error_count: 0,
          document_deleting_count: 0,
          document_cancelled_count: 0,
          document_superseded_count: 0
        }]) as unknown as DatabaseClient
      );

      await expect(operations.get({
        knowledgeBaseId: "kb-state",
        operationId: `operation-${state}`
      })).resolves.toMatchObject({ state: "processing", completedAt: null });
    }
  );

  it("includes every internal nonterminal state in the public processing filter", async () => {
    const queryValues: unknown[][] = [];
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      queryValues.push(values);
      return Promise.resolve([]);
    }) as unknown as DatabaseClient;
    const operations = createPostgresStorageVnextOperationRead(sql);

    await operations.list({
      knowledgeBaseId: "kb-processing-filter",
      states: ["processing"],
      limit: 20,
      cursor: null
    });

    expect(queryValues.flat()).toContainEqual(["accepted", "validating", "processing"]);
  });

  it("reports live upload document progress through the public operation", async () => {
    const operations = createPostgresStorageVnextOperationRead(
      (async () => [{
        public_id: "operation-upload-progress",
        knowledge_base_id: "kb-upload-progress",
        operation_kind: "upload",
        state: "processing",
        expected_resource_revision: null,
        target_kind: "knowledge_base",
        target_public_id: "kb-upload-progress",
        candidate_relative_path: null,
        result_summary: null,
        result_code: null,
        created_at: new Date("2026-08-14T00:00:00.000Z"),
        updated_at: new Date("2026-08-14T00:00:01.000Z"),
        completed_at: null,
        document_total_count: 5,
        document_waiting_count: 1,
        document_processing_count: 1,
        document_available_count: 2,
        document_error_count: 1,
        document_deleting_count: 0,
        document_cancelled_count: 0,
        document_superseded_count: 0
      }]) as unknown as DatabaseClient
    );

    await expect(operations.get({
      knowledgeBaseId: "kb-upload-progress",
      operationId: "operation-upload-progress"
    })).resolves.toMatchObject({
      kind: "upload",
      state: "processing",
      result: {
        totalCount: 5,
        waitingCount: 1,
        processingCount: 1,
        availableCount: 2,
        failedCount: 1,
        deletingCount: 0,
        cancelledCount: 0,
        supersededCount: 0
      }
    });
  });

  it("keeps persisted terminal upload counts after document jobs are purged", async () => {
    const operations = createPostgresStorageVnextOperationRead(
      (async () => [{
        public_id: "operation-upload-purged",
        knowledge_base_id: "kb-upload-purged",
        operation_kind: "upload",
        state: "completed",
        expected_resource_revision: null,
        target_kind: "knowledge_base",
        target_public_id: "kb-upload-purged",
        candidate_relative_path: null,
        result_summary: {
          totalCount: 1,
          waitingCount: 0,
          processingCount: 0,
          availableCount: 0,
          failedCount: 0,
          deletingCount: 0,
          cancelledCount: 1,
          supersededCount: 0
        },
        result_code: "UPLOAD_DOCUMENTS_TERMINAL",
        created_at: new Date("2026-08-17T00:00:00.000Z"),
        updated_at: new Date("2026-08-17T00:00:01.000Z"),
        completed_at: new Date("2026-08-17T00:00:01.000Z"),
        document_total_count: 0,
        document_waiting_count: 0,
        document_processing_count: 0,
        document_available_count: 0,
        document_error_count: 0,
        document_deleting_count: 0,
        document_cancelled_count: 0,
        document_superseded_count: 0
      }]) as unknown as DatabaseClient
    );

    await expect(operations.get({
      knowledgeBaseId: "kb-upload-purged",
      operationId: "operation-upload-purged"
    })).resolves.toMatchObject({
      state: "completed",
      result: {
        totalCount: 1,
        availableCount: 0,
        cancelledCount: 1
      }
    });
  });

  it("does not expose a successful internal result code as an operation error", async () => {
    const row = {
      public_id: "operation-success-code",
      knowledge_base_id: "kb-success-code",
      operation_kind: "source_replace",
      state: "completed",
      expected_resource_revision: 1,
      target_kind: "source_file",
      target_public_id: "source-file-success-code",
      candidate_relative_path: null,
      result_summary: {},
      result_code: "DOCUMENT_AVAILABLE",
      created_at: new Date("2026-08-17T00:00:00.000Z"),
      updated_at: new Date("2026-08-17T00:00:01.000Z"),
      completed_at: new Date("2026-08-17T00:00:01.000Z"),
      document_total_count: 0,
      document_waiting_count: 0,
      document_processing_count: 0,
      document_available_count: 0,
      document_error_count: 0,
      document_deleting_count: 0,
      document_cancelled_count: 0,
      document_superseded_count: 0
    };
    const operations = createPostgresStorageVnextOperationRead(
      (async () => [row]) as unknown as DatabaseClient
    );

    await expect(operations.get({
      knowledgeBaseId: row.knowledge_base_id,
      operationId: row.public_id
    })).resolves.toMatchObject({ state: "completed", errorCode: null });
  });
});
