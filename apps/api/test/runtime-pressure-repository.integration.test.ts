import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRuntimePressureRepository,
  readRuntimePressureSnapshot
} from "../src/infrastructure/postgres/runtime-pressure-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;

describeDatabase("runtime pressure repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresRuntimePressureRepository(sql);
  const knowledgeBaseId = "kb-runtime-pressure-integration";
  const generationId = "generation-runtime-pressure-integration";

  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Runtime pressure integration')
    `;
    await forceReconciliation();
  });

  afterAll(async () => {
    await cleanup();
    await forceReconciliation();
    await sql.end({ timeout: 5 });
  });

  it("maintains active counters through statement-level inserts and transitions", async () => {
    await sql`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, status
      ) VALUES (
        'role-job-runtime-pressure', 'source', 'source_processing',
        ${knowledgeBaseId}, 'queued'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, kind, path, resource_revision, assembly_state
      ) VALUES (
        'change-fact-runtime-pressure', ${knowledgeBaseId}, 'source_created',
        'docs/runtime-pressure.md', 1, 'pending'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'open', 2)
    `;
    await sql`
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind,
        projection_key, record_identity, action, status
      ) VALUES (
        'impact-runtime-pressure', ${knowledgeBaseId}, ${generationId}, 'page',
        'docs/runtime-pressure.md', 'docs/runtime-pressure.md', 'upsert', 'pending'
      )
    `;

    await expectCountersToMatchFacts();
    const shards = await sql<Array<{ shard_count: number }>>`
      SELECT count(DISTINCT counter_shard)::int AS shard_count
      FROM focowiki.runtime_pressure_counter_shards
      WHERE counter_key IN ('source_queue_depth', 'dirty_file_count', 'pending_impact_count')
    `;
    expect(shards[0]?.shard_count).toBeGreaterThan(1);
    const active = await readRuntimePressureSnapshot(sql, new Date().toISOString());
    expect(active.snapshot.sourceQueueDepth).toBeGreaterThanOrEqual(1);
    expect(active.snapshot.dirtyFileCount).toBeGreaterThanOrEqual(1);
    expect(active.snapshot.pendingImpactCount).toBeGreaterThanOrEqual(1);

    await sql`
      UPDATE focowiki.role_jobs
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = 'role-job-runtime-pressure'
    `;
    await sql`
      UPDATE focowiki.publication_change_facts
      SET assembly_state = 'assembled', assembled_at = now()
      WHERE id = 'change-fact-runtime-pressure'
    `;
    await sql`
      UPDATE focowiki.publication_impacts
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = 'impact-runtime-pressure'
    `;

    await expectCountersToMatchFacts();
  });

  it("repairs drift once per reconciliation interval", async () => {
    await sql`
      UPDATE focowiki.runtime_pressure_counter_shards
      SET counter_value = counter_value + 1
      WHERE counter_key = 'source_queue_depth'
        AND counter_shard = 0
    `;
    await sql`UPDATE focowiki.runtime_pressure_counters SET reconciled_at = NULL`;
    const first = await repository.reconcileIfDue({
      now: new Date().toISOString(),
      intervalSeconds: 60
    });
    expect(first.reconciled).toBe(true);
    await expectCountersToMatchFacts();

    const second = await repository.reconcileIfDue({
      now: new Date().toISOString(),
      intervalSeconds: 60
    });
    expect(second.reconciled).toBe(false);
  });

  async function expectCountersToMatchFacts() {
    const rows = await sql<Array<{
      counter_key: string;
      counter_value: number | string;
      actual_value: number | string;
    }>>`
      WITH counters AS (
        SELECT counter_key, sum(counter_value)::bigint AS counter_value
        FROM focowiki.runtime_pressure_counter_shards
        GROUP BY counter_key
      )
      SELECT counter.counter_key, counter.counter_value,
             CASE counter.counter_key
               WHEN 'source_queue_depth' THEN (
                 SELECT count(*) FROM focowiki.role_jobs
                 WHERE role = 'source' AND status IN ('queued', 'running')
               )
               WHEN 'dirty_file_count' THEN (
                 SELECT count(*) FROM focowiki.publication_change_facts
                 WHERE assembly_state IN ('pending', 'claimed')
               )
               WHEN 'pending_impact_count' THEN (
                 SELECT count(*) FROM focowiki.publication_impacts
                 WHERE status IN ('pending', 'running')
               )
               WHEN 'pending_marker_count' THEN (
                 SELECT count(*) FROM focowiki.source_dispatch_markers
                 WHERE status = 'pending'
               )
             END AS actual_value
      FROM counters counter
      WHERE counter.counter_key IN (
        'source_queue_depth', 'dirty_file_count',
        'pending_impact_count', 'pending_marker_count'
      )
      ORDER BY counter.counter_key
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(Number(row.counter_value), row.counter_key).toBe(Number(row.actual_value));
    }
  }

  async function forceReconciliation() {
    await sql`UPDATE focowiki.runtime_pressure_counters SET reconciled_at = NULL`;
    await repository.reconcileIfDue({
      now: new Date().toISOString(),
      intervalSeconds: 60
    });
  }

  async function cleanup() {
    await sql`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_impacts WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_change_facts WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
