import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type {
  FrozenGeneration,
  PublicationGenerationRepository,
  SourceCompletionCommitResult
} from "../../application/ports/publication-generation-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { resolveGenerationSchedule } from "../../publication/generation-schedule.js";
import {
  capturePublicationProjectionInputs,
  persistCapturedProjectionInputs
} from "./publication-projection-input-capture.js";

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
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const replay = await transaction<Array<{
          generation_id: string;
          impact_count: number;
        }>>`
          SELECT fact.generation_id,
                 count(cause.impact_id)::int AS impact_count
          FROM focowiki.publication_change_facts fact
          LEFT JOIN focowiki.publication_impact_causes cause ON cause.change_fact_id = fact.id
          WHERE fact.id = ${input.changeFactId}
          GROUP BY fact.generation_id
        `;
        if (replay[0]?.generation_id) {
          return {
            generationId: replay[0].generation_id,
            changeFactId: input.changeFactId,
            impactCount: replay[0].impact_count,
            replayed: true
          } satisfies SourceCompletionCommitResult;
        }

        const revision = await transaction<Array<{ revision: number }>>`
          SELECT revision.revision
          FROM focowiki.source_revisions revision
          JOIN focowiki.source_files source ON source.id = revision.source_file_id
          WHERE revision.id = ${input.sourceRevisionId}
            AND revision.knowledge_base_id = ${input.knowledgeBaseId}
            AND revision.source_file_id = ${input.sourceFileId}
            AND (source.active_revision_id = revision.id OR source.candidate_revision_id = revision.id)
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
          FOR UPDATE OF revision, source
        `;
        if (!revision[0]) {
          throw new Error("Source revision is no longer eligible for publication");
        }

        const generation = await requireOpenGeneration(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          now: input.completedAt
        });
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
        const capturedInputs = await capturePublicationProjectionInputs(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: generation.id,
          changeKind: input.kind,
          sourceFileId: input.sourceFileId,
          sourceRevisionId: input.sourceRevisionId,
          previousPath: input.previousPath,
          path: input.path,
          impacts: input.impacts,
          now: input.completedAt
        });
        await persistCapturedProjectionInputs(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: generation.id,
          captured: capturedInputs,
          now: input.completedAt
        });
        await transaction`
          INSERT INTO focowiki.publication_change_facts (
            id, knowledge_base_id, source_file_id, source_revision_id, operation_id, kind,
            previous_path, path, resource_revision, generation_id, created_at
          ) VALUES (
            ${input.changeFactId}, ${input.knowledgeBaseId}, ${input.sourceFileId},
            ${input.sourceRevisionId}, ${input.operationId}, ${input.kind},
            ${input.previousPath}, ${input.path},
            ${input.resourceRevision}, ${generation.id}, ${input.completedAt}
          )
        `;
        for (const impact of input.impacts) {
          const rows = await transaction<Array<{ id: string }>>`
            INSERT INTO focowiki.publication_impacts (
              id, knowledge_base_id, generation_id,
              projection_kind, projection_key, record_identity, action, projection_input_key,
              run_after, created_at, updated_at
            ) VALUES (
              ${impact.id}, ${input.knowledgeBaseId}, ${generation.id},
              ${impact.projectionKind}, ${impact.projectionKey}, ${impact.recordIdentity},
              ${impact.action}, ${capturedInputs.get(impact.id)?.inputKey ?? null},
              ${input.completedAt}, ${input.completedAt}, ${input.completedAt}
            )
            ON CONFLICT (
              generation_id, projection_kind, projection_key, record_identity
            ) DO UPDATE SET action = EXCLUDED.action,
              projection_input_key = EXCLUDED.projection_input_key,
              run_after = least(focowiki.publication_impacts.run_after, EXCLUDED.run_after),
              updated_at = EXCLUDED.updated_at
            RETURNING id
          `;
          await transaction`
            INSERT INTO focowiki.publication_impact_causes (
              impact_id, change_fact_id, created_at
            ) VALUES (${rows[0]!.id}, ${input.changeFactId}, ${input.completedAt})
            ON CONFLICT (impact_id, change_fact_id) DO NOTHING
          `;
        }
        const factCounts = await transaction<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM focowiki.publication_change_facts
          WHERE generation_id = ${generation.id}
        `;
        const schedule = resolveGenerationSchedule({
          settingsSnapshot: input.publicationSettingsSnapshot,
          generationCreatedAt: generation.created_at.toISOString(),
          completedAt: input.completedAt,
          changeCount: factCounts[0]?.count ?? 0
        });
        if (schedule.enqueue) await transaction`
          INSERT INTO focowiki.role_jobs (
            id, role, kind, knowledge_base_id, generation_id,
            payload_json, settings_snapshot_json, run_after, max_attempts,
            created_at, updated_at
          ) VALUES (
            ${`role-job-publication-${generation.id}`}, 'publication',
            'generation_publication', ${input.knowledgeBaseId}, ${generation.id},
            ${transaction.json({ generationId: generation.id })},
            ${transaction.json(input.publicationSettingsSnapshot)},
            ${schedule.runAfter!}, ${input.publicationMaxAttempts},
            ${input.completedAt}, ${input.completedAt}
          )
          ON CONFLICT (generation_id) WHERE role = 'publication' AND generation_id IS NOT NULL
          DO UPDATE SET
            run_after = least(focowiki.role_jobs.run_after, EXCLUDED.run_after),
            settings_snapshot_json = EXCLUDED.settings_snapshot_json,
            max_attempts = EXCLUDED.max_attempts,
            updated_at = EXCLUDED.updated_at
        `;

        return {
          generationId: generation.id,
          changeFactId: input.changeFactId,
          impactCount: input.impacts.length,
          replayed: false
        } satisfies SourceCompletionCommitResult;
      });
    },

    async commitMutation(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const replay = await transaction<Array<{
          generation_id: string;
          impact_count: number;
        }>>`
          SELECT fact.generation_id,
                 count(cause.impact_id)::int AS impact_count
          FROM focowiki.publication_change_facts fact
          LEFT JOIN focowiki.publication_impact_causes cause ON cause.change_fact_id = fact.id
          WHERE fact.id = ${input.changeFactId}
          GROUP BY fact.generation_id
        `;
        if (replay[0]?.generation_id) {
          return {
            generationId: replay[0].generation_id,
            changeFactId: input.changeFactId,
            impactCount: replay[0].impact_count,
            replayed: true
          };
        }

        const generation = await requireOpenGeneration(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          now: input.committedAt,
          allowDeletedKnowledgeBase: input.kind === "knowledge_base_deleted"
        });
        if (input.operationId && input.kind !== "knowledge_base_deleted") {
          await transaction`
            UPDATE focowiki.resource_operations
            SET state = 'publishing', updated_at = ${input.committedAt}
            WHERE id = ${input.operationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND state IN ('accepted', 'processing')
          `;
        }
        const capturedInputs = await capturePublicationProjectionInputs(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: generation.id,
          changeKind: input.kind,
          sourceFileId: input.sourceFileId,
          sourceRevisionId: input.sourceRevisionId,
          previousPath: input.previousPath,
          path: input.path,
          impacts: input.impacts,
          now: input.committedAt
        });
        await persistCapturedProjectionInputs(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: generation.id,
          captured: capturedInputs,
          now: input.committedAt
        });
        await transaction`
          INSERT INTO focowiki.publication_change_facts (
            id, knowledge_base_id, source_file_id, source_revision_id,
            operation_id, deletion_intent_id, kind,
            previous_path, path, resource_revision, generation_id, created_at
          ) VALUES (
            ${input.changeFactId}, ${input.knowledgeBaseId}, ${input.sourceFileId},
            ${input.sourceRevisionId}, ${input.operationId}, ${input.deletionIntentId},
            ${input.kind}, ${input.previousPath}, ${input.path},
            ${input.resourceRevision}, ${generation.id}, ${input.committedAt}
          )
        `;
        for (const impact of input.impacts) {
          const rows = await transaction<Array<{ id: string }>>`
            INSERT INTO focowiki.publication_impacts (
              id, knowledge_base_id, generation_id,
              projection_kind, projection_key, record_identity, action, projection_input_key,
              run_after, created_at, updated_at
            ) VALUES (
              ${impact.id}, ${input.knowledgeBaseId}, ${generation.id},
              ${impact.projectionKind}, ${impact.projectionKey}, ${impact.recordIdentity},
              ${impact.action}, ${capturedInputs.get(impact.id)?.inputKey ?? null},
              ${input.committedAt}, ${input.committedAt}, ${input.committedAt}
            )
            ON CONFLICT (
              generation_id, projection_kind, projection_key, record_identity
            ) DO UPDATE SET action = EXCLUDED.action,
              projection_input_key = EXCLUDED.projection_input_key,
              run_after = least(focowiki.publication_impacts.run_after, EXCLUDED.run_after),
              updated_at = EXCLUDED.updated_at
            RETURNING id
          `;
          await transaction`
            INSERT INTO focowiki.publication_impact_causes (
              impact_id, change_fact_id, created_at
            ) VALUES (${rows[0]!.id}, ${input.changeFactId}, ${input.committedAt})
            ON CONFLICT (impact_id, change_fact_id) DO NOTHING
          `;
        }
        const factCounts = input.schedulePublication === false
          ? []
          : await transaction<Array<{ count: number }>>`
              SELECT count(*)::int AS count
              FROM focowiki.publication_change_facts
              WHERE generation_id = ${generation.id}
            `;
        const schedule = input.schedulePublication === false
          ? { enqueue: false, runAfter: null }
          : resolveGenerationSchedule({
              settingsSnapshot: input.publicationSettingsSnapshot,
              generationCreatedAt: generation.created_at.toISOString(),
              completedAt: input.committedAt,
              changeCount: factCounts[0]?.count ?? 0
            });
        if (schedule.enqueue) await transaction`
          INSERT INTO focowiki.role_jobs (
            id, role, kind, knowledge_base_id, generation_id,
            payload_json, settings_snapshot_json, run_after, max_attempts,
            created_at, updated_at
          ) VALUES (
            ${`role-job-publication-${generation.id}`}, 'publication',
            'generation_publication', ${input.knowledgeBaseId}, ${generation.id},
            ${transaction.json({ generationId: generation.id })},
            ${transaction.json(input.publicationSettingsSnapshot)},
            ${schedule.runAfter!}, ${input.publicationMaxAttempts},
            ${input.committedAt}, ${input.committedAt}
          )
          ON CONFLICT (generation_id) WHERE role = 'publication' AND generation_id IS NOT NULL
          DO UPDATE SET
            run_after = least(focowiki.role_jobs.run_after, EXCLUDED.run_after),
            settings_snapshot_json = EXCLUDED.settings_snapshot_json,
            max_attempts = EXCLUDED.max_attempts,
            updated_at = EXCLUDED.updated_at
        `;

        return {
          generationId: generation.id,
          changeFactId: input.changeFactId,
          impactCount: input.impacts.length,
          replayed: false
        };
      });
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
        const generation = generations[0];
        if (
          !generation ||
          !["open", "frozen", "building", "validating"].includes(generation.state)
        ) {
          return null;
        }
        const totals = await transaction<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM focowiki.publication_impacts
          WHERE generation_id = ${input.generationId}
            AND status <> 'cancelled'
        `;
        if ((totals[0]?.count ?? 0) === 0) {
          await transaction`
            UPDATE focowiki.publication_generations
            SET state = 'superseded', updated_at = ${input.frozenAt}
            WHERE id = ${input.generationId} AND state = 'open'
          `;
          return null;
        }
        await transaction`
          UPDATE focowiki.publication_generations
          SET state = 'frozen', frozen_at = coalesce(frozen_at, ${input.frozenAt}),
              updated_at = ${input.frozenAt}
          WHERE id = ${input.generationId} AND state = 'open'
        `;
        await transaction`
          INSERT INTO focowiki.publication_progress (
            knowledge_base_id, generation_id, stage,
            processed_impact_count, total_impact_count, touched_shard_count,
            queued_at, started_at, heartbeat_at, updated_at
          ) VALUES (
            ${input.knowledgeBaseId}, ${input.generationId}, 'planning',
            0, ${totals[0]!.count}, 0, ${input.frozenAt}, ${input.frozenAt},
            ${input.frozenAt}, ${input.frozenAt}
          )
          ON CONFLICT (knowledge_base_id, generation_id) DO UPDATE
          SET total_impact_count = EXCLUDED.total_impact_count,
              heartbeat_at = EXCLUDED.heartbeat_at,
              updated_at = EXCLUDED.updated_at
        `;
        return {
          generationId: generation.id,
          predecessorGenerationId: generation.predecessor_generation_id,
          state: generation.state === "open"
            ? "frozen"
            : generation.state as FrozenGeneration["state"],
          totalImpactCount: totals[0]!.count,
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

function emptyProgressSummary() {
  return {
    generationId: null,
    stage: null,
    processedImpactCount: 0,
    totalImpactCount: 0,
    touchedShardCount: 0,
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

async function requireOpenGeneration(
  transaction: TransactionSql<{}>,
  input: { knowledgeBaseId: string; now: string; allowDeletedKnowledgeBase?: boolean }
): Promise<GenerationRow> {
  const existing = await transaction<GenerationRow[]>`
    SELECT id, predecessor_generation_id, state, created_at
    FROM focowiki.publication_generations
    WHERE knowledge_base_id = ${input.knowledgeBaseId} AND state = 'open'
    FOR UPDATE
  `;
  if (existing[0]) {
    return existing[0];
  }
  const active = await transaction<Array<{ active_generation_id: string | null }>>`
    SELECT active_generation_id
    FROM focowiki.knowledge_bases
    WHERE id = ${input.knowledgeBaseId}
      AND (${input.allowDeletedKnowledgeBase ?? false} OR deleted_at IS NULL)
    FOR UPDATE
  `;
  if (!active[0]) {
    throw new Error("Knowledge base is unavailable");
  }
  const id = `generation-${randomUUID()}`;
  const created = await transaction<GenerationRow[]>`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state, created_at, updated_at
    ) VALUES (
      ${id}, ${input.knowledgeBaseId}, ${active[0].active_generation_id}, 'open',
      ${input.now}, ${input.now}
    )
    RETURNING id, predecessor_generation_id, state, created_at
  `;
  return created[0]!;
}
