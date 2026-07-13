import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresAdminRepositories } from "../src/db/admin-repositories.js";
import { createPostgresHardDeleteRepository } from "../src/db/hard-delete-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("Admin timestamp cursor integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repositories = createPostgresAdminRepositories(sql);
  const hardDelete = createPostgresHardDeleteRepository(sql);
  const knowledgeBaseId = "kb-timestamp-cursor-integration";

  afterAll(async () => {
    await cleanup();
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id LIKE 'kb-cursor-list-%'`;
    await sql.end({ timeout: 5 });
  });

  it("does not skip rows sharing a PostgreSQL microsecond timestamp", async () => {
    await cleanup();
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Timestamp cursor integration')
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, name, relative_path, path_key, active_revision_id,
          processing_status, publication_dirty_at, created_at
        )
        SELECT
          'source-file-cursor-' || lpad(item::text, 3, '0'),
          ${knowledgeBaseId},
          'cursor/source-' || item,
          'text/markdown; charset=utf-8',
          1,
          repeat('a', 64),
          'file-' || lpad(item::text, 3, '0') || '.md',
          'folder/file-' || lpad(item::text, 3, '0') || '.md',
          'folder/file-' || lpad(item::text, 3, '0') || '.md',
          'source-revision-cursor-' || lpad(item::text, 3, '0'),
          'completed',
          '2026-07-10 12:00:00.123456+00'::timestamptz,
          '2026-07-10 12:00:00.123456+00'::timestamptz
        FROM generate_series(1, 120) AS item
      `;
      await transaction`
        INSERT INTO focowiki.source_file_events (
          id, knowledge_base_id, source_file_id, stage_key, message_key,
          severity, created_at
        )
        SELECT
          'source-event-cursor-' || lpad(item::text, 3, '0'),
          ${knowledgeBaseId},
          'source-file-cursor-001',
          'metadata_resolution',
          'source_file_metadata_resolved',
          'info',
          '2026-07-10 12:00:00.123456+00'::timestamptz
        FROM generate_series(1, 120) AS item
      `;
      await transaction`
        INSERT INTO focowiki.releases (
          id, knowledge_base_id, bundle_root_key, generated_at, published_at,
          file_count, manifest_checksum_sha256, created_at
        )
        SELECT
          'release-cursor-' || lpad(item::text, 3, '0'),
          ${knowledgeBaseId},
          'cursor/release-' || item,
          '2026-07-10 12:00:00.123456+00'::timestamptz,
          '2026-07-10 12:00:00.123456+00'::timestamptz,
          0,
          repeat('b', 64),
          '2026-07-10 12:00:00.123456+00'::timestamptz
        FROM generate_series(1, 120) AS item
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, created_at
        )
        SELECT
          'source-revision-cursor-' || lpad(item::text, 3, '0'),
          ${knowledgeBaseId},
          'source-file-cursor-' || lpad(item::text, 3, '0'),
          1,
          'cursor/source-' || item,
          'text/markdown; charset=utf-8',
          1,
          repeat('a', 64),
          '2026-07-10 12:00:00.123456+00'::timestamptz
        FROM generate_series(1, 120) AS item
      `;
    });

    const sourceFileIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repositories.files!.listSourceFiles({
        knowledgeBaseId,
        limit: 50,
        cursor,
        fileNameQuery: null,
        fileIdQuery: null,
        processingStatus: null,
        processingStage: null,
        generatedOutputStatus: null,
        modelInvocationStatus: null,
        errorState: null,
        errorCodeQuery: null,
        actionState: null,
        startedFrom: null,
        startedTo: null,
        endedFrom: null,
        endedTo: null
      });
      sourceFileIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(sourceFileIds).toHaveLength(120);
    expect(new Set(sourceFileIds).size).toBe(120);

    const sourceEventIds: string[] = [];
    cursor = null;
    do {
      const page = await repositories.files!.listSourceFileEvents!({
        knowledgeBaseId,
        sourceFileId: "source-file-cursor-001",
        limit: 50,
        cursor
      });
      sourceEventIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sourceEventIds).toHaveLength(120);
    expect(new Set(sourceEventIds).size).toBe(120);

    const dirtySourceFileIds: string[] = [];
    cursor = null;
    do {
      const page = await repositories.files!.listDirtySourceFiles!({
        knowledgeBaseId,
        limit: 50,
        cursor
      });
      dirtySourceFileIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(dirtySourceFileIds).toHaveLength(120);
    expect(new Set(dirtySourceFileIds).size).toBe(120);

    const releaseIds: string[] = [];
    cursor = null;
    do {
      const page = await repositories.files!.listReleases({
        knowledgeBaseId,
        limit: 50,
        cursor
      });
      releaseIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(releaseIds).toHaveLength(120);
    expect(new Set(releaseIds).size).toBe(120);
  });

  it("paginates knowledge bases created in one transaction", async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id LIKE 'kb-cursor-list-%'`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name, created_at, updated_at)
      SELECT
        'kb-cursor-list-' || lpad(item::text, 3, '0'),
        'Cursor list integration ' || item,
        '2026-07-10 12:00:00.123456+00'::timestamptz,
        '2026-07-10 12:00:00.123456+00'::timestamptz
      FROM generate_series(1, 120) AS item
    `;

    const knowledgeBaseIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repositories.knowledgeBases.listKnowledgeBases({
        limit: 50,
        cursor,
        query: "Cursor list integration"
      });
      knowledgeBaseIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(knowledgeBaseIds).toHaveLength(120);
    expect(new Set(knowledgeBaseIds).size).toBe(120);
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id LIKE 'kb-cursor-list-%'`;
  });

  async function cleanup() {
    const exists = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.knowledge_bases
      WHERE id = ${knowledgeBaseId}
    `;
    if ((exists[0]?.count ?? 0) > 0) {
      await hardDelete.purgeKnowledgeBaseData({
        jobId: "worker-job-timestamp-cursor-cleanup",
        knowledgeBaseId,
        batchSize: 500
      });
    }
  }
});
