import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type {
  SourceFileTaskDeletionRepository,
  SourceFileTaskDeletionRepositoryResult
} from "../../application/ports/source-file-task-deletion-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { createChangeFactIdentity } from "../../domain/generation.js";
import { resolveGenerationSchedule } from "../../publication/generation-schedule.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "../../publication/incremental-defaults.js";
import { planPublicationImpacts } from "../../publication/impact-planner.js";
import {
  capturePublicationProjectionInputs,
  persistCapturedProjectionInputs
} from "./publication-projection-input-capture.js";

type SourceRow = {
  id: string;
  knowledge_base_id: string;
  active_revision_id: string;
  relative_path: string;
  resource_revision: number;
  processing_status: string;
  deleted_at: Date | null;
  task_deleted_at: Date | null;
  deletion_intent_id: string | null;
};

type RoleJobRow = {
  source_file_id: string;
  status: string;
};

type GenerationRow = {
  id: string;
  created_at: Date;
};

type GraphEdgeRow = {
  id: string;
  from_source_file_id: string;
  to_source_file_id: string;
};

export function createPostgresSourceFileTaskDeletionRepository(
  sql: DatabaseClient
): SourceFileTaskDeletionRepository {
  return {
    async deleteTasks(input) {
      const sourceFileIds = uniqueStrings(input.sourceFileIds);
      if (sourceFileIds.length === 0) return [];
      if (!Number.isSafeInteger(input.hardDeleteMaxAttempts) || input.hardDeleteMaxAttempts <= 0) {
        throw new Error("hardDeleteMaxAttempts must be a positive integer");
      }

      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
          )
        `;
        const sources = await transaction<SourceRow[]>`
          SELECT id, knowledge_base_id, active_revision_id, relative_path,
                 resource_revision, processing_status,
                 deleted_at, task_deleted_at, deletion_intent_id
          FROM focowiki.source_files
          WHERE id = ANY(${sourceFileIds})
          FOR UPDATE
        `;
        const sourceJobs = await transaction<RoleJobRow[]>`
          SELECT source_file_id, status
          FROM focowiki.role_jobs
          WHERE role = 'source'
            AND source_file_id = ANY(${sourceFileIds})
            AND status IN ('queued', 'running')
          FOR UPDATE
        `;
        const activeRows = await transaction<Array<{
          source_file_id: string;
          file_id: string | null;
          logical_path: string | null;
        }>>`
          SELECT source_file_id, max(file_id) AS file_id, max(logical_path) AS logical_path
          FROM focowiki.active_object_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_id = ANY(${sourceFileIds})
          GROUP BY source_file_id
        `;
        const graphEdges = await transaction<GraphEdgeRow[]>`
          SELECT id, from_source_file_id, to_source_file_id
          FROM focowiki.source_file_graph_edges
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND status = 'accepted'
            AND (
              from_source_file_id = ANY(${sourceFileIds})
              OR to_source_file_id = ANY(${sourceFileIds})
            )
          FOR UPDATE
        `;

        const sourceById = new Map(sources.map((source) => [source.id, source]));
        const jobsBySourceId = groupJobs(sourceJobs);
        const activeBySourceId = new Map(activeRows.map((row) => [row.source_file_id, row]));
        const graphBySourceId = groupGraphEdges(graphEdges);
        const results: SourceFileTaskDeletionRepositoryResult[] = [];

        for (const sourceFileId of sourceFileIds) {
          const source = sourceById.get(sourceFileId);
          if (!source) {
            results.push({ sourceFileId, outcome: "skipped", reason: "missing" });
            continue;
          }
          if (source.knowledge_base_id !== input.knowledgeBaseId) {
            results.push({ sourceFileId, outcome: "skipped", reason: "wrong_knowledge_base" });
            continue;
          }
          if (source.deleted_at || source.task_deleted_at || source.deletion_intent_id) {
            results.push({ sourceFileId, outcome: "skipped", reason: "already_removed" });
            continue;
          }
          if (source.processing_status === "running") {
            results.push({ sourceFileId, outcome: "skipped", reason: "running" });
            continue;
          }
          if ((jobsBySourceId.get(sourceFileId) ?? []).some((status) => status === "running")) {
            results.push({ sourceFileId, outcome: "skipped", reason: "job_already_claimed" });
            continue;
          }

          const active = activeBySourceId.get(sourceFileId);
          if (active) {
            await hideTask(transaction, input, sourceFileId);
            results.push({
              sourceFileId,
              outcome: "hidden",
              generatedFileId: active.file_id,
              generatedFilePath: active.logical_path
            });
            continue;
          }

          const deletionIntentId = `deletion-${randomUUID()}`;
          const catalogGeneration = await nextCatalogGeneration(
            transaction,
            input.knowledgeBaseId,
            input.deletedAt
          );
          await transaction`
            INSERT INTO focowiki.deletion_intents (
              id, knowledge_base_id, target_kind, target_id, catalog_generation,
              state, created_at, updated_at
            ) VALUES (
              ${deletionIntentId}, ${input.knowledgeBaseId}, 'source_file', ${sourceFileId},
              ${catalogGeneration}, 'accepted', ${input.deletedAt}, ${input.deletedAt}
            )
          `;
          await transaction`
            UPDATE focowiki.source_files
            SET deleted_at = ${input.deletedAt}, deletion_intent_id = ${deletionIntentId},
                generated_output_status = 'unavailable',
                terminal_failure_stage = NULL, terminal_failure_code = NULL,
                terminal_failure_message = NULL, terminal_failure_at = NULL,
                terminal_failure_retry_kind = NULL,
                terminal_failure_correlation_id = NULL,
                graph_relationship_count = 0, graph_top_relationships_json = '[]'::jsonb
            WHERE id = ${sourceFileId} AND knowledge_base_id = ${input.knowledgeBaseId}
          `;
          await transaction`
            UPDATE focowiki.source_revisions
            SET processing_status = 'superseded'
            WHERE id = ${source.active_revision_id}
              AND processing_status IN ('queued', 'failed')
          `;
          await transaction`
            UPDATE focowiki.source_dispatch_markers
            SET status = 'cancelled', claimed_by = NULL, claimed_at = NULL,
                last_error_code = 'SOURCE_FILE_TASK_DELETED', updated_at = ${input.deletedAt}
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND source_file_id = ${sourceFileId}
              AND status IN ('pending', 'claimed')
          `;
          await transaction`
            UPDATE focowiki.role_jobs
            SET status = 'cancelled', completed_at = ${input.deletedAt},
                last_error_code = 'SOURCE_FILE_TASK_DELETED',
                last_error_message = 'Source file task was deleted before processing.',
                updated_at = ${input.deletedAt}
            WHERE role = 'source'
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND source_file_id = ${sourceFileId}
              AND status = 'queued'
          `;

          const graph = graphBySourceId.get(sourceFileId) ?? { edgeIds: [], neighborIds: [] };
          await commitDeletionProjection(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            source,
            deletionIntentId,
            graphEdgeIds: graph.edgeIds,
            graphNeighborIds: graph.neighborIds,
            deletedAt: input.deletedAt,
            hardDeleteMaxAttempts: input.hardDeleteMaxAttempts,
            publicationSettingsSnapshot: input.publicationSettingsSnapshot
          });
          await transaction`
            INSERT INTO focowiki.role_jobs (
              id, role, kind, knowledge_base_id, source_file_id,
              payload_json, settings_snapshot_json, status, run_after,
              max_attempts, created_at, updated_at
            ) VALUES (
              ${`role-job-hard-delete-${deletionIntentId}`}, 'maintenance', 'hard_delete',
              ${input.knowledgeBaseId}, ${sourceFileId},
              ${transaction.json({
                targetKind: "source_file",
                sourceFileId,
                deletionIntentId,
                reason: "source_file_task_deleted"
              })}, ${transaction.json(input.publicationSettingsSnapshot)}, 'queued',
              ${input.deletedAt}, ${input.hardDeleteMaxAttempts},
              ${input.deletedAt}, ${input.deletedAt}
            )
          `;
          await recordTaskDeletionEvent(transaction, input, sourceFileId);
          results.push({ sourceFileId, outcome: "deleted" });
        }

        return results;
      });
    }
  };
}

async function hideTask(
  transaction: TransactionSql,
  input: Parameters<SourceFileTaskDeletionRepository["deleteTasks"]>[0],
  sourceFileId: string
): Promise<void> {
  await transaction`
    UPDATE focowiki.source_files
    SET task_deleted_at = ${input.deletedAt}
    WHERE id = ${sourceFileId} AND knowledge_base_id = ${input.knowledgeBaseId}
  `;
  await recordTaskDeletionEvent(transaction, input, sourceFileId);
}

async function recordTaskDeletionEvent(
  transaction: TransactionSql,
  input: Parameters<SourceFileTaskDeletionRepository["deleteTasks"]>[0],
  sourceFileId: string
): Promise<void> {
  await transaction`
    INSERT INTO focowiki.source_file_events (
      id, knowledge_base_id, source_file_id, stage_key, message_key,
      started_at, ended_at, severity
    ) VALUES (
      ${`source-event-${randomUUID()}`}, ${input.knowledgeBaseId}, ${sourceFileId},
      'source_deletion', 'sourceFiles.stage.taskDeletion',
      ${input.deletedAt}, ${input.deletedAt}, 'info'
    )
  `;
}

async function nextCatalogGeneration(
  transaction: TransactionSql,
  knowledgeBaseId: string,
  updatedAt: string
): Promise<number> {
  const rows = await transaction<Array<{ catalog_generation: number | string }>>`
    UPDATE focowiki.knowledge_bases
    SET catalog_generation = catalog_generation + 1, updated_at = ${updatedAt}
    WHERE id = ${knowledgeBaseId} AND deleted_at IS NULL
    RETURNING catalog_generation
  `;
  const generation = Number(rows[0]?.catalog_generation);
  if (!Number.isSafeInteger(generation)) throw new Error("Knowledge base is unavailable");
  return generation;
}

async function commitDeletionProjection(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    source: SourceRow;
    deletionIntentId: string;
    graphEdgeIds: string[];
    graphNeighborIds: string[];
    deletedAt: string;
    hardDeleteMaxAttempts: number;
    publicationSettingsSnapshot: Parameters<SourceFileTaskDeletionRepository["deleteTasks"]>[0]["publicationSettingsSnapshot"];
  }
): Promise<void> {
  const generation = await requireOpenGeneration(transaction, input.knowledgeBaseId, input.deletedAt);
  const changeFactId = createChangeFactIdentity({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceRevisionId: input.source.active_revision_id,
    kind: "source_deleted",
    previousPath: input.source.relative_path,
    path: null,
    mutationIdentity: input.deletionIntentId
  });
  await transaction`
    INSERT INTO focowiki.publication_change_facts (
      id, knowledge_base_id, source_file_id, source_revision_id,
      deletion_intent_id, kind, previous_path, path, resource_revision,
      generation_id, created_at
    ) VALUES (
      ${changeFactId}, ${input.knowledgeBaseId}, ${input.source.id},
      ${input.source.active_revision_id}, ${input.deletionIntentId}, 'source_deleted',
      ${input.source.relative_path}, NULL, ${input.source.resource_revision},
      ${generation.id}, ${input.deletedAt}
    )
  `;
  const impacts = planPublicationImpacts({
    changeFactId,
    kind: "source_deleted",
    sourceFileId: input.source.id,
    previousPath: input.source.relative_path,
    path: null,
    graphNeighborSourceFileIds: input.graphNeighborIds,
    removedGraphEdgeIds: input.graphEdgeIds,
    config: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner
  });
  const capturedInputs = await capturePublicationProjectionInputs(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: generation.id,
    changeKind: "source_deleted",
    sourceFileId: input.source.id,
    sourceRevisionId: input.source.active_revision_id,
    previousPath: input.source.relative_path,
    path: null,
    impacts,
    now: input.deletedAt
  });
  await persistCapturedProjectionInputs(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: generation.id,
    captured: capturedInputs,
    now: input.deletedAt
  });
  for (const impact of impacts) {
    const rows = await transaction<Array<{ id: string }>>`
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind, projection_key,
        record_identity, action, projection_input_key, run_after, created_at, updated_at
      ) VALUES (
        ${impact.id}, ${input.knowledgeBaseId}, ${generation.id},
        ${impact.projectionKind}, ${impact.projectionKey}, ${impact.recordIdentity},
        ${impact.action}, ${capturedInputs.get(impact.id)?.inputKey ?? null},
        ${input.deletedAt}, ${input.deletedAt}, ${input.deletedAt}
      )
      ON CONFLICT (generation_id, projection_kind, projection_key, record_identity)
      DO UPDATE SET action = EXCLUDED.action,
        projection_input_key = EXCLUDED.projection_input_key,
        run_after = least(focowiki.publication_impacts.run_after, EXCLUDED.run_after),
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `;
    await transaction`
      INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id, created_at)
      VALUES (${rows[0]!.id}, ${changeFactId}, ${input.deletedAt})
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
    completedAt: input.deletedAt,
    changeCount: factCounts[0]?.count ?? 0
  });
  if (!schedule.enqueue) return;
  await transaction`
    INSERT INTO focowiki.role_jobs (
      id, role, kind, knowledge_base_id, generation_id,
      payload_json, settings_snapshot_json, status, run_after,
      max_attempts, created_at, updated_at
    ) VALUES (
      ${`role-job-publication-${generation.id}`}, 'publication', 'generation_publication',
      ${input.knowledgeBaseId}, ${generation.id},
      ${transaction.json({ generationId: generation.id })},
      ${transaction.json(input.publicationSettingsSnapshot)}, 'queued', ${schedule.runAfter!},
      ${input.hardDeleteMaxAttempts}, ${input.deletedAt}, ${input.deletedAt}
    )
    ON CONFLICT (generation_id) WHERE role = 'publication' AND generation_id IS NOT NULL
    DO UPDATE SET run_after = least(focowiki.role_jobs.run_after, EXCLUDED.run_after),
                  settings_snapshot_json = EXCLUDED.settings_snapshot_json,
                  max_attempts = EXCLUDED.max_attempts,
                  updated_at = EXCLUDED.updated_at
  `;
}

