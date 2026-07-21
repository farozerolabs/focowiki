import type {
  EffectiveProjectionShard,
  ProjectionCatalogRepository
} from "../../application/ports/projection-catalog-repository.js";
import type { DatabaseClient } from "../../db/client.js";

export function createPostgresProjectionCatalogRepository(
  sql: DatabaseClient
): ProjectionCatalogRepository {
  return {
    async listEffectiveShards(input) {
      const rows = await sql<Array<{
        projection_kind: string;
        shard_key: string;
        logical_path: string;
        record_count: number;
      }>>`
        WITH generation_changes AS (
          SELECT ref_kind, ref_key, action, projection_shard_id, logical_path
          FROM focowiki.generation_object_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND ref_kind IN ('projection_shard', 'projection_manifest')
        ), effective_refs AS (
          SELECT active.ref_kind, active.ref_key,
                 active.projection_shard_id, active.logical_path
          FROM focowiki.active_object_refs active
          WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
            AND active.ref_kind IN ('projection_shard', 'projection_manifest')
            AND NOT EXISTS (
              SELECT 1
              FROM generation_changes change
              WHERE change.ref_kind = active.ref_kind
                AND change.ref_key = active.ref_key
            )

          UNION ALL

          SELECT change.ref_kind, change.ref_key,
                 change.projection_shard_id, change.logical_path
          FROM generation_changes change
          WHERE change.action = 'upsert'
        ), effective_stats AS (
          SELECT active.projection_kind, active.logical_partition,
                 active.record_count
          FROM focowiki.active_projection_partition_stats active
          WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.generation_projection_partition_stats staged
              WHERE staged.generation_id = ${input.generationId}
                AND staged.projection_kind = active.projection_kind
                AND staged.logical_partition = active.logical_partition
            )

          UNION ALL

          SELECT staged.projection_kind, staged.logical_partition,
                 staged.record_count
          FROM focowiki.generation_projection_partition_stats staged
          WHERE staged.knowledge_base_id = ${input.knowledgeBaseId}
            AND staged.generation_id = ${input.generationId}
        ), manifests AS (
          SELECT split_part(reference.ref_key, ':', 1) AS projection_kind,
                 substring(reference.ref_key from position(':' in reference.ref_key) + 1) AS shard_key,
                 reference.logical_path,
                 coalesce(statistics.record_count, 0)::int AS record_count
          FROM effective_refs reference
          LEFT JOIN effective_stats statistics
            ON statistics.projection_kind = split_part(reference.ref_key, ':', 1)
           AND statistics.logical_partition = substring(
             reference.ref_key from position(':' in reference.ref_key) + 1
           )
          WHERE reference.ref_kind = 'projection_manifest'
            AND reference.logical_path IS NOT NULL
        ), legacy_shards AS (
          SELECT shard.projection_kind, shard.shard_key,
                 reference.logical_path, shard.record_count
          FROM effective_refs reference
          JOIN focowiki.projection_shards shard
            ON shard.id = reference.projection_shard_id
          WHERE reference.ref_kind = 'projection_shard'
            AND shard.projection_kind <> 'related_files'
            AND reference.logical_path IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM manifests manifest
              WHERE manifest.projection_kind = shard.projection_kind
                AND (
                  manifest.shard_key = shard.shard_key
                  OR shard.shard_key LIKE manifest.shard_key || '/part-%'
                )
            )
        )
        SELECT projection_kind, shard_key, logical_path, record_count
        FROM manifests
        UNION ALL
        SELECT projection_kind, shard_key, logical_path, record_count
        FROM legacy_shards
        ORDER BY projection_kind, shard_key
      `;
      return rows.map(mapShard);
    }
  };
}

function mapShard(row: {
  projection_kind: string;
  shard_key: string;
  logical_path: string;
  record_count: number;
}): EffectiveProjectionShard {
  return {
    projectionKind: row.projection_kind,
    shardKey: row.shard_key,
    logicalPath: row.logical_path,
    recordCount: Number(row.record_count)
  };
}
