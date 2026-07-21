import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const failures = [
  {
    key: "metadata",
    code: "PROJECTION_WRITE_FAILED",
    message: "Immutable object upload metadata verification failed"
  },
  {
    key: "byte-budget",
    code: "PROJECTION_WRITE_FAILED",
    message: "Projection shard exceeds the configured byte budget"
  },
  {
    key: "dead-letter",
    code: "PUBLICATION_JOB_DEAD_LETTER",
    message: "Projection write will be retried"
  }
] as const;

describeDatabase("large-scale runtime publication error recovery migration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_v8_recovery_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    for (const migration of [
      "001_production_admin_web.sql",
      "002_tree_graph_storage_reconciliation.sql",
      "003_bounded_publication_recovery.sql",
      "004_immutable_object_contention_recovery.sql",
      "005_publication_retry_budget_recovery.sql",
      "006_publication_continuation_recovery.sql",
      "007_publication_write_livelock_recovery.sql"
    ] as const) {
      await sql.unsafe(readMigrationSql(migration));
    }
    for (const failure of failures) await seedFailure(sql, failure);
    await sql.unsafe(readMigrationSql("008_large_scale_ingestion_runtime.sql"));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("requeues every recoverable production failure without mixing legacy partial projections", async () => {
    const jobs = await sql<Array<{
      generation_id: string;
      status: string;
      attempt_count: number;
      last_error_code: string | null;
    }>>`
      SELECT generation_id, status, attempt_count, last_error_code
      FROM focowiki.role_jobs
      WHERE knowledge_base_id LIKE 'kb-v8-recovery-%'
      ORDER BY generation_id
    `;
    expect(jobs).toHaveLength(failures.length);
    expect(jobs.every((job) =>
      job.status === "queued" && job.attempt_count === 0 && job.last_error_code === null
    )).toBe(true);

    const impacts = await sql<Array<{ status: string; attempt_count: number }>>`
      SELECT status, attempt_count
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id LIKE 'kb-v8-recovery-%'
      ORDER BY id
    `;
    expect(impacts).toHaveLength(failures.length * 3);
    expect(impacts.filter((impact) =>
      impact.status === "pending" && impact.attempt_count === 0
    )).toHaveLength(failures.length * 3);
  });

  it("removes stale failed-candidate references and unowned write reservations", async () => {
    const references = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.generation_object_refs
      WHERE knowledge_base_id LIKE 'kb-v8-recovery-%'
    `;
    const writes = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.immutable_objects
      WHERE object_key LIKE 'objects/v8-recovery/%'
    `;
    expect(references[0]?.count).toBe(0);
    expect(writes[0]?.count).toBe(0);
  });

  it("returns affected source tasks to pending publication with no stale terminal error", async () => {
    const sources = await sql<Array<{
      processing_status: string;
      processing_stage: string;
      generated_output_status: string;
      terminal_failure_code: string | null;
      terminal_failure_correlation_id: string | null;
    }>>`
      SELECT processing_status, processing_stage, generated_output_status,
             terminal_failure_code, terminal_failure_correlation_id
      FROM focowiki.source_files
      WHERE knowledge_base_id LIKE 'kb-v8-recovery-%'
      ORDER BY id
    `;
    expect(sources).toHaveLength(failures.length);
    expect(sources.every((source) =>
      source.processing_status === "completed"
      && source.processing_stage === "projection_generation"
      && source.generated_output_status === "pending"
      && source.terminal_failure_code === null
      && source.terminal_failure_correlation_id === null
    )).toBe(true);
  });

  it("installs the optimized schema generation after recovery is staged", async () => {
    expect(await sql<Array<{ generation: string }>>`
      SELECT generation FROM focowiki.runtime_generation WHERE singleton = true
    `).toEqual([{ generation: "large-scale-ingestion-runtime-v8" }]);
  });
});

