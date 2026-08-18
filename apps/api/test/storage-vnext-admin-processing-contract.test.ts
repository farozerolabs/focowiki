import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextAdminProcessing } from
  "../src/storage-vnext/api/postgres-admin-processing.js";

describe("storage vNext Admin document processing summary", () => {
  it("reports only current document job states", async () => {
    const queries: string[] = [];
    const sql = vi.fn((strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return Promise.resolve([{
        waiting_count: 2,
        processing_count: 3,
        available_count: 5,
        error_count: 1,
        oldest_waiting_at: new Date("2026-08-14T00:00:00.000Z")
      }]);
    }) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminProcessing({
      sql,
      catalog: {
        async getKnowledgeBase() {
          return { publicId: "kb-document-jobs", visibility: "current" };
        }
      } as never
    });

    await expect(application.getProcessingSummary({
      knowledgeBaseId: "kb-document-jobs"
    })).resolves.toEqual({
      ok: true,
      value: {
        waitingCount: 2,
        processingCount: 3,
        availableCount: 5,
        errorCount: 1,
        oldestWaitingAt: "2026-08-14T00:00:00.000Z"
      }
    });
    expect(queries[0]).toContain("focowiki.document_processing_jobs");
    expect(queries[0]).toContain(
      "job.source_revision_public_id = active.current_source_revision_public_id"
    );
    expect(queries[0]).not.toContain("publication");
    expect(queries[0]).not.toContain("processing_stage");
    expect(queries[0]).not.toContain("release_");
    expect(queries[0]).toContain("min(job.accepted_at)");
    expect(queries[0]).not.toContain("job.available_at");
  });

  it("returns not found without querying job state", async () => {
    const sql = vi.fn(async () => []) as unknown as DatabaseClient;
    const application = createPostgresStorageVnextAdminProcessing({
      sql,
      catalog: { async getKnowledgeBase() { return null; } } as never
    });

    await expect(application.getProcessingSummary({ knowledgeBaseId: "missing" }))
      .resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    expect(sql).not.toHaveBeenCalled();
  });
});
