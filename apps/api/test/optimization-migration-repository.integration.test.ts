import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresFileGraphRepository } from "../src/db/file-graph-repository.js";
import { createPostgresOptimizationMigrationRepository } from "../src/infrastructure/postgres/optimization-migration-repository.js";
import { runOptimizationMigrationSlice } from "../src/maintenance/optimization-migration.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("optimization migration repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 6 });
  const repository = createPostgresOptimizationMigrationRepository(sql);
  const graph = createPostgresFileGraphRepository(sql);
  const knowledgeBaseId = "kb-optimization-migration";
  const generationId = "generation-optimization-migration";
  const previousGenerationId = "generation-optimization-migration-previous";
  const sourceFileId = "source-file-optimization-migration";
  const revisionId = "source-revision-optimization-migration";
  const checksum = createHash("sha256").update("legacy projection").digest("hex");
  const previousChecksum = createHash("sha256")
    .update("legacy projection previous")
    .digest("hex");

  beforeEach(async () => {
    await cleanup();
    await seedLegacyKnowledgeBase();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("resumes paged backfill and atomically marks one legacy knowledge base optimized", async () => {
    const initialGeneration = await activeGeneration();
    const phases: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await runOptimizationMigrationSlice({
        repository,
        graph,
        storage: {
          async getObjectText(key) {
            return key === "sources/legacy.md"
              ? "# Legacy source\n\nBody-derived migration evidence."
              : null;
          }
        },
        workerId: "maintenance-migration-worker",
        leaseToken: `lease-${index}`,
        now: `2026-07-20T00:00:0${index}.000Z`,
        leaseExpiresAt: `2026-07-20T00:01:0${index}.000Z`,
        batchSize: 1,
        sourceReadConcurrency: 1
      });
      expect(result.failed, `${result.phase}:${result.errorCode ?? "unknown"}`).toBe(false);
      phases.push(result.phase);
      if (result.completed) break;
    }

    expect(phases).toEqual([
      "source_terms",
      "source_terms",
      "projection_segments",
      "projection_segments",
      "projection_segments",
      "object_validation",
      "object_validation",
      "object_validation",
      "verifying"
    ]);
    const migration = await sql<Array<{
      state: string;
      completed_at: Date | null;
      high_water_source_file_id: string | null;
      high_water_projection_record_id: string | null;
      high_water_object_identity: string | null;
    }>>`
      SELECT state, completed_at, high_water_source_file_id,
             high_water_projection_record_id, high_water_object_identity
      FROM focowiki.knowledge_base_optimization_migrations
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(migration[0]).toMatchObject({
      state: "optimized_active",
      high_water_source_file_id: sourceFileId,
      high_water_projection_record_id: "projection-shard-legacy-previous"
    });
    expect(migration[0]?.high_water_object_identity).toContain("projection_shard");
    expect(migration[0]?.completed_at).toBeInstanceOf(Date);
    expect(await activeGeneration()).toBe(initialGeneration);

    const artifacts = await sql<Array<{
      terms: number;
      segments: number;
      active_segments: number;
      stats: number;
      stat_shards: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_file_graph_term_documents
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS terms,
        (SELECT count(*)::int FROM focowiki.projection_segments
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS segments,
        (SELECT count(*)::int FROM focowiki.active_projection_segments
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS active_segments,
        (SELECT count(*)::int FROM focowiki.knowledge_base_incremental_stats
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS stats,
        (SELECT count(*)::int FROM focowiki.knowledge_base_incremental_stat_shards
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS stat_shards
    `;
    expect(artifacts[0]).toMatchObject({
      terms: 1,
      segments: 2,
      active_segments: 2,
      stats: 1
    });
    expect(artifacts[0]?.stat_shards).toBeGreaterThan(0);
    expect(artifacts[0]?.stat_shards).toBeLessThanOrEqual(32);
    const partitionStats = await sql<Array<{ record_count: number }>>`
      SELECT record_count::int
      FROM focowiki.active_projection_partition_stats
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND projection_kind = 'search'
        AND logical_partition = 'search/v2/0001'
    `;
    expect(partitionStats[0]?.record_count).toBe(2);
  });

  it("reclaims an expired lease without losing the durable high-water mark", async () => {
    const first = await repository.claimNext({
      workerId: "migration-worker-a",
      leaseToken: "lease-a",
      now: "2026-07-20T00:00:00.000Z",
      leaseExpiresAt: "2026-07-20T00:00:10.000Z"
    });
    expect(first?.knowledgeBaseId).toBe(knowledgeBaseId);
    const blocked = await repository.claimNext({
      workerId: "migration-worker-b",
      leaseToken: "lease-b",
      now: "2026-07-20T00:00:05.000Z",
      leaseExpiresAt: "2026-07-20T00:00:15.000Z"
    });
    expect(blocked).toBeNull();
    const reclaimed = await repository.claimNext({
      workerId: "migration-worker-b",
      leaseToken: "lease-b",
      now: "2026-07-20T00:00:11.000Z",
      leaseExpiresAt: "2026-07-20T00:00:21.000Z"
    });
    expect(reclaimed).toMatchObject({
      knowledgeBaseId,
      leaseOwner: "migration-worker-b",
      leaseToken: "lease-b"
    });
  });

  async function seedLegacyKnowledgeBase(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Optimization migration')
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version, successor_generation_id
        ) VALUES (
          ${previousGenerationId}, ${knowledgeBaseId}, 'superseded', 2, ${generationId}
        ), (
          ${generationId}, ${knowledgeBaseId}, 'active', 2, NULL
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${generationId}
        WHERE id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'sources/legacy.md',
          'text/markdown; charset=utf-8', 48, ${"b".repeat(64)},
          'completed', 'generation_activation', 'visible', 'legacy.md',
          'legacy.md', 'legacy.md', ${revisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/legacy.md', 'text/markdown; charset=utf-8', 48,
          ${"b".repeat(64)}, 'completed'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_file_graph_nodes (
          knowledge_base_id, source_file_id, path, title,
          headings_json, keywords_json, profile_json
        ) VALUES (
          ${knowledgeBaseId}, ${sourceFileId}, 'pages/legacy.md', 'Legacy source',
          ${transaction.json(["Legacy source"])},
          ${transaction.json(["migration"])},
          ${transaction.json({ evidencePhrases: ["body-derived migration evidence"] })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.immutable_objects (
          checksum_sha256, format_version, object_key, content_type, size_bytes,
          verified_at
        ) VALUES (
          ${checksum}, 2, 'generated/legacy-search.json', 'application/json', 256, now()
        ), (
          ${previousChecksum}, 2, 'generated/legacy-search-previous.json',
          'application/json', 128, now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.projection_shards (
          id, knowledge_base_id, projection_kind, shard_key, format_version,
          checksum_sha256, object_key, record_count
        ) VALUES (
          'projection-shard-legacy', ${knowledgeBaseId}, 'search',
          'search/v2/0001', 2, ${checksum}, 'generated/legacy-search.json', 1
        ), (
          'projection-shard-legacy-previous', ${knowledgeBaseId}, 'search',
          'search/v2/0001', 2, ${previousChecksum},
          'generated/legacy-search-previous.json', 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.active_object_refs (
          knowledge_base_id, ref_kind, ref_key, file_id,
          last_changed_generation_id, checksum_sha256, format_version,
          logical_path, projection_shard_id
        ) VALUES (
          ${knowledgeBaseId}, 'projection_shard', 'search/v2/0001',
          'bundle-file-legacy-search', ${generationId}, ${checksum}, 2,
          '_index/search/search-v2-0001.json', 'projection-shard-legacy'
        ), (
          ${knowledgeBaseId}, 'projection_shard', 'search/v2/0001-previous',
          'bundle-file-legacy-search-previous', ${previousGenerationId},
          ${previousChecksum}, 2,
          '_index/search/search-v2-0001-previous.json',
          'projection-shard-legacy-previous'
        )
      `;
      await transaction`
        INSERT INTO focowiki.active_projection_records (
          knowledge_base_id, projection_kind, record_id,
          last_changed_generation_id, shard_key, source_file_id,
          logical_path, sort_key, title, searchable_text, payload_json
        ) VALUES (
          ${knowledgeBaseId}, 'search', ${sourceFileId}, ${generationId},
          'search/v2/0001', ${sourceFileId}, 'pages/legacy.md',
          'pages/legacy.md', 'Legacy source', 'legacy source migration',
          ${transaction.json({ fileId: sourceFileId, path: "pages/legacy.md" })}
        ), (
          ${knowledgeBaseId}, 'search', 'legacy-secondary-record',
          ${previousGenerationId}, 'search/v2/0001', NULL,
          'pages/legacy-secondary.md', 'pages/legacy-secondary.md',
          'Legacy secondary', 'legacy secondary migration',
          ${transaction.json({ path: "pages/legacy-secondary.md" })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_optimization_migrations (
          knowledge_base_id, state, phase, prior_active_generation_id, updated_at
        ) VALUES (
          ${knowledgeBaseId}, 'legacy_readable', 'source_terms', ${generationId},
          '2000-01-01T00:00:00.000Z'
        )
      `;
    });
  }

  async function activeGeneration(): Promise<string | null> {
    const rows = await sql<Array<{ active_generation_id: string | null }>>`
      SELECT active_generation_id FROM focowiki.knowledge_bases
      WHERE id = ${knowledgeBaseId}
    `;
    return rows[0]?.active_generation_id ?? null;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE (checksum_sha256 IN (${checksum}, ${previousChecksum}) AND format_version = 2)
         OR object_key IN (
           'generated/legacy-search.json',
           'generated/legacy-search-previous.json'
         )
    `;
  }
});
