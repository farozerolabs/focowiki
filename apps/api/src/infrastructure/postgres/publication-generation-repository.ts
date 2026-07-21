import type {
  FrozenGeneration,
  PublicationGenerationRepository,
  SourceCompletionCommitResult
} from "../../application/ports/publication-generation-repository.js";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { PublicationGenerationBusyError } from "../../domain/publication.js";
import { appendPublicationChangeFact } from "./publication-change-fact-writer.js";
import { assemblePendingPublicationChanges } from "./generation-assembler.js";

type GenerationRow = {
  id: string;
  predecessor_generation_id: string | null;
  state: string;
  created_at: Date;
};

export function createPostgresPublicationGenerationRepository(
  sql: DatabaseClient
): PublicationGenerationRepository {
  return {
    async getProgressSummary(input) {
      const rows = await sql<Array<{
        generation_id: string;
        stage: string;
        processed_impact_count: number | string;
        total_impact_count: number | string;
        touched_shard_count: number | string;
        oldest_dirty_at: Date | null;
        queued_at: Date | null;
        started_at: Date | null;
        heartbeat_at: Date | null;
        completed_at: Date | null;
        last_success_at: Date | null;
        safe_error_code: string | null;
        safe_error_message: string | null;
      }>>`
        SELECT generation.id AS generation_id,
               coalesce(progress.stage, generation.state) AS stage,
               coalesce(progress.processed_impact_count, 0) AS processed_impact_count,
               coalesce(progress.total_impact_count, 0) AS total_impact_count,
               coalesce(progress.touched_shard_count, 0) AS touched_shard_count,
               progress.oldest_dirty_at, progress.queued_at, progress.started_at,
               progress.heartbeat_at, progress.completed_at, progress.last_success_at,
               coalesce(progress.safe_error_code, generation.safe_error_code) AS safe_error_code,
               coalesce(progress.safe_error_message, generation.safe_error_message) AS safe_error_message
        FROM focowiki.publication_generations generation
        LEFT JOIN focowiki.publication_progress progress
          ON progress.knowledge_base_id = generation.knowledge_base_id
         AND progress.generation_id = generation.id
        WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
          AND generation.generation_kind = 'normal'
          AND generation.state IN ('open', 'frozen', 'building', 'validating', 'failed')
        ORDER BY CASE generation.state
                   WHEN 'frozen' THEN 0 WHEN 'building' THEN 0 WHEN 'validating' THEN 0
                   WHEN 'open' THEN 1 ELSE 2
                 END,
                 generation.updated_at DESC, generation.id
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return emptyProgressSummary();
      return {
        generationId: row.generation_id,
        stage: row.stage,
        processedImpactCount: Number(row.processed_impact_count),
        totalImpactCount: Number(row.total_impact_count),
        touchedShardCount: Number(row.touched_shard_count),
        throughputPerMinute: calculateThroughputPerMinute({
          processedCount: Number(row.processed_impact_count),
          startedAt: row.started_at,
          heartbeatAt: row.completed_at ?? row.heartbeat_at
        }),
        oldestDirtyAt: row.oldest_dirty_at?.toISOString() ?? null,
        queuedAt: row.queued_at?.toISOString() ?? null,
        startedAt: row.started_at?.toISOString() ?? null,
        heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
        lastSuccessAt: row.last_success_at?.toISOString() ?? null,
        safeErrorCode: row.safe_error_code,
        safeErrorMessage: row.safe_error_message
      };
    },

    async commitSourceCompletion(input) {
      return sql.begin(async (transaction) => {
        await lockChangeFact(transaction, input.changeFactId);
        const replay = await findChangeFactReplay(transaction, input.changeFactId);
        if (replay) return replay;

        const revision = await transaction<Array<{ revision: number }>>`
          SELECT revision.revision
          FROM focowiki.source_revisions revision
          JOIN focowiki.source_files source ON source.id = revision.source_file_id
          WHERE revision.id = ${input.sourceRevisionId}
            AND revision.knowledge_base_id = ${input.knowledgeBaseId}
            AND revision.source_file_id = ${input.sourceFileId}
            AND (source.active_revision_id = revision.id OR source.candidate_revision_id = revision.id)
            AND source.resource_revision + CASE
                  WHEN source.candidate_revision_id = revision.id THEN 1 ELSE 0
                END = ${input.resourceRevision}
            AND CASE
                  WHEN source.candidate_revision_id = revision.id
                    THEN source.candidate_relative_path
                  ELSE source.relative_path
                END = ${input.path}
            AND CASE
                  WHEN source.candidate_revision_id = revision.id
                    THEN source.relative_path
                  ELSE NULL
                END IS NOT DISTINCT FROM ${input.previousPath}
            AND CASE
                  WHEN source.candidate_revision_id = revision.id
                    THEN source.candidate_operation_id
                  ELSE NULL
                END IS NOT DISTINCT FROM ${input.operationId}
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
          FOR NO KEY UPDATE OF revision, source
        `;
        if (!revision[0]) {
          throw new Error("Source revision is no longer eligible for publication");
        }

        await transaction`
          UPDATE focowiki.source_revisions
          SET processing_status = 'completed'
          WHERE id = ${input.sourceRevisionId}
        `;
        await transaction`
          UPDATE focowiki.source_files
          SET processing_status = 'completed',
              processing_stage = 'projection_generation',
              processing_ended_at = ${input.completedAt},
              generated_output_status = 'pending'
          WHERE id = ${input.sourceFileId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        `;
        if (input.operationId) {
          const operations = await transaction<Array<{ id: string }>>`
            UPDATE focowiki.resource_operations
            SET state = 'publishing', updated_at = ${input.completedAt}
            WHERE id = ${input.operationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND state = 'processing'
            RETURNING id
          `;
          if (operations.length !== 1) {
            throw new Error("Source operation is no longer eligible for publication");
          }
        }
        const planning = input.planningContext;
        if (!input.impacts && !planning) {
          throw new Error("Source completion planning context is required");
        }
        const inserted = await appendPublicationChangeFact(transaction, {
          changeFactId: input.changeFactId,
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId,
          sourceRevisionId: input.sourceRevisionId,
          operationId: input.operationId,
          deletionIntentId: null,
          kind: input.kind,
          previousPath: input.previousPath,
          path: input.path,
          resourceRevision: input.resourceRevision,
          planningPayload: {
            ...(input.impacts ? { preplannedImpacts: input.impacts } : {}),
            ...(planning ?? {}),
            schedulePublication: true,
            allowDeletedKnowledgeBase: false
          },
          publicationSettingsSnapshot: input.publicationSettingsSnapshot,
          publicationMaxAttempts: input.publicationMaxAttempts,
          committedAt: input.completedAt
        });

        return {
          generationId: null,
          changeFactId: input.changeFactId,
          impactCount: 0,
          replayed: !inserted
        } satisfies SourceCompletionCommitResult;
      });
    },

    async commitMutation(input) {
      return sql.begin(async (transaction) => {
        await lockChangeFact(transaction, input.changeFactId);
        const replay = await findChangeFactReplay(transaction, input.changeFactId);
        if (replay) return replay;

        if (input.operationId && input.kind !== "knowledge_base_deleted") {
          await transaction`
            UPDATE focowiki.resource_operations
            SET state = 'publishing', updated_at = ${input.committedAt}
            WHERE id = ${input.operationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND state IN ('accepted', 'processing')
          `;
        }
        const inserted = await appendPublicationChangeFact(transaction, {
          changeFactId: input.changeFactId,
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: input.sourceFileId,
          sourceRevisionId: input.sourceRevisionId,
          operationId: input.operationId,
          deletionIntentId: input.deletionIntentId,
          kind: input.kind,
          previousPath: input.previousPath,
          path: input.path,
          resourceRevision: input.resourceRevision,
          planningPayload: {
            preplannedImpacts: input.impacts,
            schedulePublication: input.schedulePublication !== false,
            skipGeneration: input.kind === "knowledge_base_deleted",
            allowDeletedKnowledgeBase: input.kind === "knowledge_base_deleted"
          },
          publicationSettingsSnapshot: input.publicationSettingsSnapshot,
          publicationMaxAttempts: input.publicationMaxAttempts,
          committedAt: input.committedAt
        });

        return {
          generationId: null,
          changeFactId: input.changeFactId,
          impactCount: 0,
          replayed: !inserted
        };
      });
    },

    async assemblePendingChanges(input) {
      return assemblePendingPublicationChanges(sql, input);
    },

    async freezeGeneration(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const generations = await transaction<GenerationRow[]>`
          SELECT id, predecessor_generation_id, state, created_at
          FROM focowiki.publication_generations
          WHERE id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        let generation = generations[0];
        if (
          !generation ||
          !["open", "frozen", "building", "validating", "failed"].includes(generation.state)
        ) {
          return null;
        }
        if (generation.state === "open" || generation.state === "failed") {
          const inProgress = await transaction<Array<{ id: string }>>`
            SELECT id
            FROM focowiki.publication_generations
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND id <> ${input.generationId}
              AND state IN ('frozen', 'building', 'validating')
            LIMIT 1
          `;
          if (inProgress[0]) {
            throw new PublicationGenerationBusyError();
          }
        }
        const totals = await transaction<Array<{ total: number }>>`
          SELECT count(id)::int AS total
          FROM focowiki.publication_impacts
          WHERE generation_id = ${input.generationId}
            AND status <> 'cancelled'
        `;
        if ((totals[0]?.total ?? 0) === 0) {
          await transaction`
            UPDATE focowiki.publication_generations
            SET state = 'superseded', updated_at = ${input.frozenAt}
            WHERE id = ${input.generationId} AND state IN ('open', 'failed')
          `;
          return null;
        }
        if (generation.state === "failed") {
          const resumed = await transaction<GenerationRow[]>`
            UPDATE focowiki.publication_generations generation
            SET state = 'building',
                predecessor_generation_id = knowledge_base.active_generation_id,
                frozen_at = coalesce(generation.frozen_at, ${input.frozenAt}),
                failed_at = NULL,
                safe_error_code = NULL,
                safe_error_message = NULL,
                updated_at = ${input.frozenAt}
            FROM focowiki.knowledge_bases knowledge_base
            WHERE generation.id = ${input.generationId}
              AND generation.knowledge_base_id = ${input.knowledgeBaseId}
              AND generation.state = 'failed'
              AND knowledge_base.id = generation.knowledge_base_id
              AND knowledge_base.deleted_at IS NULL
            RETURNING generation.id, generation.predecessor_generation_id,
                      generation.state, generation.created_at
          `;
          if (!resumed[0]) return null;
          generation = resumed[0];
        } else if (generation.state === "open") {
          await transaction`
            UPDATE focowiki.publication_generations
            SET state = 'frozen', frozen_at = coalesce(frozen_at, ${input.frozenAt}),
                updated_at = ${input.frozenAt}
            WHERE id = ${input.generationId} AND state = 'open'
          `;
        }
        await transaction`
          INSERT INTO focowiki.publication_progress (
            knowledge_base_id, generation_id, stage,
            processed_impact_count, total_impact_count, touched_shard_count,
            queued_at, started_at, heartbeat_at, updated_at
          ) VALUES (
            ${input.knowledgeBaseId}, ${input.generationId}, 'planning',
            0, ${totals[0]!.total}, 0, ${input.frozenAt}, ${input.frozenAt},
            ${input.frozenAt}, ${input.frozenAt}
          )
          ON CONFLICT (knowledge_base_id, generation_id) DO UPDATE
          SET stage = CASE
                WHEN focowiki.publication_progress.stage = 'failed' THEN 'projection'
                ELSE focowiki.publication_progress.stage
              END,
              total_impact_count = EXCLUDED.total_impact_count,
              completed_at = NULL,
              safe_error_code = NULL,
              safe_error_message = NULL,
              heartbeat_at = EXCLUDED.heartbeat_at,
              updated_at = EXCLUDED.updated_at
        `;
        return {
          generationId: generation.id,
          predecessorGenerationId: generation.predecessor_generation_id,
          state: generation.state === "open"
            ? "frozen"
            : generation.state as FrozenGeneration["state"],
          totalImpactCount: totals[0]!.total,
          frozenAt: input.frozenAt
        } satisfies FrozenGeneration;
      });
    },

    async markGenerationState(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.publication_generations
        SET state = ${input.state}, updated_at = ${input.updatedAt}
        WHERE id = ${input.generationId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND state = ${input.expectedState}
        RETURNING id
      `;
      return rows.length === 1;
    },

    async activateGeneration(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const knowledgeBases = await transaction<Array<{ active_generation_id: string | null }>>`
          SELECT active_generation_id
          FROM focowiki.knowledge_bases
          WHERE id = ${input.knowledgeBaseId} AND deleted_at IS NULL
          FOR UPDATE
        `;
        if (
          !knowledgeBases[0]
          || knowledgeBases[0].active_generation_id !== input.expectedPredecessorGenerationId
        ) {
          return false;
        }
        const candidates = await transaction<Array<{ id: string }>>`
          SELECT id
          FROM focowiki.publication_generations
          WHERE id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND state = 'validating'
          FOR UPDATE
        `;
        if (candidates.length !== 1) {
          return false;
        }
        const invalidObjectReferences = await transaction<Array<{ total: number }>>`
          SELECT count(reference.ref_key)::int AS total
          FROM focowiki.generation_object_refs reference
          LEFT JOIN focowiki.immutable_objects object
            ON object.checksum_sha256 = reference.checksum_sha256
           AND object.format_version = reference.format_version
          WHERE reference.generation_id = ${input.generationId}
            AND reference.knowledge_base_id = ${input.knowledgeBaseId}
            AND reference.action = 'upsert'
            AND (
              object.checksum_sha256 IS NULL
              OR object.lifecycle_state <> 'active'
            )
        `;
        if (Number(invalidObjectReferences[0]?.total ?? 0) > 0) {
          throw new Error("Candidate generation contains an unverified immutable object");
        }
        if (input.expectedPredecessorGenerationId) {
          await transaction`
            INSERT INTO focowiki.generation_tree_directory_stats (
              knowledge_base_id, generation_id, path, parent_path,
              direct_entry_count, direct_directory_count, direct_file_count,
              descendant_file_count, created_at, updated_at
            )
            SELECT knowledge_base_id, ${input.generationId}, path, parent_path,
                   direct_entry_count, direct_directory_count, direct_file_count,
                   descendant_file_count, ${input.activatedAt}, ${input.activatedAt}
            FROM focowiki.generation_tree_directory_stats
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND generation_id = ${input.expectedPredecessorGenerationId}
            ON CONFLICT (generation_id, path) DO NOTHING
          `;
        }
        await transaction`
          DELETE FROM focowiki.generation_tree_directory_stats statistics
          USING focowiki.generation_projection_records change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.projection_kind = 'tree'
            AND change.action = 'delete'
            AND statistics.generation_id = change.generation_id
            AND statistics.path = CASE
              WHEN change.record_id = 'directory:' THEN 'pages'
              ELSE 'pages/' || substring(change.record_id from length('directory:') + 1)
            END
        `;
        if (input.expectedPredecessorGenerationId) {
          const predecessors = await transaction<Array<{ id: string }>>`
            UPDATE focowiki.publication_generations
            SET state = 'superseded', successor_generation_id = ${input.generationId},
                updated_at = ${input.activatedAt}
            WHERE id = ${input.expectedPredecessorGenerationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND state = 'active'
            RETURNING id
          `;
          if (predecessors.length !== 1) {
            throw new Error("Active generation state is inconsistent");
          }
        }
        await transaction`
          UPDATE focowiki.publication_generations
          SET state = 'active',
              root_manifest_checksum_sha256 = ${input.rootManifestChecksumSha256},
              root_manifest_object_key = ${input.rootManifestObjectKey},
              validated_at = coalesce(validated_at, ${input.activatedAt}),
              activated_at = ${input.activatedAt}, updated_at = ${input.activatedAt}
          WHERE id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND state = 'validating'
        `;
        await transaction`
          UPDATE focowiki.publication_generations
          SET predecessor_generation_id = ${input.generationId},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id <> ${input.generationId}
            AND state IN ('open', 'frozen', 'building', 'validating')
            AND predecessor_generation_id IS NOT DISTINCT FROM ${input.expectedPredecessorGenerationId}
        `;
        await transaction`
          DELETE FROM focowiki.active_object_refs active
          USING focowiki.generation_object_refs change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.action = 'delete'
            AND active.knowledge_base_id = change.knowledge_base_id
            AND active.ref_kind = change.ref_kind
            AND active.ref_key = change.ref_key
        `;
        await transaction`
          DELETE FROM focowiki.active_object_refs active
          USING focowiki.generation_object_refs change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.action = 'upsert'
            AND change.logical_path IS NOT NULL
            AND active.knowledge_base_id = change.knowledge_base_id
            AND active.logical_path = change.logical_path
            AND NOT (
              active.ref_kind = change.ref_kind
              AND active.ref_key = change.ref_key
            )
        `;
        await transaction`
          INSERT INTO focowiki.active_object_refs (
            knowledge_base_id, ref_kind, ref_key, file_id, last_changed_generation_id,
            checksum_sha256, format_version, logical_path, source_file_id,
            projection_shard_id, updated_at
          )
          SELECT change.knowledge_base_id, change.ref_kind, change.ref_key,
                 change.file_id,
                 change.generation_id, change.checksum_sha256, change.format_version,
                 change.logical_path, change.source_file_id,
                 change.projection_shard_id, ${input.activatedAt}
          FROM focowiki.generation_object_refs change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.action = 'upsert'
          ON CONFLICT (knowledge_base_id, ref_kind, ref_key) DO UPDATE
          SET file_id = EXCLUDED.file_id,
              last_changed_generation_id = EXCLUDED.last_changed_generation_id,
              checksum_sha256 = EXCLUDED.checksum_sha256,
              format_version = EXCLUDED.format_version,
              logical_path = EXCLUDED.logical_path,
              source_file_id = EXCLUDED.source_file_id,
              projection_shard_id = EXCLUDED.projection_shard_id,
              updated_at = EXCLUDED.updated_at
        `;
        await transaction`
          DELETE FROM focowiki.active_projection_records active
          USING focowiki.generation_projection_records change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.action = 'delete'
            AND active.knowledge_base_id = change.knowledge_base_id
            AND active.projection_kind = change.projection_kind
            AND active.record_id = change.record_id
        `;
        await transaction`
          INSERT INTO focowiki.active_projection_records (
            knowledge_base_id, projection_kind, record_id,
            last_changed_generation_id, shard_key, source_file_id,
            related_source_file_id, logical_path, parent_path, sort_key,
            title, summary, searchable_text, payload_json, updated_at
          )
          SELECT change.knowledge_base_id, change.projection_kind,
                 change.record_id, change.generation_id, change.shard_key,
                 change.source_file_id, change.related_source_file_id,
                 change.logical_path, change.parent_path, change.sort_key,
                 change.title, change.summary, change.searchable_text,
                 change.payload_json, ${input.activatedAt}
          FROM focowiki.generation_projection_records change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.action = 'upsert'
          ON CONFLICT (knowledge_base_id, projection_kind, record_id) DO UPDATE
          SET last_changed_generation_id = EXCLUDED.last_changed_generation_id,
              shard_key = EXCLUDED.shard_key,
              source_file_id = EXCLUDED.source_file_id,
              related_source_file_id = EXCLUDED.related_source_file_id,
              logical_path = EXCLUDED.logical_path,
              parent_path = EXCLUDED.parent_path,
              sort_key = EXCLUDED.sort_key, title = EXCLUDED.title,
              summary = EXCLUDED.summary,
              searchable_text = EXCLUDED.searchable_text,
              payload_json = EXCLUDED.payload_json,
              updated_at = EXCLUDED.updated_at
        `;
        await transaction`
          INSERT INTO focowiki.generation_graph_summaries (
            knowledge_base_id, generation_id, node_count, edge_count,
            graph_index_available, updated_at
          )
          SELECT ${input.knowledgeBaseId}, ${input.generationId},
                 count(*) FILTER (WHERE projection_kind = 'graph_node'),
                 count(*) FILTER (WHERE projection_kind = 'graph_edge'),
                 EXISTS (
                   SELECT 1 FROM focowiki.active_object_refs reference
                   WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
                     AND reference.logical_path = '_graph/index.md'
                 ),
                 ${input.activatedAt}
          FROM focowiki.active_projection_records
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND projection_kind IN ('graph_node', 'graph_edge')
          ON CONFLICT (generation_id) DO UPDATE
          SET node_count = EXCLUDED.node_count,
              edge_count = EXCLUDED.edge_count,
              graph_index_available = EXCLUDED.graph_index_available,
              updated_at = EXCLUDED.updated_at
        `;
        await transaction`
          WITH touched AS MATERIALIZED (
            SELECT DISTINCT segment.projection_kind, segment.logical_partition
            FROM focowiki.generation_projection_segments lineage
            JOIN focowiki.projection_segments segment ON segment.id = lineage.segment_id
            WHERE lineage.generation_id = ${input.generationId}
              AND segment.knowledge_base_id = ${input.knowledgeBaseId}
          )
          DELETE FROM focowiki.active_projection_segments active
          USING touched
          WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
            AND active.projection_kind = touched.projection_kind
            AND active.logical_partition = touched.logical_partition
        `;
        await transaction`
          INSERT INTO focowiki.active_projection_segments (
            knowledge_base_id, projection_kind, logical_partition,
            segment_id, ordinal, updated_at
          )
          SELECT segment.knowledge_base_id, segment.projection_kind,
                 segment.logical_partition, lineage.segment_id,
                 lineage.ordinal, ${input.activatedAt}
          FROM focowiki.generation_projection_segments lineage
          JOIN focowiki.projection_segments segment ON segment.id = lineage.segment_id
          WHERE lineage.generation_id = ${input.generationId}
            AND segment.knowledge_base_id = ${input.knowledgeBaseId}
            AND lineage.effective = true
            AND segment.lifecycle_state IN ('active', 'retained')
          ON CONFLICT (
            knowledge_base_id, projection_kind, logical_partition, segment_id
          ) DO UPDATE
          SET ordinal = EXCLUDED.ordinal, updated_at = EXCLUDED.updated_at
        `;
        await transaction`
          INSERT INTO focowiki.active_projection_partition_stats (
            knowledge_base_id, projection_kind, logical_partition,
            record_count, last_changed_generation_id, updated_at
          )
          SELECT statistics.knowledge_base_id, statistics.projection_kind,
                 statistics.logical_partition, statistics.record_count,
                 statistics.generation_id, ${input.activatedAt}
          FROM focowiki.generation_projection_partition_stats statistics
          WHERE statistics.generation_id = ${input.generationId}
            AND statistics.knowledge_base_id = ${input.knowledgeBaseId}
          ON CONFLICT (knowledge_base_id, projection_kind, logical_partition) DO UPDATE
          SET record_count = EXCLUDED.record_count,
              last_changed_generation_id = EXCLUDED.last_changed_generation_id,
              updated_at = EXCLUDED.updated_at
        `;
        await transaction`
          WITH captured_operations AS MATERIALIZED (
            SELECT DISTINCT operation_id
            FROM focowiki.publication_change_facts
            WHERE generation_id = ${input.generationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND operation_id IS NOT NULL
          )
          UPDATE focowiki.source_directories directory
          SET parent_id = directory.candidate_parent_id,
              name = directory.candidate_name,
              relative_path = directory.candidate_relative_path,
              path_key = directory.candidate_path_key,
              depth = directory.candidate_depth,
              resource_revision = directory.resource_revision + 1,
              candidate_operation_id = NULL,
              candidate_parent_id = NULL,
              candidate_name = NULL,
              candidate_relative_path = NULL,
              candidate_path_key = NULL,
              candidate_depth = NULL,
              updated_at = ${input.activatedAt}
          FROM captured_operations captured
          WHERE directory.candidate_operation_id = captured.operation_id
        `;
        await transaction`
          WITH captured_operations AS MATERIALIZED (
            SELECT DISTINCT operation_id
            FROM focowiki.publication_change_facts
            WHERE generation_id = ${input.generationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND operation_id IS NOT NULL
          )
          UPDATE focowiki.source_files source
          SET name = source.candidate_name,
              relative_path = source.candidate_relative_path,
              path_key = source.candidate_path_key,
              directory_id = source.candidate_directory_id,
              object_key = coalesce(source.candidate_object_key, source.object_key),
              content_type = coalesce(source.candidate_content_type, source.content_type),
              size_bytes = coalesce(source.candidate_size_bytes, source.size_bytes),
              checksum_sha256 = coalesce(source.candidate_checksum_sha256, source.checksum_sha256),
              metadata_json = coalesce(source.candidate_metadata_json, source.metadata_json),
              model_suggestions_json = CASE
                WHEN source.candidate_revision_id IS NULL THEN source.model_suggestions_json
                ELSE source.candidate_model_suggestions_json
              END,
              active_revision_id = coalesce(source.candidate_revision_id, source.active_revision_id),
              content_revision = source.content_revision + CASE
                WHEN source.candidate_revision_id IS NULL THEN 0 ELSE 1 END,
              resource_revision = source.resource_revision + 1,
              candidate_operation_id = NULL,
              candidate_revision_id = NULL,
              candidate_name = NULL,
              candidate_relative_path = NULL,
              candidate_path_key = NULL,
              candidate_directory_id = NULL,
              candidate_object_key = NULL,
              candidate_content_type = NULL,
              candidate_size_bytes = NULL,
              candidate_checksum_sha256 = NULL,
              candidate_metadata_json = NULL,
              candidate_model_suggestions_json = NULL
          FROM captured_operations captured
          WHERE source.candidate_operation_id = captured.operation_id
        `;
        await transaction`
          WITH captured_operations AS MATERIALIZED (
            SELECT DISTINCT operation_id
            FROM focowiki.publication_change_facts
            WHERE generation_id = ${input.generationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND operation_id IS NOT NULL
          )
          UPDATE focowiki.resource_operations operation
          SET state = 'completed', completed_at = ${input.activatedAt},
              updated_at = ${input.activatedAt},
              result_json = coalesce(operation.result_json, '{}'::jsonb)
                || jsonb_build_object(
                  'generationId', ${input.generationId}::text,
                  'visibility', 'active'::text
                )
          FROM captured_operations captured
          WHERE operation.id = captured.operation_id
            AND operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.state = 'publishing'
        `;
        await transaction`
          DELETE FROM focowiki.resource_path_reservations reservation
          USING focowiki.resource_operations operation
          WHERE reservation.operation_id = operation.id
            AND operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.state = 'completed'
        `;
        await transaction`
          WITH captured_deletions AS MATERIALIZED (
            SELECT DISTINCT deletion_intent_id
            FROM focowiki.publication_change_facts
            WHERE generation_id = ${input.generationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND deletion_intent_id IS NOT NULL
          )
          UPDATE focowiki.deletion_intents intent
          SET state = 'completed', progress_cursor = 'active_generation',
              completed_at = ${input.activatedAt}, updated_at = ${input.activatedAt}
          FROM captured_deletions captured
          WHERE intent.id = captured.deletion_intent_id
            AND intent.knowledge_base_id = ${input.knowledgeBaseId}
            AND intent.state IN ('accepted', 'running')
        `;
        await transaction`
          UPDATE focowiki.knowledge_bases
          SET active_generation_id = ${input.generationId}, updated_at = ${input.activatedAt}
          WHERE id = ${input.knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.publication_generations
          SET predecessor_generation_id = ${input.generationId},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND state = 'open'
            AND predecessor_generation_id IS NOT DISTINCT FROM ${input.expectedPredecessorGenerationId}
        `;
        await transaction`
          UPDATE focowiki.source_files source
          SET generated_output_status = 'visible',
              processing_stage = 'generation_activation'
          FROM focowiki.publication_change_facts fact
          WHERE fact.generation_id = ${input.generationId}
            AND fact.knowledge_base_id = ${input.knowledgeBaseId}
            AND fact.source_file_id = source.id
            AND source.knowledge_base_id = fact.knowledge_base_id
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
        `;
        await transaction`
          UPDATE focowiki.publication_progress
          SET stage = 'active', completed_at = ${input.activatedAt},
              last_success_at = ${input.activatedAt}, heartbeat_at = ${input.activatedAt},
              updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
        `;
        return true;
      });
    },

    async failGeneration(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.publication_generations
          SET state = 'failed', failed_at = ${input.failedAt},
              safe_error_code = ${input.code},
              safe_error_message = ${input.message.slice(0, 1_000)},
              updated_at = ${input.failedAt}
          WHERE id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND state IN ('open', 'frozen', 'building', 'validating')
        `;
        await transaction`
          UPDATE focowiki.publication_impacts
          SET status = 'cancelled', claimed_by = NULL, claimed_at = NULL,
              heartbeat_at = NULL, completed_at = ${input.failedAt},
              last_error_code = ${input.code.slice(0, 128)},
              last_error_message = ${input.message.slice(0, 1_000)},
              updated_at = ${input.failedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND status IN ('pending', 'running')
        `;
        await transaction`
          UPDATE focowiki.publication_progress
          SET stage = 'failed', safe_error_code = ${input.code},
              safe_error_message = ${input.message.slice(0, 1_000)},
              completed_at = ${input.failedAt}, heartbeat_at = ${input.failedAt},
              updated_at = ${input.failedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
        `;
        await transaction`
          UPDATE focowiki.source_files source
          SET processing_status = 'failed',
              processing_stage = 'projection_generation',
              processing_ended_at = ${input.failedAt},
              generated_output_status = 'unavailable',
              terminal_failure_stage = 'projection_generation',
              terminal_failure_code = ${input.code.slice(0, 128)},
              terminal_failure_message = ${input.message.slice(0, 1_000)},
              terminal_failure_at = ${input.failedAt},
              terminal_failure_retry_kind = 'publication',
              terminal_failure_correlation_id = ${input.generationId}
          FROM (
            SELECT DISTINCT source_file_id
            FROM focowiki.publication_change_facts
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND generation_id = ${input.generationId}
              AND source_file_id IS NOT NULL
          ) affected
          WHERE source.id = affected.source_file_id
            AND source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
        `;
      });
    }
  };
}

async function lockChangeFact(
  transaction: TransactionSql<Record<string, never>>,
  changeFactId: string
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended('focowiki:change-fact:' || ${changeFactId}, 0)
    )
  `;
}

async function findChangeFactReplay(
  transaction: TransactionSql<Record<string, never>>,
  changeFactId: string
): Promise<SourceCompletionCommitResult | null> {
  const rows = await transaction<Array<{
    generation_id: string | null;
    impact_count: number;
  }>>`
    SELECT fact.generation_id,
           count(cause.impact_id)::int AS impact_count
    FROM focowiki.publication_change_facts fact
    LEFT JOIN focowiki.publication_impact_causes cause ON cause.change_fact_id = fact.id
    WHERE fact.id = ${changeFactId}
    GROUP BY fact.generation_id
  `;
  const replay = rows[0];
  return replay
    ? {
        generationId: replay.generation_id,
        changeFactId,
        impactCount: replay.impact_count,
        replayed: true
      }
    : null;
}

function emptyProgressSummary() {
  return {
    generationId: null,
    stage: null,
    processedImpactCount: 0,
    totalImpactCount: 0,
    touchedShardCount: 0,
    throughputPerMinute: null,
    oldestDirtyAt: null,
    queuedAt: null,
    startedAt: null,
    heartbeatAt: null,
    completedAt: null,
    lastSuccessAt: null,
    safeErrorCode: null,
    safeErrorMessage: null
  };
}

function calculateThroughputPerMinute(input: {
  processedCount: number;
  startedAt: Date | null;
  heartbeatAt: Date | null;
}): number | null {
  if (input.processedCount <= 0 || !input.startedAt || !input.heartbeatAt) return null;
  const elapsedMilliseconds = input.heartbeatAt.getTime() - input.startedAt.getTime();
  if (elapsedMilliseconds <= 0) return null;
  return Math.round((input.processedCount * 60_000 / elapsedMilliseconds) * 10) / 10;
}
