import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("publication failure recovery migration integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_recovery_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await sql.unsafe(readMigrationSql("001_production_admin_web.sql"));
    await sql.unsafe(readMigrationSql("002_tree_graph_storage_reconciliation.sql"));
    await seedStalledPublication(sql);
    await sql.unsafe(readMigrationSql("003_bounded_publication_recovery.sql"));
    await seedImmutableObjectContention(sql);
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("fails the stuck candidate and requeues its open successor", async () => {
    const generations = await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = 'kb-recovery'
      ORDER BY id
    `;
    expect(generations).toEqual([
      { id: "generation-active", state: "active" },
      { id: "generation-open", state: "open" },
      { id: "generation-stuck", state: "failed" }
    ]);

    const impacts = await sql<Array<{ generation_id: string; status: string }>>`
      SELECT generation_id, status
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = 'kb-recovery'
      ORDER BY generation_id
    `;
    expect(impacts).toEqual([
      { generation_id: "generation-open", status: "pending" },
      { generation_id: "generation-stuck", status: "cancelled" }
    ]);

    const jobs = await sql<Array<{
      generation_id: string;
      status: string;
      attempt_count: number;
    }>>`
      SELECT generation_id, status, attempt_count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = 'kb-recovery'
      ORDER BY generation_id
    `;
    expect(jobs).toEqual([
      { generation_id: "generation-open", status: "queued", attempt_count: 0 },
      { generation_id: "generation-stuck", status: "dead_letter", attempt_count: 3 }
    ]);
    expect((await sql<Array<{ generation: string }>>`
      SELECT generation FROM focowiki.runtime_generation WHERE singleton = true
    `)[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);
  });

  it("requeues the failed generation affected by immutable-object contention", async () => {
    const generations = await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = 'kb-contention'
      ORDER BY id
    `;
    expect(generations).toEqual([
      { id: "generation-contention-active", state: "active" },
      { id: "generation-contention-failed", state: "building" }
    ]);

    const impacts = await sql<Array<{
      id: string;
      status: string;
      attempt_count: number;
    }>>`
      SELECT id, status, attempt_count
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = 'kb-contention'
      ORDER BY id
    `;
    expect(impacts).toEqual([
      { id: "impact-contention-cancelled", status: "pending", attempt_count: 0 },
      { id: "impact-contention-completed", status: "completed", attempt_count: 1 }
    ]);

    const jobs = await sql<Array<{ status: string; attempt_count: number }>>`
      SELECT status, attempt_count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = 'kb-contention'
        AND generation_id = 'generation-contention-failed'
    `;
    expect(jobs).toEqual([{ status: "queued", attempt_count: 0 }]);

    const progress = await sql<Array<{
      stage: string;
      processed_impact_count: number;
      safe_error_code: string | null;
    }>>`
      SELECT stage, processed_impact_count::int, safe_error_code
      FROM focowiki.publication_progress
      WHERE knowledge_base_id = 'kb-contention'
        AND generation_id = 'generation-contention-failed'
    `;
    expect(progress).toEqual([{
      stage: "projection",
      processed_impact_count: 1,
      safe_error_code: null
    }]);

    const sources = await sql<Array<{
      processing_status: string;
      processing_stage: string;
      generated_output_status: string;
      terminal_failure_code: string | null;
    }>>`
      SELECT processing_status, processing_stage, generated_output_status,
             terminal_failure_code
      FROM focowiki.source_files
      WHERE knowledge_base_id = 'kb-contention'
        AND id = 'source-contention'
    `;
    expect(sources).toEqual([{
      processing_status: "completed",
      processing_stage: "projection_generation",
      generated_output_status: "pending",
      terminal_failure_code: null
    }]);
  });
});

