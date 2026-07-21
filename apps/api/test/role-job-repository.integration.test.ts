import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresRoleJobRepository } from "../src/infrastructure/postgres/role-job-repository.js";
import { createPostgresGenerationAssemblyDispatchRepository } from "../src/infrastructure/postgres/generation-assembly-dispatch-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("role job repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresRoleJobRepository(sql);
  const assemblyDispatcher = createPostgresGenerationAssemblyDispatchRepository(sql);
  const knowledgeBaseId = "kb-role-job-integration";
  const secondKnowledgeBaseId = "kb-role-job-integration-b";

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.role_heartbeats WHERE worker_id LIKE 'integration-%'`;
    await sql`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.deletion_intents WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${secondKnowledgeBaseId}`;
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
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${secondKnowledgeBaseId}`;
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

  it("claims independent knowledge bases up to the publication batch limit", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${secondKnowledgeBaseId}, 'Role job integration B')
    `;
    await insertJob("publication-independent-a", "publication", "generation_publication");
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, payload_json, settings_snapshot_json,
        run_after, max_attempts
      ) VALUES (
        'publication-independent-b', 'publication', 'generation_publication',
        ${secondKnowledgeBaseId}, '{}'::jsonb, '{}'::jsonb,
        '2026-07-17T00:00:00.000Z', 3
      )
    `;

    const claimed = await repository.claim({
      role: "publication",
      workerId: "integration-publication-independent",
      limit: 4,
      now: "2099-07-17T01:00:00.000Z",
      staleBefore: "2099-07-17T00:59:00.000Z"
    });

    expect(claimed.map((job) => job.knowledgeBaseId).sort()).toEqual(
      [knowledgeBaseId, secondKnowledgeBaseId].sort()
    );
  });

  it("claims a scheduled batch publication immediately after upstream work drains", async () => {
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, payload_json, settings_snapshot_json,
        run_after, max_attempts, early_claim_on_upstream_drain
      ) VALUES (
        'publication-drain-aware', 'publication', 'generation_publication',
        ${knowledgeBaseId}, '{}'::jsonb, '{}'::jsonb,
        '2026-07-17T02:00:00.000Z', 3, true
      )
    `;

    const claimed = await repository.claim({
      role: "publication",
      workerId: "integration-publication-drain-aware",
      limit: 1,
      now: "2026-07-17T01:00:00.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });

    expect(claimed.map((job) => job.id)).toEqual(["publication-drain-aware"]);
    expect(claimed[0]?.runAfter).toBe("2026-07-17T01:00:00.000Z");
  });

  it("keeps a future batch publication queued until every upstream lane drains", async () => {
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, payload_json, settings_snapshot_json,
        run_after, max_attempts, early_claim_on_upstream_drain
      ) VALUES (
        'publication-upstream-blocked', 'publication', 'generation_publication',
        ${knowledgeBaseId}, '{}'::jsonb, '{}'::jsonb,
        '2026-07-17T02:00:00.000Z', 3, true
      ), (
        'source-upstream-blocker', 'source', 'source_processing',
        ${knowledgeBaseId}, '{}'::jsonb, '{}'::jsonb,
        '2026-07-17T00:00:00.000Z', 3, false
      ), (
        'assembly-upstream-blocker', 'publication', 'generation_assembly',
        ${knowledgeBaseId}, '{}'::jsonb, '{}'::jsonb,
        '2026-07-17T02:00:00.000Z', 3, false
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_sessions (
        id, knowledge_base_id, state, idempotency_key,
        declared_file_count, declared_byte_count, expires_at
      ) VALUES (
        'upload-upstream-blocker', ${knowledgeBaseId}, 'uploading',
        'upload-upstream-blocker', 1, 1, '2026-07-18T00:00:00.000Z'
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          active_revision_id
        ) VALUES (
          'source-file-upstream-blocker', ${knowledgeBaseId}, 'blocked.md',
          'blocked.md', 'blocked.md', 'source/blocked.md', 'text/markdown', 1,
          ${"b".repeat(64)}, 'queued', 'source-revision-upstream-blocker'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, metadata_json,
          processing_status
        ) VALUES (
          'source-revision-upstream-blocker', ${knowledgeBaseId},
          'source-file-upstream-blocker', 1, 'source/blocked.md',
          'text/markdown', 1, ${"b".repeat(64)}, '{}'::jsonb, 'queued'
        )
      `;
    });
    await sql`
      INSERT INTO focowiki.source_dispatch_markers (
        id, knowledge_base_id, source_file_id, source_revision_id, status
      ) VALUES (
        'dispatch-upstream-blocker', ${knowledgeBaseId},
        'source-file-upstream-blocker', 'source-revision-upstream-blocker', 'pending'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, kind, resource_revision, assembly_state,
        planning_payload_json, settings_snapshot_json, publication_max_attempts
      ) VALUES (
        'fact-upstream-blocker', ${knowledgeBaseId}, 'knowledge_base_metadata_changed',
        1, 'pending', '{}'::jsonb, '{}'::jsonb, 3
      )
    `;
    const blocked = await repository.claim({
      role: "publication",
      workerId: "integration-publication-upstream-blocked",
      limit: 1,
      now: "2026-07-17T01:00:00.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(blocked).toEqual([]);

    await sql`UPDATE focowiki.role_jobs SET status = 'completed' WHERE id IN ('source-upstream-blocker', 'assembly-upstream-blocker')`;
    await sql`UPDATE focowiki.upload_sessions SET state = 'completed' WHERE id = 'upload-upstream-blocker'`;
    await sql`UPDATE focowiki.source_dispatch_markers SET status = 'dispatched' WHERE id = 'dispatch-upstream-blocker'`;
    await sql`UPDATE focowiki.publication_change_facts SET assembly_state = 'assembled' WHERE id = 'fact-upstream-blocker'`;

    const claimed = await repository.claim({
      role: "publication",
      workerId: "integration-publication-upstream-drained",
      limit: 1,
      now: "2026-07-17T01:00:01.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(claimed.map((job) => job.id)).toEqual(["publication-upstream-blocked"]);
  });

  it("does not bypass publication retry backoff after an early claim", async () => {
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, payload_json, settings_snapshot_json,
        run_after, max_attempts, early_claim_on_upstream_drain
      ) VALUES (
        'publication-retry-backoff', 'publication', 'generation_publication',
        ${knowledgeBaseId}, '{}'::jsonb, '{}'::jsonb,
        '2026-07-17T02:00:00.000Z', 3, true
      )
    `;
    const first = await repository.claim({
      role: "publication",
      workerId: "integration-publication-retry-first",
      limit: 1,
      now: "2026-07-17T01:00:00.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(first.map((job) => job.id)).toEqual(["publication-retry-backoff"]);
    await repository.retry({
      jobId: "publication-retry-backoff",
      workerId: "integration-publication-retry-first",
      code: "TRANSIENT",
      message: "retry later",
      failedAt: "2026-07-17T01:00:01.000Z",
      runAfter: "2026-07-17T01:01:00.000Z"
    });

    const blocked = await repository.claim({
      role: "publication",
      workerId: "integration-publication-retry-second",
      limit: 1,
      now: "2026-07-17T01:00:30.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(blocked).toEqual([]);
  });

  it("clears stale failure diagnostics when a job is rescheduled", async () => {
    await insertJob("publication-reschedule", "publication", "generation_publication");
    await sql`
      UPDATE focowiki.role_jobs
      SET last_error_code = 'PROJECTION_WRITE_RETRY',
          last_error_message = 'Projection write will be retried'
      WHERE id = 'publication-reschedule'
    `;
    const jobs = await repository.claim({
      role: "publication",
      workerId: "integration-publication-reschedule",
      limit: 1,
      now: "2026-07-17T01:00:00.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(jobs[0]?.id).toBe("publication-reschedule");

    await repository.reschedule({
      jobId: "publication-reschedule",
      workerId: "integration-publication-reschedule",
      runAfter: "2026-07-17T01:00:05.000Z",
      rescheduledAt: "2026-07-17T01:00:01.000Z"
    });

    const rows = await sql<Array<{
      status: string;
      attempt_count: number;
      last_error_code: string | null;
      last_error_message: string | null;
    }>>`
      SELECT status, attempt_count, last_error_code, last_error_message
      FROM focowiki.role_jobs
      WHERE id = 'publication-reschedule'
    `;
    expect(rows).toEqual([{
      status: "queued",
      attempt_count: 0,
      last_error_code: null,
      last_error_message: null
    }]);
  });

  it("dispatches and requeues generation assembly directly from pending change facts", async () => {
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, kind, resource_revision, assembly_state,
        planning_payload_json, settings_snapshot_json, publication_max_attempts
      ) VALUES (
        'fact-generation-assembly-dispatch', ${knowledgeBaseId},
        'knowledge_base_metadata_changed', 1, 'pending',
        '{}'::jsonb, '{}'::jsonb, 3
      )
    `;
    await expect(assemblyDispatcher.dispatchPending({
      now: "2026-07-17T01:00:00.000Z",
      limit: 10
    })).resolves.toBe(1);
    const first = await repository.claim({
      role: "publication",
      workerId: "integration-assembly-a",
      limit: 1,
      now: "2026-07-17T01:00:00.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(first).toHaveLength(1);
    await repository.complete({
      jobId: first[0]!.id,
      workerId: "integration-assembly-a",
      completedAt: "2026-07-17T01:00:01.000Z"
    });
    const pending = await sql<Array<{ status: string; attempt_count: number }>>`
      SELECT status, attempt_count
      FROM focowiki.role_jobs
      WHERE id = ${first[0]!.id}
    `;
    expect(pending).toEqual([{ status: "queued", attempt_count: 0 }]);

    await sql`
      UPDATE focowiki.publication_change_facts
      SET assembly_state = 'assembled', assembled_at = now()
      WHERE id = 'fact-generation-assembly-dispatch'
    `;
    const second = await repository.claim({
      role: "publication",
      workerId: "integration-assembly-b",
      limit: 1,
      now: "2026-07-17T01:00:02.000Z",
      staleBefore: "2026-07-17T00:59:00.000Z"
    });
    expect(second).toHaveLength(1);
    await repository.complete({
      jobId: second[0]!.id,
      workerId: "integration-assembly-b",
      completedAt: "2026-07-17T01:00:03.000Z"
    });
    const completed = await sql<Array<{ status: string; completed_at: Date | null }>>`
      SELECT status, completed_at
      FROM focowiki.role_jobs
      WHERE id = ${second[0]!.id}
    `;
    expect(completed[0]?.status).toBe("completed");
    expect(completed[0]?.completed_at).not.toBeNull();
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
