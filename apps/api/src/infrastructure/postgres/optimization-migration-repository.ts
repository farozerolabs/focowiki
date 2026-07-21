import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type {
  LegacyProjectionSegment,
  OptimizationMigrationClaim,
  OptimizationMigrationRepository,
  OptimizationMigrationSource,
  ReferencedMigrationObject
} from "../../application/ports/optimization-migration-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { registerProjectionSegmentsByIdentity } from "./projection-segment-registration.js";

type MigrationRow = {
  knowledge_base_id: string;
  state: OptimizationMigrationClaim["state"];
  phase: OptimizationMigrationClaim["phase"];
  high_water_source_file_id: string | null;
  high_water_projection_record_id: string | null;
  high_water_object_identity: string | null;
  prior_active_generation_id: string | null;
  lease_owner: string;
  lease_token: string;
};

type SourceRow = {
  source_file_id: string;
  source_revision_id: string;
  object_key: string;
  title: string;
  headings_json: unknown;
  profile_json: unknown;
  entities_json: unknown;
  explicit_references_json: unknown;
  subjects_json: unknown;
  tags_json: unknown;
  keywords_json: unknown;
  relationship_hints_json: unknown;
};

type LegacyProjectionRow = {
  shard_id: string;
  knowledge_base_id: string;
  generation_id: string;
  projection_kind: string;
  logical_partition: string;
  format_version: number;
  checksum_sha256: string;
  object_key: string;
  logical_path: string;
  entry_count: number;
  encoded_bytes: number;
};

type ReferencedObjectRow = {
  identity: string;
  checksum_sha256: string;
  format_version: number;
  object_key: string;
  object_present: boolean;
};

type ParityRow = {
  source_file_count: number;
  graph_term_count: number;
  missing_graph_term_count: number;
  active_projection_record_count: number;
  partition_record_count: number;
  partition_mismatch_count: number;
  active_legacy_shard_count: number;
  active_base_segment_count: number;
  missing_base_segment_count: number;
  segment_mismatch_count: number;
  active_object_ref_count: number;
  missing_object_count: number;
  graph_node_count: number;
  graph_edge_count: number;
  root_ref_count: number;
};

