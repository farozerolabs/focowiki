import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";
import { createPostgresActiveGenerationReadRepository } from "../src/infrastructure/postgres/active-generation-read-repository.js";
import { createPostgresKnowledgeBaseIndexMaintenanceRepository } from "../src/infrastructure/postgres/knowledge-base-index-maintenance-repository.js";
import { REQUIRED_PROJECTION_REPAIR_VERSIONS } from "../src/maintenance/projection-repair-plan.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("knowledge-base index maintenance compatible migration", () => {
  const connectionUrl =
    databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_index_maintenance_migration_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  const activeReads = createPostgresActiveGenerationReadRepository(sql);
  const maintenance = createPostgresKnowledgeBaseIndexMaintenanceRepository(sql);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrationIndex = MIGRATION_FILES.indexOf(
      "016_knowledge_base_index_maintenance.sql"
    );
    for (const fileName of MIGRATION_FILES.slice(0, migrationIndex)) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(fileName));
      });
    }
    await sql`
      UPDATE focowiki.runtime_settings
      SET value_json = (value_json - 'knowledgeBaseMaintenanceMode'
        - 'knowledgeBaseMaintenanceScanIntervalSeconds'
        - 'knowledgeBaseMaintenanceConcurrency')
        || jsonb_build_object(
          'reconciliationEnabled', false,
          'scanIntervalSeconds', 12345
        )
      WHERE key = 'maintenance'
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-compatible', 'Compatible knowledge base')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, activated_at
      ) VALUES (
        'generation-compatible', 'kb-compatible', NULL, 'active',
        2, 'normal', now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-compatible'
      WHERE id = 'kb-compatible'
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id,
        state, completed_at
      ) VALUES (
        'kb-compatible', 99, 'generation-compatible',
        'completed', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id,
        state, checkpoint_json, attempt_count, next_attempt_at
      ) VALUES (
        'kb-compatible', 98, 'generation-compatible', 'retry',
        '{"treeCursor":"source-file-compatible"}'::jsonb, 2, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
        knowledge_base_id, target_search_schema_version,
        target_tokenizer_contract_version, target_segmentation_version,
        target_content_profile_version,
        target_graph_lexical_projection_version,
        base_generation_id, state, attempt_count, max_attempts,
        next_attempt_at
      ) VALUES (
        'kb-compatible', 'search-compatible', 'tokenizer-compatible',
        'segmentation-compatible', 'profile-compatible',
        'graph-compatible', 'generation-compatible', 'failed', 2, 5, now()
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("adds manual defaults without replacing saved settings or active data", async () => {
    await expect(applyMigrations(sql)).resolves.toBeUndefined();
    await expect(applyMigrations(sql)).resolves.toBeUndefined();

    const [generation] = await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `;
    const [knowledgeBase] = await sql<Array<{ active_generation_id: string | null }>>`
      SELECT active_generation_id
      FROM focowiki.knowledge_bases
      WHERE id = 'kb-compatible'
    `;
    const [settings] = await sql<Array<{ value_json: Record<string, unknown> }>>`
      SELECT value_json
      FROM focowiki.runtime_settings
      WHERE key = 'maintenance'
    `;
    const [history] = await sql<Array<{
      count: number;
      maintenance_request_id: string | null;
      maintenance_request_attempt: number;
    }>>`
      SELECT
        count(*)::int AS count,
        max(maintenance_request_id) AS maintenance_request_id,
        max(maintenance_request_attempt)::int AS maintenance_request_attempt
      FROM focowiki.knowledge_base_projection_repairs
      WHERE knowledge_base_id = 'kb-compatible'
        AND repair_version = 99
        AND state = 'completed'
    `;
    const [repair] = await sql<Array<{
      state: string;
      checkpoint_json: Record<string, unknown>;
      attempt_count: number;
    }>>`
      SELECT state, checkpoint_json, attempt_count
      FROM focowiki.knowledge_base_projection_repairs
      WHERE knowledge_base_id = 'kb-compatible'
        AND repair_version = 98
    `;
    const [lexical] = await sql<Array<{
      state: string;
      attempt_count: number;
      max_attempts: number;
    }>>`
      SELECT state, attempt_count, max_attempts
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = 'kb-compatible'
    `;

    expect(generation?.generation).toBe(RUNTIME_SCHEMA_GENERATION);
    expect(knowledgeBase?.active_generation_id).toBe("generation-compatible");
    expect(settings?.value_json).toMatchObject({
      reconciliationEnabled: false,
      scanIntervalSeconds: 12345,
      knowledgeBaseMaintenanceMode: "manual",
      knowledgeBaseMaintenanceScanIntervalSeconds: 21600,
      knowledgeBaseMaintenanceConcurrency: 1
    });
    expect(history?.count).toBe(1);
    expect(history?.maintenance_request_id).toBeNull();
    expect(history?.maintenance_request_attempt).toBe(0);
    expect(repair).toEqual({
      state: "retry",
      checkpoint_json: { treeCursor: "source-file-compatible" },
      attempt_count: 2
    });
    expect(lexical).toEqual({
      state: "failed",
      attempt_count: 2,
      max_attempts: 5
    });
  });

  it("keeps durable maintenance state unchanged when migration is already current", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
        id, knowledge_base_id, trigger_kind, state, idempotency_key,
        actor, base_generation_id, source_watermark, settings_revision,
        settings_snapshot_json, planned_scopes, completed_scopes,
        current_stage, completed_count, expected_count, retry_count,
        max_attempts, lease_owner, lease_token, lease_expires_at,
        heartbeat_at, next_attempt_at, last_progress_at, started_at
      ) VALUES (
        'maintenance-request-compatible', 'kb-compatible', 'manual',
        'running', 'compatible-request', 'admin', 'generation-compatible',
        42, 7, '{"mode":"manual"}'::jsonb, ARRAY['tree', 'search'],
        ARRAY['tree'], 'search', 3, 9, 2, 5, 'worker-compatible',
        'lease-compatible', now() + interval '10 minutes', now(), now(),
        now(), now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_base_projection_repairs
      SET state = 'running',
          checkpoint_json = '{"treeCursor":"source-file-42"}'::jsonb,
          lease_token = 'repair-lease-compatible',
          lease_expires_at = now() + interval '10 minutes',
          attempt_count = 2,
          next_attempt_at = now(),
          maintenance_request_id = 'maintenance-request-compatible',
          maintenance_request_attempt = 2
      WHERE knowledge_base_id = 'kb-compatible'
        AND repair_version = 98
    `;
    const before = await durableMaintenanceState();
    const generatedObjectsBefore = await generatedObjectCounts();

    await expect(applyMigrations(sql)).resolves.toBeUndefined();
    await expect(applyMigrations(sql)).resolves.toBeUndefined();

    expect(await durableMaintenanceState()).toEqual(before);
    expect(await generatedObjectCounts()).toEqual(generatedObjectsBefore);
  });

  it("keeps an unaffected knowledge base healthy across repeated migration", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-healthy', 'Healthy knowledge base')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, search_schema_version,
        tokenizer_contract_version, search_segmentation_version, activated_at
      ) VALUES (
        'generation-healthy', 'kb-healthy', NULL, 'active',
        2, 'normal', 'search-current', 'tokenizer-current',
        'segmentation-current', now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-healthy'
      WHERE id = 'kb-healthy'
    `;
    for (const [kind, version] of Object.entries(
      REQUIRED_PROJECTION_REPAIR_VERSIONS
    )) {
      await sql`
        INSERT INTO focowiki.knowledge_base_projection_versions (
          knowledge_base_id, projection_kind, format_version,
          input_version, active_generation_id
        ) VALUES (
          'kb-healthy', ${kind}, ${version}, ${version}, 'generation-healthy'
        )
      `;
    }

    await expect(applyMigrations(sql)).resolves.toBeUndefined();

    await expect(maintenance.getSummary({
      knowledgeBaseId: "kb-healthy"
    })).resolves.toMatchObject({
      state: "idle",
      maintenanceRequired: false
    });
    await expect(readActiveGeneration("kb-healthy")).resolves.toBe(
      "generation-healthy"
    );
  });

  it("keeps the active generation readable throughout maintenance lifecycle states", async () => {
    await sql`
      DELETE FROM focowiki.knowledge_base_index_maintenance_requests
      WHERE knowledge_base_id = 'kb-compatible'
    `;
    await expect(maintenance.getSummary({
      knowledgeBaseId: "kb-compatible"
    })).resolves.toMatchObject({
      maintenanceRequired: true
    });
    await expect(readActiveGeneration("kb-compatible")).resolves.toBe(
      "generation-compatible"
    );

    for (const fixture of [
      { state: "queued", retryCount: 0 },
      { state: "running", retryCount: 0 },
      { state: "failed", retryCount: 5 },
      { state: "queued", retryCount: 2 },
      { state: "superseded", retryCount: 0 },
      { state: "completed", retryCount: 0 }
    ] as const) {
      await sql`
        DELETE FROM focowiki.knowledge_base_index_maintenance_requests
        WHERE knowledge_base_id = 'kb-compatible'
      `;
      await sql`
        INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
          id, knowledge_base_id, trigger_kind, state, settings_revision,
          retry_count, max_attempts, next_attempt_at
        ) VALUES (
          ${`maintenance-state-${fixture.state}-${fixture.retryCount}`},
          'kb-compatible', 'manual', ${fixture.state}, 1,
          ${fixture.retryCount}, 5, now()
        )
      `;

      await expect(applyMigrations(sql)).resolves.toBeUndefined();
      await expect(readActiveGeneration("kb-compatible")).resolves.toBe(
        "generation-compatible"
      );
    }
  });

  async function readActiveGeneration(knowledgeBaseId: string) {
    return activeReads.withActiveGeneration(
      knowledgeBaseId,
      async (scope) => scope.generationId
    );
  }

  async function durableMaintenanceState() {
    return sql<Array<Record<string, unknown>>>`
      SELECT
        request.id,
        request.state,
        request.idempotency_key,
        request.base_generation_id,
        request.source_watermark,
        request.settings_revision,
        request.settings_snapshot_json,
        request.planned_scopes,
        request.completed_scopes,
        request.current_stage,
        request.completed_count,
        request.expected_count,
        request.retry_count,
        request.max_attempts,
        request.lease_owner,
        request.lease_token,
        request.lease_expires_at,
        request.heartbeat_at,
        request.next_attempt_at,
        request.last_progress_at,
        repair.repair_version,
        repair.state AS repair_state,
        repair.checkpoint_json,
        repair.lease_token AS repair_lease_token,
        repair.lease_expires_at AS repair_lease_expires_at,
        repair.attempt_count,
        repair.next_attempt_at AS repair_next_attempt_at,
        repair.maintenance_request_id,
        repair.maintenance_request_attempt
      FROM focowiki.knowledge_base_index_maintenance_requests request
      JOIN focowiki.knowledge_base_projection_repairs repair
        ON repair.maintenance_request_id = request.id
      WHERE request.id = 'maintenance-request-compatible'
    `;
  }

  async function generatedObjectCounts() {
    return sql<Array<Record<string, unknown>>>`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.immutable_objects) AS immutable_objects,
        (SELECT count(*)::int
         FROM focowiki.generation_object_refs) AS object_references,
        (SELECT count(*)::int
         FROM focowiki.projection_repair_subtasks) AS repair_subtasks,
        (SELECT count(*)::int
         FROM focowiki.lexical_rebuild_work_items) AS lexical_work_items
    `;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
