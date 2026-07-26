import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LexicalRebuildSettingsSnapshot } from "../src/application/ports/lexical-rebuild-work-repository.js";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql
} from "../src/db/migrations.js";
import {
  buildExplainAnalyzeSql,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";
import { createPostgresLexicalRebuildWorkRepository } from "../src/infrastructure/postgres/lexical-rebuild-work-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeScale = databaseUrl
  && process.env.FOCOWIKI_RUN_SCALE_QUERY_PLAN_TESTS === "true"
  ? describe
  : describe.skip;
const settings: LexicalRebuildSettingsSnapshot = {
  concurrency: 4,
  sourceReadConcurrency: 8,
  databaseWriteConcurrency: 2,
  claimBatchSize: 500,
  databaseBatchSize: 50,
  maxInFlightSourceBytes: 64 * 1_024 * 1_024
};

describeScale("lexical rebuild 100k scale integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1/unused";
  const databaseName = `focowiki_lexical_scale_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const repository = createPostgresLexicalRebuildWorkRepository(sql);
  let migrationDurationMs = 0;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrationIndex = MIGRATION_FILES.indexOf("015_lexical_rebuild_worker.sql");
    for (const fileName of MIGRATION_FILES.slice(0, migrationIndex)) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(fileName));
      });
    }
    await seedScaleKnowledgeBase("kb-lexical-scale-10000", 10_000);
    await seedScaleKnowledgeBase("kb-lexical-scale-100000", 100_000);
    const startedAt = performance.now();
    await applyMigrations(sql);
    migrationDurationMs = performance.now() - startedAt;
    await applyMigrations(sql);
    await sql`ANALYZE focowiki.lexical_rebuild_work_items`;
  }, 180_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("adopts 10k and 100k work exactly and keeps repeated migration idempotent", async () => {
    expect(await workCounts()).toEqual([
      {
        knowledge_base_id: "kb-lexical-scale-10000",
        work_count: 10_000,
        pending_source_count: 10_000,
        total_source_count: 10_000
      },
      {
        knowledge_base_id: "kb-lexical-scale-100000",
        work_count: 100_000,
        pending_source_count: 100_000,
        total_source_count: 100_000
      }
    ]);
    expect(migrationDurationMs).toBeLessThan(120_000);
  });

  it.each([
    ["kb-lexical-scale-10000", 10_000],
    ["kb-lexical-scale-100000", 100_000]
  ] as const)("keeps eligible claim plans indexed for %s with %i items", async (
    knowledgeBaseId,
    _sourceCount
  ) => {
    const summary = await explain(`
      SELECT source_file_id
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = '${knowledgeBaseId}'
        AND (
          (state IN ('pending', 'retry') AND next_attempt_at <= now())
          OR (state = 'running' AND lease_expires_at <= now())
        )
      ORDER BY source_file_id
      LIMIT 500
    `);
    expect(summary.sequentialScanRelations).not.toContain(
      "lexical_rebuild_work_items"
    );
    expect(summary.indexNames.some((name) =>
      name.startsWith("lexical_rebuild_work_items_")
    )).toBe(true);
    expect(summary.sharedHitBlocks + summary.sharedReadBlocks).toBeLessThan(5_000);
    expect(summary.executionTimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(500);
  });

  it("claims bounded work across four replicas without duplicate ownership", async () => {
    const startedAt = performance.now();
    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        repository.claimBatch({
          workerId: `scale-worker-${index}`,
          leaseTokenPrefix: `scale-lease-${index}`,
          limit: 500,
          settingsRevision: 1,
          settings,
          now: "2099-07-25T02:00:00.000Z",
          leaseExpiresAt: "2099-07-25T02:05:00.000Z"
        })
      )
    );
    const flattened = claims.flat();
    expect(flattened).toHaveLength(2_000);
    expect(new Set(flattened.map((claim) =>
      `${claim.targetGenerationId}:${claim.sourceFileId}`
    )).size).toBe(2_000);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it("updates one changed and one deleted source without scanning the work corpus", async () => {
    const moved = await explain(`
      UPDATE focowiki.source_files
      SET relative_path = 'moved/scale-99999.md',
          path_key = 'moved/scale-99999.md'
      WHERE knowledge_base_id = 'kb-lexical-scale-100000'
        AND id = 'source-scale-100000-99999'
    `);
    expect(moved.sequentialScanRelations).not.toContain("source_files");
    expect(moved.executionTimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(500);

    const deleted = await explain(`
      UPDATE focowiki.source_files
      SET deleted_at = now()
      WHERE knowledge_base_id = 'kb-lexical-scale-100000'
        AND id = 'source-scale-100000-99998'
    `);
    expect(deleted.sequentialScanRelations).not.toContain("source_files");
    expect(deleted.executionTimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(500);

    expect(await sql<Array<{ source_file_id: string; state: string }>>`
      SELECT source_file_id, state
      FROM focowiki.lexical_rebuild_work_items
      WHERE target_generation_id = 'generation-lexical-scale-100000-target'
        AND source_file_id IN (
          'source-scale-100000-99998',
          'source-scale-100000-99999'
        )
      ORDER BY source_file_id
    `).toEqual([
      { source_file_id: "source-scale-100000-99998", state: "cancelled" },
      { source_file_id: "source-scale-100000-99999", state: "pending" }
    ]);
  });

  it("keeps retry, progress, cleanup, memory, and sessions bounded at 100k", async () => {
    const sessionsBefore = await databaseSessionCount();
    const rssBefore = process.memoryUsage().rss;
    const failedAt = "2099-07-25T03:00:00.000Z";
    const sourceFileId = "source-scale-100000-99997";
    const targetGenerationId = "generation-lexical-scale-100000-target";
    const leaseToken = `scale-retry:${sourceFileId}`;

    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET state = 'running',
          lease_owner = 'scale-retry-worker',
          lease_token = ${leaseToken},
          lease_expires_at = '2099-07-25T03:05:00.000Z',
          heartbeat_at = ${failedAt},
          settings_revision = 1,
          settings_snapshot_json = ${sql.json(settings as never)}
      WHERE target_generation_id = ${targetGenerationId}
        AND source_file_id = ${sourceFileId}
    `;
    await repository.retry({
      workerId: "scale-retry-worker",
      claims: [{
        knowledgeBaseId: "kb-lexical-scale-100000",
        targetGenerationId,
        sourceFileId,
        sourceRevisionId: "revision-scale-100000-99997",
        logicalPath: "pages/scale/99997.md",
        leaseToken,
        attemptCount: 0,
        maxAttempts: 3,
        settingsRevision: 1,
        settings
      }],
      stage: "database_write",
      errorCode: "LEXICAL_DATABASE_SERIALIZATION_RETRY",
      errorMessage: "Lexical projection database serialization conflict",
      failedAt,
      retryDelayMs: 1_000
    });
    expect((await sql<Array<{
      state: string;
      attempt_count: number;
      database_retry_count: number;
    }>>`
      SELECT state, attempt_count, database_retry_count
      FROM focowiki.lexical_rebuild_work_items
      WHERE target_generation_id = ${targetGenerationId}
        AND source_file_id = ${sourceFileId}
    `)[0]).toEqual({
      state: "retry",
      attempt_count: 1,
      database_retry_count: 1
    });

    const progressStartedAt = performance.now();
    const progress = await repository.listProgress();
    expect(progress.some((item) =>
      item.knowledgeBaseId === "kb-lexical-scale-100000"
      && item.total === 99_999
    )).toBe(true);
    expect(performance.now() - progressStartedAt).toBeLessThan(500);

    const cleanupStartedAt = performance.now();
    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id = 'kb-lexical-scale-100000'
    `;
    expect(performance.now() - cleanupStartedAt).toBeLessThan(20_000);
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = 'kb-lexical-scale-100000'
    `)[0]?.count).toBe(0);
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.generation_search_projection_refs
      WHERE knowledge_base_id = 'kb-lexical-scale-100000'
    `)[0]?.count).toBe(0);

    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(128 * 1_024 * 1_024);
    expect(await databaseSessionCount()).toBeLessThanOrEqual(sessionsBefore);
  }, 30_000);

  async function seedScaleKnowledgeBase(
    knowledgeBaseId: string,
    sourceCount: number
  ): Promise<void> {
    const suffix = sourceCount.toString();
    const baseGenerationId = `generation-lexical-scale-${suffix}-base`;
    const targetGenerationId = `generation-lexical-scale-${suffix}-target`;
    await sql.begin(async (transaction) => {
      await transaction`SET CONSTRAINTS ALL DEFERRED`;
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, ${`Lexical scale ${sourceCount}`})
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, format_version, generation_kind, activated_at
        ) VALUES
          (
            ${baseGenerationId}, ${knowledgeBaseId}, NULL,
            'active', 2, 'normal', now()
          ),
          (
            ${targetGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
            'building', 2, 'lexical_rebuild', NULL
          )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${baseGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id, metadata_json
        )
        SELECT
          'source-scale-' || ${suffix} || '-' || value,
          ${knowledgeBaseId},
          'sources/scale-' || ${suffix} || '/' || value || '.md',
          'text/markdown; charset=utf-8',
          100,
          md5(${suffix} || ':' || value::text)
            || md5('checksum:' || ${suffix} || ':' || value::text),
          'completed',
          'generation_activation',
          'visible',
          value || '.md',
          'scale/' || value || '.md',
          'scale/' || value || '.md',
          'revision-scale-' || ${suffix} || '-' || value,
          '{}'::jsonb
        FROM generate_series(0, ${sourceCount - 1}) value
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        )
        SELECT
          'revision-scale-' || ${suffix} || '-' || value,
          ${knowledgeBaseId},
          'source-scale-' || ${suffix} || '-' || value,
          1,
          'sources/scale-' || ${suffix} || '/' || value || '.md',
          'text/markdown; charset=utf-8',
          100,
          md5(${suffix} || ':' || value::text)
            || md5('checksum:' || ${suffix} || ':' || value::text),
          'completed',
          '{}'::jsonb
        FROM generate_series(0, ${sourceCount - 1}) value
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
          knowledge_base_id, target_search_schema_version,
          target_tokenizer_contract_version, target_segmentation_version,
          target_content_profile_version,
          target_graph_lexical_projection_version,
          base_generation_id, target_generation_id, state, phase,
          processed_source_count, total_source_count,
          started_at, updated_at
        ) VALUES (
          ${knowledgeBaseId}, 'body-search-v1', 'tokenizer-scale-v1',
          'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
          ${baseGenerationId}, ${targetGenerationId}, 'running', 'documents',
          0, ${sourceCount}, now(), now()
        )
      `;
    });
  }

  async function workCounts() {
    return sql<Array<{
      knowledge_base_id: string;
      work_count: number;
      pending_source_count: number;
      total_source_count: number;
    }>>`
      SELECT
        rebuild.knowledge_base_id,
        count(item.source_file_id)::int AS work_count,
        rebuild.pending_source_count::int AS pending_source_count,
        rebuild.total_source_count::int AS total_source_count
      FROM focowiki.knowledge_base_lexical_rebuilds rebuild
      JOIN focowiki.lexical_rebuild_work_items item
        ON item.knowledge_base_id = rebuild.knowledge_base_id
       AND item.target_generation_id = rebuild.target_generation_id
      WHERE rebuild.knowledge_base_id LIKE 'kb-lexical-scale-%'
      GROUP BY rebuild.knowledge_base_id,
               rebuild.pending_source_count,
               rebuild.total_source_count
      ORDER BY rebuild.knowledge_base_id
    `;
  }

  async function databaseSessionCount(): Promise<number> {
    return Number((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
    `)[0]?.count ?? 0);
  }

  async function explain(statement: string) {
    return sql.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      const rows = await transaction.unsafe<Array<{ "QUERY PLAN": unknown }>>(
        buildExplainAnalyzeSql(statement)
      );
      return summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
    });
  }
});

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