async function seedStalledPublication(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (id, name)
    VALUES ('kb-recovery', 'Recovery test')
  `;
  await sql`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state,
      generation_kind, root_manifest_checksum_sha256,
      root_manifest_object_key, activated_at
    ) VALUES
      ('generation-active', 'kb-recovery', NULL, 'active', 'normal',
       ${"ab".repeat(32)}, 'objects/active', now()),
      ('generation-stuck', 'kb-recovery', 'generation-active', 'building', 'normal',
       NULL, NULL, NULL),
      ('generation-open', 'kb-recovery', 'generation-active', 'open', 'normal',
       NULL, NULL, NULL)
  `;
  await sql`
    INSERT INTO focowiki.publication_progress (
      knowledge_base_id, generation_id, stage, total_impact_count
    ) VALUES ('kb-recovery', 'generation-stuck', 'projection', 1)
  `;
  await sql`
    INSERT INTO focowiki.publication_impacts (
      id, knowledge_base_id, generation_id, projection_kind,
      projection_key, record_identity, action, status
    ) VALUES
      ('impact-stuck', 'kb-recovery', 'generation-stuck', 'search',
       'search/v1/0001', 'record-stuck', 'upsert', 'pending'),
      ('impact-open', 'kb-recovery', 'generation-open', 'search',
       'search/v1/0001', 'record-open', 'upsert', 'pending')
  `;
  await sql`
    INSERT INTO focowiki.role_jobs (
      id, role, kind, knowledge_base_id, generation_id, status,
      attempt_count, max_attempts, failed_at, last_error_code,
      last_error_message
    ) VALUES
      ('job-stuck', 'publication', 'generation_publication', 'kb-recovery',
       'generation-stuck', 'dead_letter', 3, 3, now(),
       'PROJECTION_WRITE_RETRY', 'Projection write will be retried'),
      ('job-open', 'publication', 'generation_publication', 'kb-recovery',
       'generation-open', 'dead_letter', 3, 3, now(),
       'ROLE_JOB_FAILED', 'Candidate generation could not be frozen')
  `;
}

async function seedImmutableObjectContention(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (id, name)
    VALUES ('kb-contention', 'Contention recovery test')
  `;
  await sql`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state,
      generation_kind, root_manifest_checksum_sha256,
      root_manifest_object_key, activated_at, failed_at,
      safe_error_code, safe_error_message
    ) VALUES
      ('generation-contention-active', 'kb-contention', NULL, 'active', 'normal',
       ${"cd".repeat(32)}, 'objects/contention-active', now(), NULL, NULL, NULL),
      ('generation-contention-failed', 'kb-contention', 'generation-contention-active',
       'failed', 'normal', NULL, NULL, NULL, now(), 'PROJECTION_WRITE_FAILED',
       'Immutable object write is already in progress')
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
        'source-contention', 'kb-contention', 'source/contention.md',
        'text/markdown', 10, ${"ef".repeat(32)}, 'failed',
        'projection_generation', now(), now(), 'unavailable',
        'projection_generation', 'PROJECTION_WRITE_FAILED',
        'Immutable object write is already in progress', now(), 'publication',
        'generation-contention-failed', 'contention.md', 'contention.md',
        'contention.md', 'revision-contention'
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      ) VALUES (
        'revision-contention', 'kb-contention', 'source-contention', 1,
        'source/contention.md', 'text/markdown', 10, ${"ef".repeat(32)},
        'completed'
      )
    `;
  });
  await sql`
    INSERT INTO focowiki.publication_change_facts (
      id, knowledge_base_id, source_file_id, source_revision_id, kind,
      path, resource_revision, generation_id
    ) VALUES (
      'fact-contention', 'kb-contention', 'source-contention',
      'revision-contention', 'source_created', 'contention.md', 1,
      'generation-contention-failed'
    )
  `;
  await sql`
    INSERT INTO focowiki.publication_progress (
      knowledge_base_id, generation_id, stage, processed_impact_count,
      total_impact_count, completed_at, safe_error_code, safe_error_message
    ) VALUES (
      'kb-contention', 'generation-contention-failed', 'failed', 1, 2, now(),
      'PROJECTION_WRITE_FAILED', 'Immutable object write is already in progress'
    )
  `;
  await sql`
    INSERT INTO focowiki.publication_impacts (
      id, knowledge_base_id, generation_id, projection_kind,
      projection_key, record_identity, action, status,
      attempt_count, completed_at, last_error_code, last_error_message
    ) VALUES
      ('impact-contention-completed', 'kb-contention', 'generation-contention-failed',
       'root', 'index.md', 'index.md', 'upsert', 'completed', 1, now(), NULL, NULL),
      ('impact-contention-cancelled', 'kb-contention', 'generation-contention-failed',
       'root', 'schema.md', 'schema.md', 'upsert', 'cancelled', 3, now(),
       'PROJECTION_WRITE_FAILED', 'Immutable object write is already in progress')
  `;
  await sql`
    INSERT INTO focowiki.role_jobs (
      id, role, kind, knowledge_base_id, generation_id, status,
      attempt_count, max_attempts, failed_at, last_error_code,
      last_error_message
    ) VALUES (
      'job-contention', 'publication', 'generation_publication', 'kb-contention',
      'generation-contention-failed', 'dead_letter', 3, 3, now(),
      'PROJECTION_WRITE_FAILED', 'Immutable object write is already in progress'
    )
  `;
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
