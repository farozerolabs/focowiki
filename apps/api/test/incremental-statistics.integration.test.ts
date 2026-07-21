import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("incremental statistics integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const knowledgeBaseId = "kb-incremental-statistics";
  const generationId = "generation-incremental-statistics";
  const checksum = "d".repeat(64);

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Incremental statistics')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'active', 2)
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        verified_at
      ) VALUES (${checksum}, 2, 'generated/stats.json', 'application/json', 64, now())
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("maintains bounded statement-level counts through inserts, updates, and deletes", async () => {
    const shardRows = await sql<Array<{ shard_count: number }>>`
      SELECT count(DISTINCT focowiki.incremental_stat_shard('source-file-' || value))::int
               AS shard_count
      FROM generate_series(1, 32) value
    `;
    expect(shardRows[0]?.shard_count).toBeGreaterThan(1);

    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, name, relative_path, path_key, depth
      ) VALUES
        ('source-directory-stats-a', ${knowledgeBaseId}, 'a', 'a', 'a', 1),
        ('source-directory-stats-b', ${knowledgeBaseId}, 'b', 'b', 'b', 1)
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES
          ('source-file-stats-a', ${knowledgeBaseId}, 'a.md', 'a/a.md', 'a/a.md',
           'source-directory-stats-a', 'sources/a.md', 'text/markdown', 1, 'a',
           'source-revision-stats-a'),
          ('source-file-stats-b', ${knowledgeBaseId}, 'b.md', 'b/b.md', 'b/b.md',
           'source-directory-stats-b', 'sources/b.md', 'text/markdown', 1, 'b',
           'source-revision-stats-b')
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-stats-a', ${knowledgeBaseId}, 'source-file-stats-a', 1,
           'sources/a.md', 'text/markdown', 1, 'a'),
          ('source-revision-stats-b', ${knowledgeBaseId}, 'source-file-stats-b', 1,
           'sources/b.md', 'text/markdown', 1, 'b')
      `;
    });
    await sql`
      INSERT INTO focowiki.source_file_graph_nodes (
        knowledge_base_id, source_file_id, path, title
      ) VALUES
        (${knowledgeBaseId}, 'source-file-stats-a', 'pages/a.md', 'A'),
        (${knowledgeBaseId}, 'source-file-stats-b', 'pages/b.md', 'B')
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_edges (
        id, knowledge_base_id, from_source_file_id, to_source_file_id,
        relation_type, weight, reason, source, status
      ) VALUES
        ('source-edge-stats-accepted', ${knowledgeBaseId},
         'source-file-stats-a', 'source-file-stats-b', 'related', 0.8,
         'Accepted evidence', 'content', 'accepted'),
        ('source-edge-stats-rejected', ${knowledgeBaseId},
         'source-file-stats-b', 'source-file-stats-a', 'related', 0.1,
         'Rejected evidence', 'content', 'rejected')
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, payload_json
      ) VALUES
        (${knowledgeBaseId}, 'search', 'record-stats-a', ${generationId},
         'search/v2/0001', ${sql.json({ path: "pages/a.md" })}),
        (${knowledgeBaseId}, 'search', 'record-stats-b', ${generationId},
         'search/v2/0001', ${sql.json({ path: "pages/b.md" })})
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version
      ) VALUES (
        ${knowledgeBaseId}, 'file', 'index.md', 'bundle-file-stats',
        ${generationId}, ${checksum}, 2
      )
    `;

    expect(await counts()).toEqual({
      source_file_count: 2,
      source_directory_count: 2,
      graph_node_count: 2,
      graph_edge_count: 1,
      active_projection_record_count: 2,
      active_generated_object_count: 1
    });

    const revisionBeforeGraphSummary = await statsRevision();
    await sql`
      UPDATE focowiki.source_files
      SET graph_relationship_count = 1,
          graph_top_relationships_json = ${sql.json([{ fileId: "source-file-stats-b" }])}
      WHERE id = 'source-file-stats-a'
    `;
    expect(await statsRevision()).toBe(revisionBeforeGraphSummary);

    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = now()
      WHERE id = 'source-file-stats-a'
    `;
    await sql`
      UPDATE focowiki.source_directories
      SET deleted_at = now()
      WHERE id = 'source-directory-stats-a'
    `;
    await sql`
      UPDATE focowiki.source_file_graph_edges
      SET status = 'rejected'
      WHERE id = 'source-edge-stats-accepted'
    `;
    await sql`
      DELETE FROM focowiki.active_projection_records
      WHERE knowledge_base_id = ${knowledgeBaseId} AND record_id = 'record-stats-a'
    `;
    await sql`
      DELETE FROM focowiki.active_object_refs
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;

    expect(await counts()).toEqual({
      source_file_count: 1,
      source_directory_count: 1,
      graph_node_count: 2,
      graph_edge_count: 0,
      active_projection_record_count: 1,
      active_generated_object_count: 0
    });

    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_nodes WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;

    expect(await counts()).toEqual({
      source_file_count: 0,
      source_directory_count: 0,
      graph_node_count: 0,
      graph_edge_count: 0,
      active_projection_record_count: 1,
      active_generated_object_count: 0
    });
  });

  it("avoids shared-statistic deadlocks during concurrent graph-summary updates", async () => {
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-stats-concurrent', ${knowledgeBaseId},
        'concurrent', 'concurrent', 'concurrent', 1
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES
          ('source-file-stats-concurrent-a', ${knowledgeBaseId}, 'a.md',
           'concurrent/a.md', 'concurrent/a.md', 'source-directory-stats-concurrent',
           'sources/concurrent-a.md', 'text/markdown', 1, 'a',
           'source-revision-stats-concurrent-a'),
          ('source-file-stats-concurrent-b', ${knowledgeBaseId}, 'b.md',
           'concurrent/b.md', 'concurrent/b.md', 'source-directory-stats-concurrent',
           'sources/concurrent-b.md', 'text/markdown', 1, 'b',
           'source-revision-stats-concurrent-b')
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-stats-concurrent-a', ${knowledgeBaseId},
           'source-file-stats-concurrent-a', 1, 'sources/concurrent-a.md',
           'text/markdown', 1, 'a'),
          ('source-revision-stats-concurrent-b', ${knowledgeBaseId},
           'source-file-stats-concurrent-b', 1, 'sources/concurrent-b.md',
           'text/markdown', 1, 'b')
      `;
    });

    const firstTransaction = sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.source_files
        SET graph_relationship_count = 1
        WHERE id = 'source-file-stats-concurrent-a'
      `;
      await transaction`SELECT pg_sleep(0.2)`;
      await transaction`
        UPDATE focowiki.source_files
        SET graph_relationship_count = 2
        WHERE id = 'source-file-stats-concurrent-b'
      `;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondTransaction = sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.source_files
        SET graph_relationship_count = 1
        WHERE id = 'source-file-stats-concurrent-b'
      `;
    });

    await Promise.all([firstTransaction, secondTransaction]);

    expect((await counts())?.source_file_count).toBe(2);
  });

  it("commits graph-node counters independently across stable statistic shards", async () => {
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-stats-sharded', ${knowledgeBaseId},
        'sharded', 'sharded', 'sharded', 1
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES
          ('source-file-stats-concurrent-a', ${knowledgeBaseId}, 'a.md',
           'sharded/a.md', 'sharded/a.md', 'source-directory-stats-sharded',
           'sources/sharded-a.md', 'text/markdown', 1, 'a',
           'source-revision-stats-sharded-a'),
          ('source-file-stats-concurrent-b', ${knowledgeBaseId}, 'b.md',
           'sharded/b.md', 'sharded/b.md', 'source-directory-stats-sharded',
           'sources/sharded-b.md', 'text/markdown', 1, 'b',
           'source-revision-stats-sharded-b')
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-stats-sharded-a', ${knowledgeBaseId},
           'source-file-stats-concurrent-a', 1, 'sources/sharded-a.md',
           'text/markdown', 1, 'a'),
          ('source-revision-stats-sharded-b', ${knowledgeBaseId},
           'source-file-stats-concurrent-b', 1, 'sources/sharded-b.md',
           'text/markdown', 1, 'b')
      `;
    });

    const shards = await sql<Array<{ counter_shard: number }>>`
      SELECT focowiki.incremental_stat_shard(source_file_id)::int AS counter_shard
      FROM unnest(ARRAY[
        'source-file-stats-concurrent-a', 'source-file-stats-concurrent-b'
      ]) source_file_id
    `;
    expect(new Set(shards.map((row) => row.counter_shard)).size).toBe(2);

    const holdingTransaction = sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_file_graph_nodes (
          knowledge_base_id, source_file_id, path, title
        ) VALUES (
          ${knowledgeBaseId}, 'source-file-stats-concurrent-a',
          'pages/sharded-a.md', 'Sharded A'
        )
      `;
      await transaction`SELECT pg_sleep(0.3)`;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const startedAt = performance.now();
    await sql`
      INSERT INTO focowiki.source_file_graph_nodes (
        knowledge_base_id, source_file_id, path, title
      ) VALUES (
        ${knowledgeBaseId}, 'source-file-stats-concurrent-b',
        'pages/sharded-b.md', 'Sharded B'
      )
    `;
    const independentCommitMilliseconds = performance.now() - startedAt;
    await holdingTransaction;

    expect(independentCommitMilliseconds).toBeLessThan(200);
    expect((await counts())?.graph_node_count).toBe(2);
  });

  it("keeps independent source edge batches on independent statistic shards", async () => {
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-stats-edge-shards', ${knowledgeBaseId},
        'edge-shards', 'edge-shards', 'edge-shards', 1
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES
          ('source-file-stats-concurrent-a', ${knowledgeBaseId}, 'a.md',
           'edge-shards/a.md', 'edge-shards/a.md', 'source-directory-stats-edge-shards',
           'sources/edge-shards-a.md', 'text/markdown', 1, 'a',
           'source-revision-stats-edge-shards-a'),
          ('source-file-stats-concurrent-b', ${knowledgeBaseId}, 'b.md',
           'edge-shards/b.md', 'edge-shards/b.md', 'source-directory-stats-edge-shards',
           'sources/edge-shards-b.md', 'text/markdown', 1, 'b',
           'source-revision-stats-edge-shards-b')
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-stats-edge-shards-a', ${knowledgeBaseId},
           'source-file-stats-concurrent-a', 1, 'sources/edge-shards-a.md',
           'text/markdown', 1, 'a'),
          ('source-revision-stats-edge-shards-b', ${knowledgeBaseId},
           'source-file-stats-concurrent-b', 1, 'sources/edge-shards-b.md',
           'text/markdown', 1, 'b')
      `;
    });

    const sourceShards = await sql<Array<{ counter_shard: number }>>`
      SELECT focowiki.incremental_stat_shard(source_file_id)::int AS counter_shard
      FROM unnest(ARRAY[
        'source-file-stats-concurrent-a', 'source-file-stats-concurrent-b'
      ]) source_file_id
    `;
    expect(new Set(sourceShards.map((row) => row.counter_shard)).size).toBe(2);

    const collidingEdgeIds = await sql<Array<{ first_id: string; second_id: string }>>`
      SELECT 'source-edge-shard-a-' || first_value AS first_id,
             'source-edge-shard-b-' || second_value AS second_id
      FROM generate_series(1, 128) first_value
      CROSS JOIN generate_series(1, 128) second_value
      WHERE focowiki.incremental_stat_shard('source-edge-shard-a-' || first_value)
          = focowiki.incremental_stat_shard('source-edge-shard-b-' || second_value)
      LIMIT 1
    `;
    const edgeIds = collidingEdgeIds[0];
    expect(edgeIds).toBeDefined();

    const holdingTransaction = sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_file_graph_edges (
          id, knowledge_base_id, from_source_file_id, to_source_file_id,
          relation_type, weight, reason, source, status
        ) VALUES (
          ${edgeIds!.first_id}, ${knowledgeBaseId},
          'source-file-stats-concurrent-a', 'source-file-stats-concurrent-b',
          'related', 0.8, 'Independent source A', 'content', 'accepted'
        )
      `;
      await transaction`SELECT pg_sleep(0.3)`;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const startedAt = performance.now();
    await sql`
      INSERT INTO focowiki.source_file_graph_edges (
        id, knowledge_base_id, from_source_file_id, to_source_file_id,
        relation_type, weight, reason, source, status
      ) VALUES (
        ${edgeIds!.second_id}, ${knowledgeBaseId},
        'source-file-stats-concurrent-b', 'source-file-stats-concurrent-a',
        'related', 0.8, 'Independent source B', 'content', 'accepted'
      )
    `;
    const independentCommitMilliseconds = performance.now() - startedAt;
    await holdingTransaction;

    expect(independentCommitMilliseconds).toBeLessThan(200);
    expect((await counts())?.graph_edge_count).toBe(2);
  });

  async function counts() {
    const rows = await sql<Array<{
      source_file_count: number;
      source_directory_count: number;
      graph_node_count: number;
      graph_edge_count: number;
      active_projection_record_count: number;
      active_generated_object_count: number;
    }>>`
      SELECT coalesce(sum(source_file_count), 0)::int AS source_file_count,
             coalesce(sum(source_directory_count), 0)::int AS source_directory_count,
             coalesce(sum(graph_node_count), 0)::int AS graph_node_count,
             coalesce(sum(graph_edge_count), 0)::int AS graph_edge_count,
             coalesce(sum(active_projection_record_count), 0)::int
               AS active_projection_record_count,
             coalesce(sum(active_generated_object_count), 0)::int
               AS active_generated_object_count
      FROM focowiki.knowledge_base_incremental_stat_shards
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    return rows[0];
  }

  async function statsRevision() {
    const rows = await sql<Array<{ stats_revision: number }>>`
      SELECT coalesce(sum(stats_revision), 0)::int AS stats_revision
      FROM focowiki.knowledge_base_incremental_stat_shards
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    return Number(rows[0]?.stats_revision ?? 0);
  }

  async function cleanup() {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE (checksum_sha256 = ${checksum} AND format_version = 2)
         OR object_key = 'generated/stats.json'
    `;
  }
});
