import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresRoleJobRepository } from "../src/infrastructure/postgres/role-job-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("role job repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresRoleJobRepository(sql);
  const knowledgeBaseId = "kb-role-job-integration";

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.role_heartbeats WHERE worker_id LIKE 'integration-%'`;
    await sql`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.deletion_intents WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Role job integration')
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.role_heartbeats WHERE worker_id LIKE 'integration-%'`;
    await sql`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.deletion_intents WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql.end({ timeout: 5 });
  });

  it("isolates roles, records heartbeats, retries, and reclaims stale jobs", async () => {
    await insertJob("source-a", "source", "source_processing");
    await insertJob("maintenance-a", "maintenance", "projection_audit");

    const source = await repository.claim({
      role: "source",
      workerId: "integration-source-a",
      limit: 4,
      now: "2026-07-17T01:00:00.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(source.map((job) => job.id)).toEqual(["source-a"]);
    expect(source[0]?.attemptCount).toBe(1);

    await repository.heartbeat({
      role: "source",
      workerId: "integration-source-a",
      jobIds: ["source-a"],
      now: "2026-07-17T01:00:05.000Z"
    });
    await repository.retry({
      jobId: "source-a",
      workerId: "integration-source-a",
      code: "TRANSIENT",
      message: "retry",
      failedAt: "2026-07-17T01:00:06.000Z",
      runAfter: "2026-07-17T01:00:10.000Z"
    });
    const retried = await repository.claim({
      role: "source",
      workerId: "integration-source-b",
      limit: 1,
      now: "2026-07-17T01:00:11.000Z",
      staleBefore: "2026-07-17T01:00:00.000Z"
    });
    expect(retried[0]).toMatchObject({ id: "source-a", attemptCount: 2 });

    await sql`
      UPDATE focowiki.role_jobs
      SET locked_at = '2026-07-17T00:00:00.000Z',
          heartbeat_at = '2026-07-17T00:00:00.000Z'
      WHERE id = 'source-a'
    `;
    const recovered = await repository.claim({
      role: "source",
      workerId: "integration-source-c",
      limit: 1,
      now: "2026-07-17T02:00:00.000Z",
      staleBefore: "2026-07-17T01:59:00.000Z"
    });
    expect(recovered[0]).toMatchObject({ id: "source-a", attemptCount: 3 });
  });

  it("allows only one running publication per knowledge base", async () => {
    await insertJob("publication-a", "publication", "generation_publication");
    await insertJob("publication-b", "publication", "generation_publication");

    const [first, second] = await Promise.all([
      repository.claim({
        role: "publication",
        workerId: "integration-publication-a",
        limit: 1,
        now: "2026-07-17T01:00:00.000Z",
        staleBefore: "2026-07-17T00:59:00.000Z"
      }),
      repository.claim({
        role: "publication",
        workerId: "integration-publication-b",
        limit: 1,
        now: "2026-07-17T01:00:00.000Z",
        staleBefore: "2026-07-17T00:59:00.000Z"
      })
    ]);

    expect(first.length + second.length).toBe(1);
    const running = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND role = 'publication'
        AND status = 'running'
    `;
    expect(running[0]?.count).toBe(1);
  });

  it("enqueues idempotent role work and fences queued source work for deletion", async () => {
    const sourceFileId = "source-file-role-delete";
    const sourceRevisionId = "source-revision-role-delete";
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id, catalog_generation
        ) VALUES (
          'deletion-role-integration', ${knowledgeBaseId}, 'source_file',
          ${sourceFileId}, 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          active_revision_id, deletion_intent_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'delete.md', 'delete.md', 'delete.md',
          'source/delete.md', 'text/markdown', 1,
          ${"a".repeat(64)}, 'queued', ${sourceRevisionId}, 'deletion-role-integration'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, metadata_json,
          processing_status
        ) VALUES (
          ${sourceRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'source/delete.md', 'text/markdown', 1, ${"a".repeat(64)},
          ${transaction.json({})}, 'queued'
        )
      `;
    });
    const first = await repository.enqueue({
      id: "role-job-operation-a",
      role: "source",
      kind: "resource_operation",
      knowledgeBaseId,
      sourceFileId: null,
      sourceRevisionId: null,
      generationId: null,
      payload: { operationId: "operation-a" },
      settingsSnapshot: {},
      runAfter: "2026-07-17T01:00:00.000Z",
      maxAttempts: 3,
      createdAt: "2026-07-17T01:00:00.000Z"
    });
    const replay = await repository.enqueue({
      id: "role-job-operation-a",
      role: "source",
      kind: "resource_operation",
      knowledgeBaseId,
      sourceFileId: null,
      sourceRevisionId: null,
      generationId: null,
      payload: { operationId: "operation-a" },
      settingsSnapshot: {},
      runAfter: "2026-07-17T01:00:01.000Z",
      maxAttempts: 3,
      createdAt: "2026-07-17T01:00:01.000Z"
    });
    expect(replay.id).toBe(first.id);

    await repository.enqueue({
      id: "role-job-source-delete",
      role: "source",
      kind: "source_processing",
      knowledgeBaseId,
      sourceFileId,
      sourceRevisionId,
      generationId: null,
      payload: {},
      settingsSnapshot: {},
      runAfter: "2026-07-17T01:00:00.000Z",
      maxAttempts: 3,
      createdAt: "2026-07-17T01:00:00.000Z"
    });
    const cancelled = await repository.cancelSourceJobsForDeletionIntent({
      knowledgeBaseId,
      deletionIntentId: "deletion-role-integration",
      cancelledAt: "2026-07-17T01:00:02.000Z",
      code: "SOURCE_DELETED",
      message: "Source work was cancelled by deletion."
    });
    expect(cancelled).toBe(1);
    const rows = await sql<Array<{ status: string }>>`
      SELECT status FROM focowiki.role_jobs WHERE id = 'role-job-source-delete'
    `;
    expect(rows[0]?.status).toBe("cancelled");
  });

  async function insertJob(id: string, role: string, kind: string): Promise<void> {
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, payload_json, settings_snapshot_json,
        run_after, max_attempts
      ) VALUES (
        ${id}, ${role}, ${kind}, ${knowledgeBaseId}, ${sql.json({})}, ${sql.json({})},
        '2026-07-17T00:00:00.000Z', 3
      )
    `;
  }
});
