import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { failPostgresDocumentOperation } from
  "../src/document-indexing/infrastructure/postgres-upload-operation-aggregation.js";

describe("document operation failure ownership", () => {
  it("leaves maintenance terminalization to the maintenance coordinator", async () => {
    const sql = vi.fn(async (..._args: unknown[]) => [{
      operation_kind: "maintenance",
      expires_at: "2026-08-17T00:00:00.000Z"
    }]);

    await failPostgresDocumentOperation(sql as unknown as DatabaseClient, {
      knowledgeBaseId: "knowledge-base-one",
      operationPublicId: "maintenance-one",
      documentJobPublicId: "document-job-one",
      sourceFilePublicId: "source-file-one",
      sourceRevisionPublicId: "source-revision-one",
      errorCode: "document_failed",
      safeMessage: null,
      completedAt: "2026-08-16T00:00:00.000Z"
    });

    expect(sql).toHaveBeenCalledTimes(1);
  });
});
