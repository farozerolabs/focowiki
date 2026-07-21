import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresIncrementalStatisticsRepository } from "../src/infrastructure/postgres/incremental-statistics-repository.js";
import { runIncrementalStatisticsReconciliationSlice } from "../src/maintenance/incremental-statistics-reconciliation.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("incremental statistics repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const repository = createPostgresIncrementalStatisticsRepository(sql);
  const knowledgeBaseId = "kb-statistics-reconciliation";

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Statistics reconciliation')
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_incremental_stats (
        knowledge_base_id, source_file_count, source_directory_count,
        graph_node_count, graph_edge_count, active_projection_record_count,
        active_generated_object_count, stats_revision, reconciled_at,
        reconciliation_lease_owner, reconciliation_lease_token,
        reconciliation_lease_expires_at
      ) VALUES (
        ${knowledgeBaseId}, 99, 98, 97, 96, 95, 94, 1,
        '2026-07-19T00:00:00.000Z', 'stale-worker', 'stale-lease',
        '2026-07-19T00:01:00.000Z'
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql.end({ timeout: 5 });
  });

  it("reclaims a stale lease and reconciles exact counts in one bounded slice", async () => {
    const result = await runIncrementalStatisticsReconciliationSlice({
      repository,
      workerId: "maintenance-statistics",
      leaseToken: "lease-current",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:01:00.000Z",
      reconciledBefore: "2026-07-19T23:00:00.000Z"
    });
    expect(result).toEqual({ claimed: true, changed: true, failed: false });

    const rows = await sql<Array<{
      source_file_count: number;
      source_directory_count: number;
      graph_node_count: number;
      graph_edge_count: number;
      active_projection_record_count: number;
      active_generated_object_count: number;
      reconciliation_lease_owner: string | null;
      reconciled_at: Date | null;
    }>>`
      SELECT source_file_count::int, source_directory_count::int,
             graph_node_count::int, graph_edge_count::int,
             active_projection_record_count::int,
             active_generated_object_count::int,
             reconciliation_lease_owner, reconciled_at
      FROM focowiki.knowledge_base_incremental_stats
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(rows[0]).toMatchObject({
      source_file_count: 0,
      source_directory_count: 0,
      graph_node_count: 0,
      graph_edge_count: 0,
      active_projection_record_count: 0,
      active_generated_object_count: 0,
      reconciliation_lease_owner: null
    });
    expect(rows[0]?.reconciled_at?.toISOString()).toBe("2026-07-20T00:00:00.000Z");

    const shardRows = await sql<Array<{ total_count: number }>>`
      SELECT (
        coalesce(sum(source_file_count), 0)
        + coalesce(sum(source_directory_count), 0)
        + coalesce(sum(graph_node_count), 0)
        + coalesce(sum(graph_edge_count), 0)
        + coalesce(sum(active_projection_record_count), 0)
        + coalesce(sum(active_generated_object_count), 0)
      )::int AS total_count
      FROM focowiki.knowledge_base_incremental_stat_shards
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(shardRows[0]?.total_count).toBe(0);

    const noRepeat = await repository.claimForReconciliation({
      workerId: "maintenance-statistics",
      leaseToken: "lease-repeat",
      now: "2026-07-20T00:00:01.000Z",
      leaseExpiresAt: "2026-07-20T00:01:01.000Z",
      reconciledBefore: "2026-07-19T23:00:00.000Z"
    });
    expect(noRepeat).toBeNull();
  });
});
