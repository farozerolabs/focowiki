import type {
  ProjectionSegment,
  ProjectionSegmentRepository
} from "../../application/ports/projection-segment-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { registerProjectionSegmentsByIdentity } from "./projection-segment-registration.js";

type SegmentRow = {
  id: string;
  knowledge_base_id: string;
  projection_kind: string;
  logical_partition: string;
  segment_kind: ProjectionSegment["segmentKind"];
  sequence_number: number;
  format_version: number;
  checksum_sha256: string;
  object_key: string;
  logical_path: string;
  entry_count: number;
  encoded_bytes: number;
  first_record_identity: string | null;
  last_record_identity: string | null;
  base_segment_id: string | null;
  lifecycle_state: ProjectionSegment["lifecycleState"];
};

export function createPostgresProjectionSegmentRepository(
  sql: DatabaseClient
): ProjectionSegmentRepository {
  return {
    async initializeLineage(input) {
      await sql`
        INSERT INTO focowiki.generation_projection_segments (
          generation_id, segment_id, ordinal
        )
        SELECT ${input.generationId}, active.segment_id, active.ordinal
        FROM focowiki.active_projection_segments active
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND active.projection_kind = ${input.projectionKind}
          AND active.logical_partition = ${input.logicalPartition}
        ON CONFLICT (generation_id, segment_id) DO NOTHING
      `;
    },

    async nextSequence(input) {
      const rows = await sql<Array<{ next_sequence: number }>>`
        SELECT coalesce(max(segment.sequence_number) + 1, 0)::int AS next_sequence
        FROM focowiki.generation_projection_segments lineage
        JOIN focowiki.projection_segments segment ON segment.id = lineage.segment_id
        WHERE lineage.generation_id = ${input.generationId}
          AND segment.knowledge_base_id = ${input.knowledgeBaseId}
          AND segment.projection_kind = ${input.projectionKind}
          AND segment.logical_partition = ${input.logicalPartition}
          AND lineage.effective = true
      `;
      return Number(rows[0]?.next_sequence ?? 0);
    },

    async registerAndAttach(input) {
      const rows = await sql.begin(async (transaction) => {
        const resolved = await registerProjectionSegmentsByIdentity(transaction, [input]);
        const segmentId = resolved[0]?.segment.id;
        if (!segmentId) throw new Error("Projection segment registration failed");
        const registered = await transaction<SegmentRow[]>`
          UPDATE focowiki.projection_segments
          SET lifecycle_state = CASE
                WHEN lifecycle_state = 'writing' THEN ${input.lifecycleState}
                ELSE lifecycle_state
              END
          WHERE id = ${segmentId}
          RETURNING id, knowledge_base_id, projection_kind, logical_partition,
                    segment_kind, sequence_number, format_version, checksum_sha256,
                    object_key, logical_path, entry_count, encoded_bytes,
                    first_record_identity, last_record_identity, base_segment_id,
                    lifecycle_state
        `;
        await transaction`
          INSERT INTO focowiki.generation_projection_segments (
            generation_id, segment_id, ordinal, effective
          ) VALUES (${input.generationId}, ${segmentId}, ${input.ordinal}, true)
          ON CONFLICT (generation_id, segment_id) DO UPDATE
          SET ordinal = EXCLUDED.ordinal, effective = true
        `;
        return registered;
      });
      if (!rows[0]) throw new Error("Projection segment registration failed");
      return mapSegment(rows[0]);
    },

    async listGenerationLineage(input) {
      const rows = await sql<SegmentRow[]>`
        SELECT segment.id, segment.knowledge_base_id, segment.projection_kind,
               segment.logical_partition, segment.segment_kind,
               segment.sequence_number, segment.format_version,
               segment.checksum_sha256, segment.object_key, segment.logical_path,
               segment.entry_count, segment.encoded_bytes,
               segment.first_record_identity, segment.last_record_identity,
               segment.base_segment_id, segment.lifecycle_state
        FROM focowiki.generation_projection_segments lineage
        JOIN focowiki.projection_segments segment ON segment.id = lineage.segment_id
        WHERE lineage.generation_id = ${input.generationId}
          AND segment.knowledge_base_id = ${input.knowledgeBaseId}
          AND segment.projection_kind = ${input.projectionKind}
          AND segment.logical_partition = ${input.logicalPartition}
          AND lineage.effective = true
          AND segment.lifecycle_state IN ('active', 'retained')
        ORDER BY segment.sequence_number, segment.created_at, segment.id
      `;
      return rows.map(mapSegment);
    },

    async setGenerationRecordCount(input) {
      await sql`
        INSERT INTO focowiki.generation_projection_partition_stats (
          generation_id, knowledge_base_id, projection_kind,
          logical_partition, record_count, updated_at
        ) VALUES (
          ${input.generationId}, ${input.knowledgeBaseId}, ${input.projectionKind},
          ${input.logicalPartition}, ${input.recordCount}, now()
        )
        ON CONFLICT (generation_id, projection_kind, logical_partition) DO UPDATE
        SET record_count = EXCLUDED.record_count,
            updated_at = EXCLUDED.updated_at
      `;
    },

    async countEffectiveRecords(input) {
      const rows = await sql<Array<{ count: number }>>`
        WITH staged AS MATERIALIZED (
          SELECT record_id, action
          FROM focowiki.generation_projection_records
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND projection_kind = ${input.projectionKind}
            AND shard_key = ${input.logicalPartition}
        ), effective AS (
          SELECT active.record_id
          FROM focowiki.active_projection_records active
          WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
            AND active.projection_kind = ${input.projectionKind}
            AND active.shard_key = ${input.logicalPartition}
            AND NOT EXISTS (
              SELECT 1 FROM staged WHERE staged.record_id = active.record_id
            )
          UNION ALL
          SELECT staged.record_id FROM staged WHERE staged.action = 'upsert'
        )
        SELECT count(*)::int AS count FROM effective
      `;
      return Number(rows[0]?.count ?? 0);
    }
  };
}

function mapSegment(row: SegmentRow): ProjectionSegment {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    projectionKind: row.projection_kind,
    logicalPartition: row.logical_partition,
    segmentKind: row.segment_kind,
    sequenceNumber: Number(row.sequence_number),
    formatVersion: Number(row.format_version),
    checksumSha256: row.checksum_sha256,
    objectKey: row.object_key,
    logicalPath: row.logical_path,
    entryCount: Number(row.entry_count),
    encodedBytes: Number(row.encoded_bytes),
    firstRecordIdentity: row.first_record_identity,
    lastRecordIdentity: row.last_record_identity,
    baseSegmentId: row.base_segment_id,
    lifecycleState: row.lifecycle_state
  };
}
