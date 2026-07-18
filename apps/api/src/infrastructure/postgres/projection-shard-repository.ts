import type {
  ProjectionShardRepository
} from "../../application/ports/projection-shard-repository.js";
import type { DatabaseClient } from "../../db/client.js";

export function createPostgresProjectionShardRepository(
  sql: DatabaseClient
): ProjectionShardRepository {
  return {
    async register(input) {
      const rows = await sql<Array<{
        id: string;
        knowledge_base_id: string;
        projection_kind: string;
        shard_key: string;
        format_version: number;
        checksum_sha256: string;
        object_key: string;
        record_count: number;
        first_sort_key: string | null;
        last_sort_key: string | null;
      }>>`
        INSERT INTO focowiki.projection_shards (
          id, knowledge_base_id, projection_kind, shard_key, format_version,
          checksum_sha256, object_key, record_count, first_sort_key, last_sort_key
        ) VALUES (
          ${input.id}, ${input.knowledgeBaseId}, ${input.projectionKind},
          ${input.shardKey}, ${input.formatVersion}, ${input.checksumSha256},
          ${input.objectKey}, ${input.recordCount}, ${input.firstSortKey},
          ${input.lastSortKey}
        )
        ON CONFLICT (
          knowledge_base_id, projection_kind, shard_key, format_version, checksum_sha256
        ) DO UPDATE SET object_key = EXCLUDED.object_key
        RETURNING id, knowledge_base_id, projection_kind, shard_key, format_version,
                  checksum_sha256, object_key, record_count, first_sort_key, last_sort_key
      `;
      const row = rows[0]!;
      return {
        id: row.id,
        knowledgeBaseId: row.knowledge_base_id,
        projectionKind: row.projection_kind,
        shardKey: row.shard_key,
        formatVersion: row.format_version,
        checksumSha256: row.checksum_sha256,
        objectKey: row.object_key,
        recordCount: row.record_count,
        firstSortKey: row.first_sort_key,
        lastSortKey: row.last_sort_key
      };
    }
  };
}