async function seedFailure(
  sql: postgres.Sql,
  failure: (typeof failures)[number]
): Promise<void> {
  const knowledgeBaseId = `kb-v8-recovery-${failure.key}`;
  const activeGenerationId = `generation-v8-recovery-${failure.key}-active`;
  const failedGenerationId = `generation-v8-recovery-${failure.key}-failed`;
  const sourceFileId = `source-v8-recovery-${failure.key}`;
  const sourceRevisionId = `revision-v8-recovery-${failure.key}`;
  const factId = `fact-v8-recovery-${failure.key}`;
  const objectChecksum = createHash("sha256")
    .update(`v8-recovery-${failure.key}`)
    .digest("hex");
  const settings = {
    publication: {
      mode: "batch",
      batchSize: 100,
      intervalSeconds: 300,
      impactBatchSize: 50,
      impactConcurrency: 4,
      directoryIndexMaxEntries: 100,
      directoryIndexMaxBytes: 65_536
    }
  };

  await sql`
    INSERT INTO focowiki.knowledge_bases (id, name)
    VALUES (${knowledgeBaseId}, ${`V8 recovery ${failure.key}`})
  `;
  await sql`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state,
      root_manifest_checksum_sha256, root_manifest_object_key,
      activated_at, failed_at, safe_error_code, safe_error_message
    ) VALUES
      (${activeGenerationId}, ${knowledgeBaseId}, NULL, 'active',
       ${"ab".repeat(32)}, ${`objects/${failure.key}-active`}, now(), NULL, NULL, NULL),
      (${failedGenerationId}, ${knowledgeBaseId}, ${activeGenerationId}, 'failed',
       NULL, NULL, NULL, now(), ${failure.code}, ${failure.message})
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
        ${sourceFileId}, ${knowledgeBaseId}, ${`source/${failure.key}.md`},
        'text/markdown', 10, ${"cd".repeat(32)}, 'failed',
        'projection_generation', now(), now(), 'unavailable',
        'projection_generation', ${failure.code}, ${failure.message}, now(),
        'publication', ${failedGenerationId}, ${`${failure.key}.md`},
        ${`${failure.key}.md`}, ${`${failure.key}.md`}, ${sourceRevisionId}
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      ) VALUES (
        ${sourceRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
        ${`source/${failure.key}.md`}, 'text/markdown', 10,
        ${"cd".repeat(32)}, 'completed'
      )
    `;
  });
  await sql`
    INSERT INTO focowiki.publication_change_facts (
      id, knowledge_base_id, source_file_id, source_revision_id,
      kind, path, resource_revision, generation_id
    ) VALUES (
      ${factId}, ${knowledgeBaseId}, ${sourceFileId}, ${sourceRevisionId},
      'source_created', ${`${failure.key}.md`}, 1, ${failedGenerationId}
    )
  `;
  await sql`
    INSERT INTO focowiki.publication_progress (
      knowledge_base_id, generation_id, stage, processed_impact_count,
      total_impact_count, completed_at, safe_error_code, safe_error_message
    ) VALUES (
      ${knowledgeBaseId}, ${failedGenerationId}, 'failed', 1, 2, now(),
      ${failure.code}, ${failure.message}
    )
  `;
  await sql`
    INSERT INTO focowiki.publication_impacts (
      id, knowledge_base_id, generation_id, projection_kind,
      projection_key, record_identity, action, status,
      attempt_count, completed_at, last_error_code, last_error_message
    ) VALUES
      (${`impact-v8-recovery-${failure.key}-completed`}, ${knowledgeBaseId},
       ${failedGenerationId}, 'root', 'index.md', 'index.md',
       'upsert', 'completed', 1, now(), NULL, NULL),
      (${`impact-v8-recovery-${failure.key}-failed`}, ${knowledgeBaseId},
       ${failedGenerationId}, 'search', 'search/v2/0001', ${sourceFileId},
       'upsert', 'failed', 3, now(), ${failure.code}, ${failure.message}),
      (${`impact-v8-recovery-${failure.key}-cancelled`}, ${knowledgeBaseId},
       ${failedGenerationId}, 'root', 'schema.md', 'schema.md',
       'upsert', 'cancelled', 0, now(), ${failure.code}, ${failure.message})
  `;
  await sql`
    INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
    VALUES
      (${`impact-v8-recovery-${failure.key}-completed`}, ${factId}),
      (${`impact-v8-recovery-${failure.key}-failed`}, ${factId}),
      (${`impact-v8-recovery-${failure.key}-cancelled`}, ${factId})
  `;
  await sql`
    INSERT INTO focowiki.immutable_objects (
      checksum_sha256, format_version, object_key, content_type, size_bytes,
      lifecycle_state, verified_at, write_token, write_started_at
    ) VALUES (
      ${objectChecksum}, 1, ${`objects/v8-recovery/${failure.key}`},
      'application/json; charset=utf-8', 64, 'writing', NULL,
      ${`write-token-${failure.key}`}, now() - interval '1 hour'
    )
  `;
  await sql`
    INSERT INTO focowiki.generation_object_refs (
      generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
      action, checksum_sha256, format_version, logical_path
    ) VALUES (
      ${failedGenerationId}, ${knowledgeBaseId}, 'root', 'index.md',
      ${`file-v8-recovery-${failure.key}`}, 'upsert', ${objectChecksum}, 1, 'index.md'
    )
  `;
  await sql`
    INSERT INTO focowiki.role_jobs (
      id, role, kind, knowledge_base_id, generation_id,
      settings_snapshot_json, status, attempt_count, max_attempts,
      failed_at, last_error_code, last_error_message
    ) VALUES (
      ${`job-v8-recovery-${failure.key}`}, 'publication', 'generation_publication',
      ${knowledgeBaseId}, ${failedGenerationId}, ${sql.json(settings)},
      'dead_letter', 3, 3, now(), ${failure.code}, ${failure.message}
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
