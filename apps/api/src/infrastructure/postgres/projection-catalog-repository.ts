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
            AND ref_kind = 'projection_shard'
        ), effective_refs AS (
          SELECT active.projection_shard_id, active.logical_path
          FROM focowiki.active_object_refs active
          WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
            AND active.ref_kind = 'projection_shard'
            AND NOT EXISTS (
              SELECT 1
              FROM generation_changes change
              WHERE change.ref_kind = active.ref_kind
                AND change.ref_key = active.ref_key
            )

          UNION ALL

          SELECT change.projection_shard_id, change.logical_path
          FROM generation_changes change
          WHERE change.action = 'upsert'
        )
        SELECT shard.projection_kind, shard.shard_key,
               effective.logical_path, shard.record_count
        FROM effective_refs effective
        JOIN focowiki.projection_shards shard
          ON shard.id = effective.projection_shard_id
        WHERE shard.projection_kind <> 'related_files'
          AND effective.logical_path IS NOT NULL
        ORDER BY shard.projection_kind, shard.shard_key
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
