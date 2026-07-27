import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresSourceFileRetryRepository } from "../src/infrastructure/postgres/source-file-retry-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("source file retry repository integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1/unused";
  const databaseName = `focowiki_source_retry_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    await seedFailedPublication();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("resets failed publication subtasks and progress when retrying a source file", async () => {
    const retriedAt = "2026-07-26T01:00:00.000Z";
    const retries = createPostgresSourceFileRetryRepository(sql);

    await expect(retries.accept({
      knowledgeBaseId: "kb-retry-subtask",
      sourceFileId: "source-retry-subtask",
      runAfter: retriedAt,
      maxAttempts: 4
    })).resolves.toMatchObject({
      outcome: "accepted",
      kind: "publication",
      coalesced: false
    });

    expect(await sql<Array<{
      state: string;
      attempt_count: number;
      max_attempts: number;
      processed_count: number;
      last_error_code: string | null;
    }>>`
      SELECT state, attempt_count, max_attempts, processed_count::int,
             last_error_code
      FROM focowiki.publication_subtasks
      WHERE generation_id = 'generation-retry-subtask-failed'
      ORDER BY task_kind
    `).toEqual([
      {
        state: "retry",
        attempt_count: 0,
        max_attempts: 4,
        processed_count: 0,
        last_error_code: null
      }
    ]);

    expect(await sql<Array<{
      stage: string;
      remaining_subtask_count: number;
      running_subtask_count: number;
      failed_subtask_count: number;
      safe_error_code: string | null;
    }>>`
      SELECT stage, remaining_subtask_count::int, running_subtask_count::int,
             failed_subtask_count::int, safe_error_code
      FROM focowiki.publication_progress
      WHERE generation_id = 'generation-retry-subtask-failed'
    `).toEqual([{
      stage: "pending",
      remaining_subtask_count: 1,
      running_subtask_count: 0,
      failed_subtask_count: 0,
      safe_error_code: null
    }]);
  });

  async function seedFailedPublication(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name, active_generation_id)
      VALUES ('kb-retry-subtask', 'Retry subtask', NULL)
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        generation_kind, root_manifest_checksum_sha256,
        root_manifest_object_key, activated_at, failed_at,
        safe_error_code, safe_error_message
      ) VALUES
        (
          'generation-retry-subtask-active', 'kb-retry-subtask', NULL,
          'active', 'normal', ${"11".repeat(32)}, 'objects/retry-active',
          now(), NULL, NULL, NULL
        ),
        (
          'generation-retry-subtask-failed', 'kb-retry-subtask',
          'generation-retry-subtask-active', 'failed', 'normal',
          NULL, NULL, NULL, now(), 'PUBLICATION_RETRIES_EXHAUSTED',
          'Validation failed'
        )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-retry-subtask-active'
      WHERE id = 'kb-retry-subtask'
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          processing_started_at, processing_ended_at, generated_output_status,
          terminal_failure_stage, terminal_failure_code, terminal_failure_message,
          terminal_failure_at, terminal_failure_retry_kind,
          terminal_failure_correlation_id, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          'source-retry-subtask', 'kb-retry-subtask', 'source/retry.md',
          'text/markdown', 10, ${"22".repeat(32)}, 'failed',
          'projection_generation', '2026-07-25T01:00:00.000Z',
          '2026-07-25T01:01:00.000Z', 'unavailable',
          'projection_generation', 'PUBLICATION_RETRIES_EXHAUSTED',
          'Validation failed', now(), 'publication',
          'generation-retry-subtask-failed', 'retry.md', 'retry.md',
          'retry.md', 'revision-retry-subtask'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          'revision-retry-subtask', 'kb-retry-subtask',
          'source-retry-subtask', 1, 'source/retry.md',
          'text/markdown', 10, ${"22".repeat(32)}, 'completed'
        )
      `;
    });
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, source_file_id, source_revision_id, kind,
        path, resource_revision, generation_id
      ) VALUES (
        'fact-retry-subtask', 'kb-retry-subtask', 'source-retry-subtask',
        'revision-retry-subtask', 'source_created', 'retry.md', 1,
        'generation-retry-subtask-failed'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind,
        projection_key, record_identity, action, status,
        attempt_count, completed_at, last_error_code, last_error_message
      ) VALUES (
        'impact-retry-subtask', 'kb-retry-subtask',
        'generation-retry-subtask-failed', 'root', 'index.md', 'index.md',
        'upsert', 'cancelled', 3, now(),
        'PUBLICATION_RETRIES_EXHAUSTED', 'Validation failed'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_progress (
        knowledge_base_id, generation_id, stage,
        processed_impact_count, total_impact_count,
        remaining_subtask_count, running_subtask_count,
        failed_subtask_count, completed_at, safe_error_code,
        safe_error_message
      ) VALUES (
        'kb-retry-subtask', 'generation-retry-subtask-failed', 'failed',
        0, 1, 1, 0, 1, now(), 'PUBLICATION_RETRIES_EXHAUSTED',
        'Validation failed'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_subtasks (
        id, knowledge_base_id, generation_id, task_kind,
        projection_kind, physical_partition, state,
        attempt_count, max_attempts, processed_count, total_count,
        last_error_code, last_error_message, created_at, updated_at
      ) VALUES (
        'subtask-retry-subtask', 'kb-retry-subtask',
        'generation-retry-subtask-failed', 'validation',
        '', 'workflow', 'failed', 3, 3, 0, 1,
        'PUBLICATION_RETRIES_EXHAUSTED', 'Validation failed', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, generation_id, status,
        attempt_count, max_attempts, failed_at, last_error_code,
        last_error_message
      ) VALUES (
        'job-retry-subtask', 'publication', 'generation_publication',
        'kb-retry-subtask', 'generation-retry-subtask-failed',
        'dead_letter', 3, 3, now(), 'PUBLICATION_RETRIES_EXHAUSTED',
        'Validation failed'
      )
    `;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