export function createPostgresOptimizationMigrationRepository(
  sql: DatabaseClient
): OptimizationMigrationRepository {
  return {
    async claimNext(input) {
      const rows = await sql<MigrationRow[]>`
        WITH candidate AS MATERIALIZED (
          SELECT migration.knowledge_base_id
          FROM focowiki.knowledge_base_optimization_migrations migration
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = migration.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE migration.state IN ('legacy_readable', 'backfilling', 'verifying', 'failed')
            AND migration.attempt_count < migration.max_attempts
            AND (migration.lease_expires_at IS NULL OR migration.lease_expires_at <= ${input.now})
          ORDER BY
            CASE migration.state
              WHEN 'backfilling' THEN 0
              WHEN 'verifying' THEN 1
              WHEN 'failed' THEN 2
              ELSE 3
            END,
            migration.updated_at,
            migration.knowledge_base_id
          LIMIT 1
          FOR UPDATE OF migration SKIP LOCKED
        )
        UPDATE focowiki.knowledge_base_optimization_migrations migration
        SET state = CASE
              WHEN migration.phase = 'verifying' THEN 'verifying'
              ELSE 'backfilling'
            END,
            lease_owner = ${input.workerId},
            lease_token = ${input.leaseToken},
            lease_expires_at = ${input.leaseExpiresAt},
            started_at = coalesce(migration.started_at, ${input.now}),
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ${input.now}
        FROM candidate
        WHERE migration.knowledge_base_id = candidate.knowledge_base_id
        RETURNING migration.knowledge_base_id, migration.state, migration.phase,
                  migration.high_water_source_file_id,
                  migration.high_water_projection_record_id,
                  migration.high_water_object_identity,
                  migration.prior_active_generation_id,
                  migration.lease_owner, migration.lease_token
      `;
      return rows[0] ? mapClaim(rows[0]) : null;
    },

    async listSourceBatch(input) {
      const rows = await sql<SourceRow[]>`
        WITH source_page AS MATERIALIZED (
          SELECT source.id, source.knowledge_base_id,
                 source.active_revision_id, source.name
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
            AND (${input.afterSourceFileId}::text IS NULL
                 OR source.id > ${input.afterSourceFileId})
          ORDER BY source.id
          LIMIT ${boundedLimit(input.limit)}
        )
        SELECT source.id AS source_file_id,
               revision.id AS source_revision_id,
               revision.object_key,
               coalesce(node.title, source.name) AS title,
               coalesce(node.headings_json, '[]'::jsonb) AS headings_json,
               coalesce(node.profile_json, '{}'::jsonb) AS profile_json,
               coalesce(node.entities_json, '[]'::jsonb) AS entities_json,
               coalesce(node.explicit_references_json, '[]'::jsonb) AS explicit_references_json,
               coalesce(node.subjects_json, '[]'::jsonb) AS subjects_json,
               coalesce(node.tags_json, '[]'::jsonb) AS tags_json,
               coalesce(node.keywords_json, '[]'::jsonb) AS keywords_json,
               coalesce(node.relationship_hints_json, '[]'::jsonb) AS relationship_hints_json
        FROM source_page source
        JOIN LATERAL (
          SELECT candidate.id, candidate.object_key
          FROM focowiki.source_revisions candidate
          WHERE candidate.id = source.active_revision_id
            AND candidate.knowledge_base_id = source.knowledge_base_id
            AND candidate.source_file_id = source.id
          LIMIT 1
        ) revision ON TRUE
        LEFT JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = source.knowledge_base_id
         AND node.source_file_id = source.id
        ORDER BY source.id
      `;
      return rows.map(mapSource);
    },

    async recordSourceProgress(input) {
      await updateProgress(sql, input, {
        column: "high_water_source_file_id",
        value: input.highWaterSourceFileId,
        updatedAt: input.updatedAt
      });
    },

    async listLegacyProjectionBatch(input) {
      if (!input.generationId) return [];
      const rows = await sql<LegacyProjectionRow[]>`
        SELECT shard.id AS shard_id,
               shard.knowledge_base_id,
               ${input.generationId}::text AS generation_id,
               shard.projection_kind,
               shard.shard_key AS logical_partition,
               shard.format_version,
               shard.checksum_sha256,
               shard.object_key,
               coalesce(reference.logical_path, '_index/segments/' || shard.id || '.json') AS logical_path,
               shard.record_count AS entry_count,
               object.size_bytes AS encoded_bytes
        FROM focowiki.active_object_refs reference
        JOIN focowiki.projection_shards shard
          ON shard.id = reference.projection_shard_id
         AND shard.knowledge_base_id = reference.knowledge_base_id
        JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = reference.checksum_sha256
         AND object.format_version = reference.format_version
        WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
          AND reference.ref_kind = 'projection_shard'
          AND (${input.afterProjectionRecordId}::text IS NULL OR shard.id > ${input.afterProjectionRecordId})
        ORDER BY shard.id
        LIMIT ${boundedLimit(input.limit)}
      `;
      return rows.map(mapLegacyProjection);
    },

    async registerLegacyBaseSegments(input) {
      if (input.items.length === 0) return;
      const items = input.items.map((item) => ({
        ...item,
        segmentId: legacySegmentId(item.shardId)
      }));
      const activeGenerationId = items[0]?.generationId;
      if (!activeGenerationId) throw new Error("Legacy segment batch has no generation");
      if (items.some((item) => item.generationId !== activeGenerationId)) {
        throw new Error("Legacy segment batch spans multiple generations");
      }
      await sql.begin(async (transaction) => {
        await assertOwnedMigration(transaction, input);
        const resolved = await registerProjectionSegmentsByIdentity(
          transaction,
          items.map((item) => ({
            id: item.segmentId,
            knowledgeBaseId: item.knowledgeBaseId,
            projectionKind: item.projectionKind,
            logicalPartition: item.logicalPartition,
            segmentKind: "base",
            sequenceNumber: 0,
            formatVersion: item.formatVersion,
            checksumSha256: item.checksumSha256,
            objectKey: item.objectKey,
            logicalPath: item.logicalPath,
            entryCount: item.entryCount,
            encodedBytes: item.encodedBytes,
            firstRecordIdentity: null,
            lastRecordIdentity: null,
            baseSegmentId: null,
            lifecycleState: "retained",
            createdAt: input.updatedAt
          }))
        );
        const resolvedItems = resolved.map((entry, index) => ({
          ...items[index]!,
          segmentId: entry.segment.id
        }));
        await transaction`
          UPDATE focowiki.projection_segments
          SET lifecycle_state = CASE
                WHEN lifecycle_state = 'writing' THEN 'retained'
                ELSE lifecycle_state
              END
          WHERE id = ANY(${resolvedItems.map((item) => item.segmentId)}::text[])
        `;
        await transaction`
          INSERT INTO focowiki.generation_projection_segments (
            generation_id, segment_id, ordinal, effective, created_at
          )
          SELECT item.generation_id, item.segment_id, 0, true, ${input.updatedAt}
          FROM unnest(
            ${resolvedItems.map((item) => item.generationId)}::text[],
            ${resolvedItems.map((item) => item.segmentId)}::text[]
          ) AS item(generation_id, segment_id)
          ON CONFLICT (generation_id, segment_id) DO UPDATE SET effective = true
        `;
        await transaction`
          INSERT INTO focowiki.active_projection_segments (
            knowledge_base_id, projection_kind, logical_partition,
            segment_id, ordinal, updated_at
          )
          SELECT item.knowledge_base_id, item.projection_kind,
                 item.logical_partition, item.segment_id, 0, ${input.updatedAt}
          FROM unnest(
            ${resolvedItems.map((item) => item.knowledgeBaseId)}::text[],
            ${resolvedItems.map((item) => item.projectionKind)}::text[],
            ${resolvedItems.map((item) => item.logicalPartition)}::text[],
            ${resolvedItems.map((item) => item.segmentId)}::text[]
          ) AS item(knowledge_base_id, projection_kind, logical_partition, segment_id)
          ON CONFLICT (knowledge_base_id, projection_kind, logical_partition, segment_id)
          DO UPDATE SET updated_at = EXCLUDED.updated_at
        `;
        await transaction`
          INSERT INTO focowiki.active_projection_partition_stats (
            knowledge_base_id, projection_kind, logical_partition,
            record_count, last_changed_generation_id, updated_at
          )
          SELECT affected.knowledge_base_id, affected.projection_kind,
                 affected.logical_partition,
                 coalesce(count(record.record_id), 0)::bigint,
                 ${activeGenerationId}, ${input.updatedAt}
          FROM unnest(
            ${items.map((item) => item.knowledgeBaseId)}::text[],
            ${items.map((item) => item.projectionKind)}::text[],
            ${items.map((item) => item.logicalPartition)}::text[]
          ) AS affected(
            knowledge_base_id, projection_kind, logical_partition
          )
          LEFT JOIN focowiki.active_projection_records record
            ON record.knowledge_base_id = affected.knowledge_base_id
           AND record.projection_kind = affected.projection_kind
           AND record.shard_key = affected.logical_partition
          GROUP BY affected.knowledge_base_id, affected.projection_kind,
                   affected.logical_partition
          ON CONFLICT (knowledge_base_id, projection_kind, logical_partition) DO UPDATE
          SET record_count = EXCLUDED.record_count,
              last_changed_generation_id = EXCLUDED.last_changed_generation_id,
              updated_at = EXCLUDED.updated_at
        `;
      });
    },

    async recordProjectionProgress(input) {
      await updateProgress(sql, input, {
        column: "high_water_projection_record_id",
        value: input.highWaterProjectionRecordId,
        updatedAt: input.updatedAt
      });
    },

    async listReferencedObjectBatch(input) {
      const rows = await sql<ReferencedObjectRow[]>`
        SELECT reference.ref_kind || chr(31) || reference.ref_key AS identity,
               reference.checksum_sha256,
               reference.format_version,
               coalesce(object.object_key, '') AS object_key,
               object.checksum_sha256 IS NOT NULL AS object_present
        FROM focowiki.active_object_refs reference
        LEFT JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = reference.checksum_sha256
         AND object.format_version = reference.format_version
        WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
          AND (${input.afterObjectIdentity}::text IS NULL
               OR reference.ref_kind || chr(31) || reference.ref_key > ${input.afterObjectIdentity})
        ORDER BY reference.ref_kind, reference.ref_key
        LIMIT ${boundedLimit(input.limit)}
      `;
      return rows.map(mapReferencedObject);
    },

    async recordObjectProgress(input) {
      await updateProgress(sql, input, {
        column: "high_water_object_identity",
        value: input.highWaterObjectIdentity,
        updatedAt: input.updatedAt
      });
    },

    async advancePhase(input) {
      await sql`
        UPDATE focowiki.knowledge_base_optimization_migrations
        SET phase = ${input.phase},
            state = ${input.phase === "verifying" ? "verifying" : "backfilling"},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            attempt_count = 0, updated_at = ${input.updatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
      `;
    },

    async rebaseIfActiveGenerationChanged(input) {
      return sql.begin(async (transaction) => {
        const context = await lockMigrationActivationContext(transaction, input);
        if (context.activeGenerationId === context.priorActiveGenerationId) return false;
        await rebaseMigration(transaction, {
          ...input,
          activeGenerationId: context.activeGenerationId
        });
        return true;
      });
    },

    async reconcileStats(input) {
      await sql.begin(async (transaction) => {
        await assertOwnedMigration(transaction, input);
        await transaction`
          WITH exact AS MATERIALIZED (
            SELECT
              (SELECT count(*) FROM focowiki.source_files source
               WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                 AND source.deleted_at IS NULL) AS source_file_count,
              (SELECT count(*) FROM focowiki.source_directories directory
               WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
                 AND directory.deleted_at IS NULL) AS source_directory_count,
              (SELECT count(*) FROM focowiki.source_file_graph_nodes node
               WHERE node.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_node_count,
              (SELECT count(*) FROM focowiki.source_file_graph_edges edge
               WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
                 AND edge.status = 'accepted') AS graph_edge_count,
              (SELECT count(*) FROM focowiki.active_projection_records projection
               WHERE projection.knowledge_base_id = ${input.knowledgeBaseId})
                AS active_projection_record_count,
              (SELECT count(*) FROM focowiki.active_object_refs reference
               WHERE reference.knowledge_base_id = ${input.knowledgeBaseId})
                AS active_generated_object_count
          ), sharded AS MATERIALIZED (
            SELECT coalesce(sum(source_file_count), 0)::bigint AS source_file_count,
                   coalesce(sum(source_directory_count), 0)::bigint AS source_directory_count,
                   coalesce(sum(graph_node_count), 0)::bigint AS graph_node_count,
                   coalesce(sum(graph_edge_count), 0)::bigint AS graph_edge_count,
                   coalesce(sum(active_projection_record_count), 0)::bigint
                     AS active_projection_record_count,
                   coalesce(sum(active_generated_object_count), 0)::bigint
                     AS active_generated_object_count
            FROM focowiki.knowledge_base_incremental_stat_shards
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
          ), corrected AS (
            INSERT INTO focowiki.knowledge_base_incremental_stat_shards (
              knowledge_base_id, counter_shard, source_file_count,
              source_directory_count, graph_node_count, graph_edge_count,
              active_projection_record_count, active_generated_object_count,
              stats_revision, updated_at
            )
            SELECT ${input.knowledgeBaseId}, 0,
                   exact.source_file_count - sharded.source_file_count,
                   exact.source_directory_count - sharded.source_directory_count,
                   exact.graph_node_count - sharded.graph_node_count,
                   exact.graph_edge_count - sharded.graph_edge_count,
                   exact.active_projection_record_count
                     - sharded.active_projection_record_count,
                   exact.active_generated_object_count
                     - sharded.active_generated_object_count,
                   1, ${input.updatedAt}
            FROM exact CROSS JOIN sharded
            ON CONFLICT (knowledge_base_id, counter_shard) DO UPDATE
            SET source_file_count =
                  focowiki.knowledge_base_incremental_stat_shards.source_file_count
                    + EXCLUDED.source_file_count,
                source_directory_count =
                  focowiki.knowledge_base_incremental_stat_shards.source_directory_count
                    + EXCLUDED.source_directory_count,
                graph_node_count =
                  focowiki.knowledge_base_incremental_stat_shards.graph_node_count
                    + EXCLUDED.graph_node_count,
                graph_edge_count =
                  focowiki.knowledge_base_incremental_stat_shards.graph_edge_count
                    + EXCLUDED.graph_edge_count,
                active_projection_record_count =
                  focowiki.knowledge_base_incremental_stat_shards.active_projection_record_count
                    + EXCLUDED.active_projection_record_count,
                active_generated_object_count =
                  focowiki.knowledge_base_incremental_stat_shards.active_generated_object_count
                    + EXCLUDED.active_generated_object_count,
                stats_revision =
                  focowiki.knowledge_base_incremental_stat_shards.stats_revision + 1,
                updated_at = EXCLUDED.updated_at
            RETURNING knowledge_base_id
          )
          INSERT INTO focowiki.knowledge_base_incremental_stats (
            knowledge_base_id, source_file_count, source_directory_count,
            graph_node_count, graph_edge_count, active_projection_record_count,
            active_generated_object_count, stats_revision, reconciled_at, updated_at
          )
          SELECT ${input.knowledgeBaseId}, exact.source_file_count,
                 exact.source_directory_count, exact.graph_node_count,
                 exact.graph_edge_count, exact.active_projection_record_count,
                 exact.active_generated_object_count,
                 1, ${input.updatedAt}, ${input.updatedAt}
          FROM exact CROSS JOIN corrected
          ON CONFLICT (knowledge_base_id) DO UPDATE
          SET source_file_count = EXCLUDED.source_file_count,
              source_directory_count = EXCLUDED.source_directory_count,
              graph_node_count = EXCLUDED.graph_node_count,
              graph_edge_count = EXCLUDED.graph_edge_count,
              active_projection_record_count = EXCLUDED.active_projection_record_count,
              active_generated_object_count = EXCLUDED.active_generated_object_count,
              stats_revision = focowiki.knowledge_base_incremental_stats.stats_revision + 1,
              reconciled_at = EXCLUDED.reconciled_at,
              updated_at = EXCLUDED.updated_at
        `;
      });
    },

    async verifyParity(input) {
      await assertOwnedMigration(sql, input);
      const rows = await sql<ParityRow[]>`
        WITH active_partitions AS (
          SELECT projection_kind, shard_key AS logical_partition, count(*)::bigint AS record_count
          FROM focowiki.active_projection_records
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
          GROUP BY projection_kind, shard_key
        ), segment_stats AS (
          SELECT projection_kind, logical_partition, record_count
          FROM focowiki.active_projection_partition_stats
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        )
        SELECT
          (SELECT count(*)::int FROM focowiki.source_files source
           WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
             AND source.deleted_at IS NULL) AS source_file_count,
          (SELECT count(*)::int FROM focowiki.source_file_graph_term_documents term
           WHERE term.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_term_count,
          (SELECT count(*)::int FROM focowiki.source_files source
           WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
             AND source.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM focowiki.source_file_graph_term_documents term
               WHERE term.knowledge_base_id = source.knowledge_base_id
                 AND term.source_file_id = source.id
                 AND term.source_revision_id = source.active_revision_id
             )) AS missing_graph_term_count,
          (SELECT count(*)::int FROM focowiki.active_projection_records projection
           WHERE projection.knowledge_base_id = ${input.knowledgeBaseId}) AS active_projection_record_count,
          coalesce((SELECT sum(record_count)::int FROM segment_stats), 0) AS partition_record_count,
          (SELECT count(*)::int
           FROM active_partitions active
           FULL JOIN segment_stats segment
             ON segment.projection_kind = active.projection_kind
            AND segment.logical_partition = active.logical_partition
           WHERE coalesce(active.record_count, -1) <> coalesce(segment.record_count, -1)) AS partition_mismatch_count,
          (SELECT count(*)::int FROM focowiki.active_object_refs reference
           WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
             AND reference.ref_kind = 'projection_shard') AS active_legacy_shard_count,
          (SELECT count(*)::int FROM focowiki.active_projection_segments segment
           WHERE segment.knowledge_base_id = ${input.knowledgeBaseId}) AS active_base_segment_count,
          (SELECT count(*)::int FROM focowiki.active_object_refs reference
           WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
             AND reference.ref_kind = 'projection_shard'
             AND NOT EXISTS (
               SELECT 1
               FROM focowiki.projection_segments segment
               JOIN focowiki.active_projection_segments active
                 ON active.segment_id = segment.id
                AND active.knowledge_base_id = segment.knowledge_base_id
               WHERE segment.id = 'segment-legacy-' || md5(reference.projection_shard_id)
             )) AS missing_base_segment_count,
          (SELECT count(*)::int
           FROM focowiki.active_object_refs reference
           JOIN focowiki.projection_shards shard ON shard.id = reference.projection_shard_id
           JOIN focowiki.projection_segments segment
             ON segment.id = 'segment-legacy-' || md5(shard.id)
           WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
             AND (segment.checksum_sha256 <> shard.checksum_sha256
                  OR segment.object_key <> shard.object_key
                  OR segment.entry_count <> shard.record_count)) AS segment_mismatch_count,
          (SELECT count(*)::int FROM focowiki.active_object_refs reference
           WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}) AS active_object_ref_count,
          (SELECT count(*)::int FROM focowiki.active_object_refs reference
           WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
             AND NOT EXISTS (
               SELECT 1 FROM focowiki.immutable_objects object
               WHERE object.checksum_sha256 = reference.checksum_sha256
                 AND object.format_version = reference.format_version
             )) AS missing_object_count,
          (SELECT count(*)::int FROM focowiki.source_file_graph_nodes node
           WHERE node.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_node_count,
          (SELECT count(*)::int FROM focowiki.source_file_graph_edges edge
           WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
             AND edge.status = 'accepted') AS graph_edge_count,
          (SELECT count(*)::int FROM focowiki.active_object_refs reference
           WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
             AND reference.ref_kind = 'root') AS root_ref_count
      `;
      const row = rows[0];
      if (!row) return { passed: false, evidence: { reason: "missing_parity_row" } };
      const evidence = mapParityEvidence(row);
      return {
        passed: row.missing_graph_term_count === 0
          && row.partition_mismatch_count === 0
          && row.missing_base_segment_count === 0
          && row.segment_mismatch_count === 0
          && row.missing_object_count === 0,
        evidence
      };
    },

    async activate(input) {
      return sql.begin(async (transaction) => {
        const context = await lockMigrationActivationContext(transaction, input);
        if (context.activeGenerationId !== context.priorActiveGenerationId) {
          await rebaseMigration(transaction, {
            ...input,
            updatedAt: input.activatedAt,
            activeGenerationId: context.activeGenerationId
          });
          return "rebased" as const;
        }
        await transaction`
          UPDATE focowiki.knowledge_base_optimization_migrations
          SET state = 'optimized_active',
              optimized_active_generation_id = ${context.activeGenerationId},
              parity_evidence_json = ${transaction.json(input.parityEvidence as never)},
              verified_at = ${input.activatedAt}, completed_at = ${input.activatedAt},
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              attempt_count = 0, last_error_code = NULL, last_error_message = NULL,
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        return "activated" as const;
      });
    },

    async fail(input) {
      await sql`
        UPDATE focowiki.knowledge_base_optimization_migrations
        SET state = 'failed', attempt_count = attempt_count + 1,
            last_error_code = ${input.errorCode},
            last_error_message = left(${input.errorMessage}, 1000),
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = ${input.failedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND lease_owner = ${input.workerId}
          AND lease_token = ${input.leaseToken}
      `;
    }
  };
}

async function updateProgress(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; workerId: string; leaseToken: string },
  progress: {
    column: "high_water_source_file_id" | "high_water_projection_record_id" | "high_water_object_identity";
    value: string;
    updatedAt: string;
  }
): Promise<void> {
  await sql.begin(async (transaction) => {
    await assertOwnedMigration(transaction, input);
    if (progress.column === "high_water_source_file_id") {
      await transaction`
        UPDATE focowiki.knowledge_base_optimization_migrations
        SET high_water_source_file_id = ${progress.value}, attempt_count = 0,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = ${progress.updatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
      `;
      return;
    }
    if (progress.column === "high_water_projection_record_id") {
      await transaction`
        UPDATE focowiki.knowledge_base_optimization_migrations
        SET high_water_projection_record_id = ${progress.value}, attempt_count = 0,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = ${progress.updatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
      `;
      return;
    }
    await transaction`
      UPDATE focowiki.knowledge_base_optimization_migrations
      SET high_water_object_identity = ${progress.value}, attempt_count = 0,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          updated_at = ${progress.updatedAt}
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
    `;
  });
}

async function assertOwnedMigration(
  sql: DatabaseClient | TransactionSql,
  input: { knowledgeBaseId: string; workerId: string; leaseToken: string }
): Promise<void> {
  const rows = await sql<Array<{ knowledge_base_id: string }>>`
    SELECT knowledge_base_id
    FROM focowiki.knowledge_base_optimization_migrations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND lease_owner = ${input.workerId}
      AND lease_token = ${input.leaseToken}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new Error("Optimization migration lease is no longer owned");
}

async function lockMigrationActivationContext(
  transaction: TransactionSql<Record<string, never>>,
  input: { knowledgeBaseId: string; workerId: string; leaseToken: string }
): Promise<{
  activeGenerationId: string | null;
  priorActiveGenerationId: string | null;
}> {
  const rows = await transaction<Array<{
    active_generation_id: string | null;
    prior_active_generation_id: string | null;
  }>>`
    SELECT knowledge_base.active_generation_id,
           migration.prior_active_generation_id
    FROM focowiki.knowledge_bases knowledge_base
    JOIN focowiki.knowledge_base_optimization_migrations migration
      ON migration.knowledge_base_id = knowledge_base.id
    WHERE knowledge_base.id = ${input.knowledgeBaseId}
      AND knowledge_base.deleted_at IS NULL
      AND migration.lease_owner = ${input.workerId}
      AND migration.lease_token = ${input.leaseToken}
      AND migration.phase = 'verifying'
    FOR UPDATE OF knowledge_base, migration
  `;
  const row = rows[0];
  if (!row) throw new Error("Optimization migration activation ownership changed");
  return {
    activeGenerationId: row.active_generation_id,
    priorActiveGenerationId: row.prior_active_generation_id
  };
}

async function rebaseMigration(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    activeGenerationId: string | null;
    updatedAt: string;
  }
): Promise<void> {
  const rows = await transaction<Array<{ knowledge_base_id: string }>>`
    UPDATE focowiki.knowledge_base_optimization_migrations
    SET state = 'verifying', phase = 'verifying',
        prior_active_generation_id = ${input.activeGenerationId},
        optimized_active_generation_id = NULL,
        parity_evidence_json = '{}'::jsonb,
        attempt_count = 0, last_error_code = NULL, last_error_message = NULL,
        verified_at = NULL, completed_at = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        updated_at = ${input.updatedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND lease_owner = ${input.workerId}
      AND lease_token = ${input.leaseToken}
    RETURNING knowledge_base_id
  `;
  if (rows.length !== 1) throw new Error("Optimization migration rebase ownership changed");
}

function mapClaim(row: MigrationRow): OptimizationMigrationClaim {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    state: row.state,
    phase: row.phase,
    highWaterSourceFileId: row.high_water_source_file_id,
    highWaterProjectionRecordId: row.high_water_projection_record_id,
    highWaterObjectIdentity: row.high_water_object_identity,
    priorActiveGenerationId: row.prior_active_generation_id,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token
  };
}

function mapSource(row: SourceRow): OptimizationMigrationSource {
  const profile = record(row.profile_json);
  return {
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    objectKey: row.object_key,
    title: row.title,
    headings: stringArray(row.headings_json),
    phrases: [
      ...stringArray(profile.definitions),
      ...stringArray(profile.evidencePhrases),
      ...stringArray(profile.processHints),
      ...stringArray(profile.versionHints)
    ],
    entities: stringArray(row.entities_json),
    explicitReferences: stringArray(row.explicit_references_json),
    supplementalTerms: [
      ...stringArray(row.subjects_json),
      ...stringArray(row.tags_json),
      ...stringArray(row.keywords_json),
      ...stringArray(row.relationship_hints_json)
    ]
  };
}

function mapLegacyProjection(row: LegacyProjectionRow): LegacyProjectionSegment {
  return {
    shardId: row.shard_id,
    knowledgeBaseId: row.knowledge_base_id,
    generationId: row.generation_id,
    projectionKind: row.projection_kind,
    logicalPartition: row.logical_partition,
    formatVersion: Number(row.format_version),
    checksumSha256: row.checksum_sha256,
    objectKey: row.object_key,
    logicalPath: row.logical_path,
    entryCount: Number(row.entry_count),
    encodedBytes: Number(row.encoded_bytes)
  };
}

function mapReferencedObject(row: ReferencedObjectRow): ReferencedMigrationObject {
  return {
    identity: row.identity,
    checksumSha256: row.checksum_sha256,
    formatVersion: Number(row.format_version),
    objectKey: row.object_key,
    objectPresent: row.object_present
  };
}

function mapParityEvidence(row: ParityRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)])
  );
}

function legacySegmentId(shardId: string): string {
  return `segment-legacy-${createHash("md5").update(shardId).digest("hex")}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Optimization migration batch size must be a positive integer");
  }
  return Math.min(value, 1_000);
}
