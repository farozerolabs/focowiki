import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPostgresStorageVnextSourceEventRepository } from
  "../src/storage-vnext/source-events/postgres-repository.js";

describe("document source event repository", () => {
  it("derives truthful events from retained document jobs", async () => {
    const sql = vi.fn(async () => [
      row("job-waiting", "waiting", null, 0, null),
      row("job-indexing", "processing", "content_projection", 1, null),
      row("job-error", "error", null, 2, "DOCUMENT_INVALID")
    ]);
    const repository = createPostgresStorageVnextSourceEventRepository(sql as never);

    const first = await repository.list({
      knowledgeBaseId: "knowledge-base-events",
      sourceFileId: "source-file-events",
      limit: 2,
      cursor: null
    });

    expect(first.items).toMatchObject([
      { publicId: "job-waiting", stageKey: "waiting", sequence: 1 },
      { publicId: "job-indexing", stageKey: "content_projection", sequence: 2 }
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(repository.list({
      knowledgeBaseId: "another-knowledge-base",
      sourceFileId: "source-file-events",
      limit: 2,
      cursor: first.nextCursor
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("contains no runtime dependency on the removed event table", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/source-events/postgres-repository.ts"
    ), "utf8");
    expect(source).toContain("focowiki.document_processing_jobs");
    expect(source).not.toContain("focowiki.source_event_summaries");
    expect(source).not.toContain("search_publication");
  });
});

function row(
  publicId: string,
  state: string,
  blockingWorkKind: string | null,
  attempts: number,
  safeErrorCode: string | null
) {
  return {
    public_id: publicId,
    knowledge_base_id: "knowledge-base-events",
    source_file_public_id: "source-file-events",
    source_revision_public_id: `revision-${publicId}`,
    state,
    blocking_work_kind: blockingWorkKind,
    total_attempt_count: attempts,
    started_at: state === "waiting" ? null : new Date("2026-08-14T00:00:01.000Z"),
    terminal_at: state === "error" ? new Date("2026-08-14T00:00:03.000Z") : null,
    safe_error_code: safeErrorCode,
    accepted_at: new Date(`2026-08-14T00:00:0${attempts}.000Z`),
    expires_at: new Date("2026-09-14T00:00:00.000Z")
  };
}
