import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";
import { PublicationGenerationBusyError } from "../src/domain/publication.js";
import { createPostgresPublicationGenerationRepository } from "../src/infrastructure/postgres/publication-generation-repository.js";
import { createPostgresSourceFileRetryRepository } from "../src/infrastructure/postgres/source-file-retry-repository.js";

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
    await sql.unsafe(readMigrationSql("004_immutable_object_contention_recovery.sql"));
    await seedPublicationRetryExhaustion(sql);
    await sql.unsafe(readMigrationSql("005_publication_retry_budget_recovery.sql"));
    await seedPublicationContinuationExhaustion(sql);
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
      { id: "generation-contention-current", state: "building" },
      { id: "generation-contention-failed", state: "failed" }
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
      stage: "pending",
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

  it("requeues a generation that exhausted the outer job before its impacts", async () => {
    const generations = await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = 'kb-retry-budget'
      ORDER BY id
    `;
    expect(generations).toEqual([
      { id: "generation-retry-budget-active", state: "active" },
      { id: "generation-retry-budget-current", state: "building" },
      { id: "generation-retry-budget-failed", state: "failed" }
    ]);

    const impacts = await sql<Array<{
      id: string;
      status: string;
      attempt_count: number;
    }>>`
      SELECT id, status, attempt_count
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = 'kb-retry-budget'
      ORDER BY id
    `;
    expect(impacts).toEqual([
      { id: "impact-retry-budget-cancelled", status: "pending", attempt_count: 0 },
      { id: "impact-retry-budget-completed", status: "completed", attempt_count: 1 }
    ]);

    const jobs = await sql<Array<{ status: string; attempt_count: number }>>`
      SELECT status, attempt_count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = 'kb-retry-budget'
        AND generation_id = 'generation-retry-budget-failed'
    `;
    expect(jobs).toEqual([{ status: "queued", attempt_count: 0 }]);

    const sources = await sql<Array<{
      processing_status: string;
      generated_output_status: string;
      terminal_failure_code: string | null;
    }>>`
      SELECT processing_status, generated_output_status, terminal_failure_code
      FROM focowiki.source_files
      WHERE knowledge_base_id = 'kb-retry-budget'
        AND id = 'source-retry-budget'
    `;
    expect(sources).toEqual([{
      processing_status: "completed",
      generated_output_status: "pending",
      terminal_failure_code: null
    }]);
  });

  it("requeues a generation exhausted by a continuation-only state", async () => {
    const generations = await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = 'kb-continuation'
      ORDER BY id
    `;
    expect(generations).toEqual([
      { id: "generation-continuation-active", state: "active" },
      { id: "generation-continuation-current", state: "building" },
      { id: "generation-continuation-failed", state: "failed" }
    ]);

    const impacts = await sql<Array<{
      id: string;
      status: string;
      attempt_count: number;
    }>>`
      SELECT id, status, attempt_count
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = 'kb-continuation'
      ORDER BY id
    `;
    expect(impacts).toEqual([
      { id: "impact-continuation-cancelled", status: "pending", attempt_count: 0 },
      { id: "impact-continuation-completed", status: "completed", attempt_count: 1 }
    ]);

    const jobs = await sql<Array<{ status: string; attempt_count: number }>>`
      SELECT status, attempt_count
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = 'kb-continuation'
        AND generation_id = 'generation-continuation-failed'
    `;
    expect(jobs).toEqual([{ status: "queued", attempt_count: 0 }]);

    const sources = await sql<Array<{
      processing_status: string;
      generated_output_status: string;
      terminal_failure_code: string | null;
    }>>`
      SELECT processing_status, generated_output_status, terminal_failure_code
      FROM focowiki.source_files
      WHERE knowledge_base_id = 'kb-continuation'
        AND id = 'source-continuation'
    `;
    expect(sources).toEqual([{
      processing_status: "completed",
      generated_output_status: "pending",
      terminal_failure_code: null
    }]);
  });

  it("resumes recovered generations serially after the active publication finishes", async () => {
    const generations = createPostgresPublicationGenerationRepository(sql);

    await expect(generations.freezeGeneration({
      knowledgeBaseId: "kb-continuation",
      generationId: "generation-continuation-failed",
      frozenAt: "2026-07-19T12:00:00.000Z"
    })).rejects.toBeInstanceOf(PublicationGenerationBusyError);

    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'superseded'
      WHERE id = 'generation-continuation-current'
    `;
    const resumed = await generations.freezeGeneration({
      knowledgeBaseId: "kb-continuation",
      generationId: "generation-continuation-failed",
      frozenAt: "2026-07-19T12:00:01.000Z"
    });

    expect(resumed).toMatchObject({
      generationId: "generation-continuation-failed",
      predecessorGenerationId: "generation-continuation-active",
      state: "building"
    });
  });

  it("queues a manual publication retry behind the current generation", async () => {
    await seedPublicationExhaustion(sql, {
      key: "manual-retry",
      message: "Storage is temporarily unavailable"
    });
    const retries = createPostgresSourceFileRetryRepository(sql);
    const runAfter = new Date(Date.now() + 1_000).toISOString();

    const accepted = await retries.accept({
      knowledgeBaseId: "kb-manual-retry",
      sourceFileId: "source-manual-retry",
      runAfter,
      maxAttempts: 3
    });

    expect(accepted).toMatchObject({
      outcome: "accepted",
      kind: "publication",
      coalesced: false
    });
    expect((await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.publication_generations
      WHERE id = 'generation-manual-retry-failed'
    `)[0]?.state).toBe("failed");
    expect((await sql<Array<{ status: string }>>`
      SELECT status
      FROM focowiki.role_jobs
      WHERE generation_id = 'generation-manual-retry-failed'
    `)[0]?.status).toBe("queued");
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
      ('generation-contention-current', 'kb-contention', 'generation-contention-active',
       'building', 'normal', NULL, NULL, NULL, NULL, NULL, NULL),
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