async function requireOpenGeneration(
  transaction: TransactionSql,
  knowledgeBaseId: string,
  createdAt: string
): Promise<GenerationRow> {
  const existing = await transaction<GenerationRow[]>`
    SELECT id, created_at
    FROM focowiki.publication_generations
    WHERE knowledge_base_id = ${knowledgeBaseId} AND state = 'open'
    FOR UPDATE
  `;
  if (existing[0]) return existing[0];
  const knowledgeBases = await transaction<Array<{ active_generation_id: string | null }>>`
    SELECT active_generation_id
    FROM focowiki.knowledge_bases
    WHERE id = ${knowledgeBaseId} AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!knowledgeBases[0]) throw new Error("Knowledge base is unavailable");
  const rows = await transaction<GenerationRow[]>`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state, created_at, updated_at
    ) VALUES (
      ${`generation-${randomUUID()}`}, ${knowledgeBaseId},
      ${knowledgeBases[0].active_generation_id}, 'open', ${createdAt}, ${createdAt}
    )
    RETURNING id, created_at
  `;
  return rows[0]!;
}

function groupJobs(rows: RoleJobRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    grouped.set(row.source_file_id, [...(grouped.get(row.source_file_id) ?? []), row.status]);
  }
  return grouped;
}

function groupGraphEdges(
  rows: GraphEdgeRow[]
): Map<string, { edgeIds: string[]; neighborIds: string[] }> {
  const grouped = new Map<string, { edgeIds: string[]; neighborIds: string[] }>();
  for (const row of rows) {
    for (const [sourceFileId, neighborId] of [
      [row.from_source_file_id, row.to_source_file_id],
      [row.to_source_file_id, row.from_source_file_id]
    ] as const) {
      const current = grouped.get(sourceFileId) ?? { edgeIds: [], neighborIds: [] };
      current.edgeIds.push(row.id);
      current.neighborIds.push(neighborId);
      grouped.set(sourceFileId, current);
    }
  }
  for (const value of grouped.values()) {
    value.edgeIds = uniqueStrings(value.edgeIds);
    value.neighborIds = uniqueStrings(value.neighborIds);
  }
  return grouped;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
