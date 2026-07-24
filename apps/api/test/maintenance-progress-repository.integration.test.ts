import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresMaintenanceProgressRepository } from "../src/infrastructure/postgres/maintenance-progress-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("maintenance progress repository integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_maintenance_progress_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresMaintenanceProgressRepository(sql);
  const knowledgeBaseId = "kb-maintenance-progress";
  const otherKnowledgeBaseId = "kb-maintenance-progress-other";

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("returns bounded migration, projection repair, and compaction progress", async () => {
    const summary = await repository.getSummary({ knowledgeBaseId });

    expect(summary).toMatchObject({
      migration: {
        state: "backfilling",
        phase: "projection_segments",
        attemptCount: 2,
        maxAttempts: 5,
        safeErrorCode: null
      },
      lexicalRebuild: {
        state: "running",
        phase: "lexical_profiles",
        searchSchemaVersion: "body-search-v1",
        tokenizerContractVersion: "nodejieba-3.5.8-test",
        segmentationVersion: "body-segmentation-v1",
        contentProfileVersion: "content-profile-v2",
        graphLexicalProjectionVersion: "graph-lexical-v2",
        processedSourceCount: 32,
        totalSourceCount: 100,
        attemptCount: 1,
        maxAttempts: 5,
        safeErrorCode: null
      },
      projectionRepair: {
        repairVersion: 3,
        state: "running",
        phase: "directory",
        attemptCount: 1,
        requiredProjectionKinds: ["tree", "directory", "graph"],
        completedProjectionKinds: ["tree"],
        completedSubtaskCount: 8,
        totalSubtaskCount: 24,
        completedRecordCount: 12_500,
        totalRecordCount: 30_000,
        completedDirectoryCount: 40,
        totalDirectoryCount: 120,
        objectWriteCount: 320,
        objectReuseCount: 1_280,
        retryCount: 2,
        recordsPerSecond: 625,
        rollingBatchLatencyMs: 85,
        lastProgressAt: "2026-07-20T00:00:04.000Z",
        lastHeartbeatAt: "2026-07-20T00:00:04.500Z",
        estimatedCompletionAt: "2026-07-20T00:00:32.000Z",
        safeErrorCode: null
      },
      compaction: {
        active: {
          state: "running",
          attemptCount: 1,
          maxAttempts: 5,
          safeErrorCode: null
        },
        latestCompleted: {
          state: "completed",
          attemptCount: 1,
          maxAttempts: 5
        }
      }
    });
    expect(summary.migration?.startedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(summary.lexicalRebuild?.updatedAt).toBe("2026-07-20T00:00:03.000Z");
    expect(summary.projectionRepair?.updatedAt).toBe("2026-07-20T00:00:04.000Z");
    expect(summary.compaction.active?.queuedAt).toBe("2026-07-20T00:00:01.000Z");
  });

  it("returns empty bounded state for an unknown knowledge base", async () => {
    await expect(repository.getSummary({ knowledgeBaseId: "kb-missing" })).resolves.toEqual({
      migration: null,
      lexicalRebuild: null,
      projectionRepair: null,
      compaction: { active: null, latestCompleted: null }
    });
  });

  it("returns the safe failure details for the latest projection repair", async () => {
    await sql`
      UPDATE focowiki.knowledge_base_projection_repairs
      SET state = 'failed',
          last_error_code = 'PROJECTION_REPAIR_FAILED',
          last_error_message = 'Projection repair validation failed',
          updated_at = '2026-07-20T00:00:05.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND repair_version = 3
    `;

    await expect(repository.getSummary({ knowledgeBaseId })).resolves.toMatchObject({
      projectionRepair: {
        repairVersion: 3,
        state: "failed",
        phase: "directory",
        safeErrorCode: "PROJECTION_REPAIR_FAILED",
        safeErrorMessage: "Projection repair validation failed"
      }
    });
  });

  async function seed(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Maintenance progress'),
             (${otherKnowledgeBaseId}, 'Other maintenance progress')
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, phase, attempt_count, max_attempts,
        started_at, updated_at
      ) VALUES (
        ${knowledgeBaseId}, 'backfilling', 'projection_segments', 2, 5,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:02.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
        knowledge_base_id, target_search_schema_version,
        target_tokenizer_contract_version, target_segmentation_version,
        target_content_profile_version,
        target_graph_lexical_projection_version,
        state, phase, processed_source_count, total_source_count,
        attempt_count, max_attempts, updated_at
      ) VALUES (
        ${knowledgeBaseId}, 'body-search-v1', 'nodejieba-3.5.8-test',
        'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
        'running', 'lexical_profiles', 32, 100, 1, 5,
        '2026-07-20T00:00:03.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, activated_at
      ) VALUES (
        'generation-progress-repair-base', ${knowledgeBaseId}, NULL, 'active',
        2, 'normal', '2026-07-20T00:00:00.000Z'
      ), (
        'generation-progress-repair-target', ${knowledgeBaseId},
        'generation-progress-repair-base', 'building', 2, 'projection_repair', NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id, target_generation_id,
        state, checkpoint_json, current_phase, attempt_count,
        required_projection_kinds, completed_projection_kinds,
        expected_subtask_count, completed_subtask_count,
        expected_record_count, completed_record_count,
        expected_directory_count, completed_directory_count,
        object_write_count, object_reuse_count, retry_count,
        recent_records_per_second, rolling_batch_latency_ms,
        last_progress_at, last_heartbeat_at, estimated_completion_at,
        updated_at
      ) VALUES (
        ${knowledgeBaseId}, 2, 'generation-progress-repair-base', NULL,
        'completed', ${sql.json({
          treeComplete: true,
          navigationComplete: true,
          graphComplete: true
        })}, 'completed', 1,
        ARRAY['tree', 'directory', 'graph'], ARRAY['tree', 'directory', 'graph'],
        24, 24, 30000, 30000, 120, 120, 640, 2560, 1,
        700, 75, '2026-07-20T00:00:03.000Z',
        '2026-07-20T00:00:03.000Z', '2026-07-20T00:00:03.000Z',
        '2026-07-20T00:00:03.000Z'
      ), (
        ${knowledgeBaseId}, 3, 'generation-progress-repair-base',
        'generation-progress-repair-target', 'running', ${sql.json({
          treeComplete: true,
          navigationComplete: false,
          graphComplete: false
        })}, 'directory', 1,
        ARRAY['tree', 'directory', 'graph'], ARRAY['tree'],
        24, 8, 30000, 12500, 120, 40, 320, 1280, 2,
        625, 85, '2026-07-20T00:00:04.000Z',
        '2026-07-20T00:00:04.500Z', '2026-07-20T00:00:32.000Z',
        '2026-07-20T00:00:04.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_compaction_jobs (
        id, knowledge_base_id, projection_kind, logical_partition,
        active_generation_id, expected_segment_ids, reason_codes, state,
        attempt_count, max_attempts, created_at, updated_at, completed_at
      ) VALUES (
        'compaction-progress-running', ${knowledgeBaseId}, 'search', 'search/0001',
        'generation-progress', ARRAY['segment-a'], ARRAY['depth'], 'running',
        1, 5, '2026-07-20T00:00:01.000Z', '2026-07-20T00:00:03.000Z', NULL
      ), (
        'compaction-progress-completed', ${knowledgeBaseId}, 'tree', 'tree/0001',
        'generation-progress', ARRAY['segment-b'], ARRAY['bytes'], 'completed',
        1, 5, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:02.000Z',
        '2026-07-20T00:00:02.000Z'
      ), (
        'compaction-progress-other', ${otherKnowledgeBaseId}, 'search', 'search/0001',
        'generation-other', ARRAY['segment-c'], ARRAY['depth'], 'failed',
        5, 5, '2026-07-20T00:00:04.000Z', '2026-07-20T00:00:05.000Z', NULL
      )
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id IN (${knowledgeBaseId}, ${otherKnowledgeBaseId})
    `;
  }
});

function databaseConnectionUrl(source: string, database: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