async function seedPublicationRetryExhaustion(sql: postgres.Sql): Promise<void> {
  await seedPublicationExhaustion(sql, {
    key: "retry-budget",
    message: "Projection write will be retried"
  });
}

async function seedPublicationContinuationExhaustion(sql: postgres.Sql): Promise<void> {
  await seedPublicationExhaustion(sql, {
    key: "continuation",
    message: "Publication impacts are pending"
  });
}

async function seedPublicationExhaustion(
  sql: postgres.Sql,
  input: { key: string; message: string }
): Promise<void> {
  const knowledgeBaseId = `kb-${input.key}`;
  const activeGenerationId = `generation-${input.key}-active`;
  const currentGenerationId = `generation-${input.key}-current`;
  const failedGenerationId = `generation-${input.key}-failed`;
  const sourceFileId = `source-${input.key}`;
  const sourceRevisionId = `revision-${input.key}`;
  await sql`
    INSERT INTO focowiki.knowledge_bases (id, name)
    VALUES (${knowledgeBaseId}, ${`${input.key} recovery test`})
  `;
  await sql`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state,
      generation_kind, root_manifest_checksum_sha256,
      root_manifest_object_key, activated_at, failed_at,
      safe_error_code, safe_error_message
    ) VALUES
      (${activeGenerationId}, ${knowledgeBaseId}, NULL, 'active', 'normal',
       ${"12".repeat(32)}, ${`objects/${input.key}-active`}, now(), NULL, NULL, NULL),
      (${currentGenerationId}, ${knowledgeBaseId}, ${activeGenerationId}, 'building',
       'normal', NULL, NULL, NULL, NULL, NULL, NULL),
      (${failedGenerationId}, ${knowledgeBaseId},
       ${activeGenerationId}, 'failed', 'normal', NULL, NULL, NULL, now(),
       'PUBLICATION_RETRIES_EXHAUSTED', ${input.message})
  `;
  await sql`
    UPDATE focowiki.knowledge_bases
    SET active_generation_id = ${activeGenerationId}
    WHERE id = ${knowledgeBaseId}
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
        ${sourceFileId}, ${knowledgeBaseId}, ${`source/${input.key}.md`},
        'text/markdown', 10, ${"34".repeat(32)}, 'failed',
        'projection_generation', now(), now(), 'unavailable',
        'projection_generation', 'PUBLICATION_RETRIES_EXHAUSTED',
        ${input.message}, now(), 'publication',
        ${failedGenerationId}, ${`${input.key}.md`}, ${`${input.key}.md`},
        ${`${input.key}.md`}, ${sourceRevisionId}
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      ) VALUES (
        ${sourceRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
        ${`source/${input.key}.md`}, 'text/markdown', 10, ${"34".repeat(32)},
        'completed'
      )
    `;
  });
  await sql`
    INSERT INTO focowiki.publication_change_facts (
      id, knowledge_base_id, source_file_id, source_revision_id, kind,
      path, resource_revision, generation_id
    ) VALUES (
      ${`fact-${input.key}`}, ${knowledgeBaseId}, ${sourceFileId},
      ${sourceRevisionId}, 'source_created', ${`${input.key}.md`}, 1,
      ${failedGenerationId}
    )
  `;
  await sql`
    INSERT INTO focowiki.publication_progress (
      knowledge_base_id, generation_id, stage, processed_impact_count,
      total_impact_count, completed_at, safe_error_code, safe_error_message
    ) VALUES (
      ${knowledgeBaseId}, ${failedGenerationId}, 'failed', 1, 2, now(),
      'PUBLICATION_RETRIES_EXHAUSTED', ${input.message}
    )
  `;
  await sql`
    INSERT INTO focowiki.publication_impacts (
      id, knowledge_base_id, generation_id, projection_kind,
      projection_key, record_identity, action, status,
      attempt_count, completed_at, last_error_code, last_error_message
    ) VALUES
      (${`impact-${input.key}-completed`}, ${knowledgeBaseId},
       ${failedGenerationId}, 'root', 'index.md', 'index.md',
       'upsert', 'completed', 1, now(), NULL, NULL),
      (${`impact-${input.key}-cancelled`}, ${knowledgeBaseId},
       ${failedGenerationId}, 'root', 'schema.md', 'schema.md',
       'upsert', 'cancelled', 2, now(), 'PUBLICATION_RETRIES_EXHAUSTED', ${input.message})
  `;
  await sql`
    INSERT INTO focowiki.role_jobs (
      id, role, kind, knowledge_base_id, generation_id, status,
      attempt_count, max_attempts, failed_at, last_error_code,
      last_error_message
    ) VALUES (
      ${`job-${input.key}`}, 'publication', 'generation_publication',
      ${knowledgeBaseId}, ${failedGenerationId}, 'dead_letter',
      3, 3, now(), 'PUBLICATION_RETRIES_EXHAUSTED', ${input.message}
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
